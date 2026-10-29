// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The camera-tour editor, a page of its own (/tours/new, /tours/:id/edit;
 * opened from Settings › Camera Tours or from a running wall's Edit button,
 * where ?return= brings it back on save).
 *
 * Pages on the left, dragged into order; the selected page on the right:
 * its layout, how long it shows, a preview of it built from camera stills
 * (tiles dragged into order, sorted, counted by location) and a picker that
 * shows each camera's picture. A page holds what its layout holds: cameras
 * added past that, or left over when the layout is made smaller, go onto
 * new pages right after it, and the editor says so. Below the pages, the
 * tour's own settings: Fit or Fill, and the alarm takeover.
 */

import { useEffect, useMemo, useState } from 'react'
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownAZ, ArrowLeft, BellRing, ChevronDown, ChevronRight, CopyPlus, GripVertical, MapPin, PanelLeftClose, PanelLeftOpen, Play, Plus, Route, Rows3, Search, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../i18n'
import { apiService } from '../lib/apiService'
import { rebaseToCurrentOrigin } from '../lib/streamUrl'
import { Modal } from '../components/Modal'
import { VideoPlayer } from '../components/VideoPlayer'
import { useCameras, type CameraItem } from '../lib/queries'
import { PLAIN_GRIDS, PREDEFINED_LAYOUTS, parseGridId, resolveLayout, type LayoutDefinition, type WindowLayoutSettings } from '../lib/liveLayouts'
import { AUTO_GRID_MAX, buildPages, camerasOf, cycleSeconds, formatDuration, type Slot } from '../lib/tourPlan'
import { DEFAULT_TOUR_SETTINGS, type AlertSeverity, type AlertSource, type Tour, type TourInput, type TourSettings } from '../services/tourService'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useSnackbar } from '../components/Snackbar'
import { Button, ErrorCard, Skeleton } from '../components/ui'
import { Field, Input, Select } from '../components/ui/form'
import { Switch } from '../components/ui/Switch'
import { CameraThumb } from '../components/live/CameraThumb'
import { IconAction } from '../components/live/IconAction'
import { addCamera, chunk, closeGaps, fill, firstEmpty, fit, moveTo, placeAt, placeMessage, removeAt, tidy } from '../lib/tourArrange'

export const TOURS_LIST_PATH = '/settings/more-settings/camera-tours'

const DURATION_PRESETS = [30, 60, 120, 300]
const MIN_DURATION = 10
const MAX_DURATION = 3600

/** camera_ids in tile order; null is a tile left empty. */
type DraftPage = { uid: string; label: string; layout_id: string; duration_s: number; camera_ids: Slot[] }
// `description` has no field in the editor; it rides along so a save keeps it.
type Draft = {
  id: number | null
  revision?: number
  name: string
  description?: string | null
  enabled: boolean
  settings: TourSettings
  pages: DraftPage[]
}

let uidSeq = 0
const uid = () => `p${++uidSeq}`
const newPage = (layout_id = 'grid:5x4'): DraftPage => ({ uid: uid(), label: '', layout_id, duration_s: 60, camera_ids: [] })
const blankDraft = (): Draft => ({ id: null, name: '', enabled: true, settings: DEFAULT_TOUR_SETTINGS, pages: [newPage()] })

function toInput(d: Draft): TourInput {
  return {
    name: d.name.trim(),
    description: d.description ?? null,
    enabled: d.enabled,
    settings: d.settings,
    pages: d.pages.map((s) => ({ label: s.label.trim(), layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: tidy(s.camera_ids) })),
    ...(d.id != null && d.revision != null ? { expected_revision: d.revision } : {}),
  }
}

function fromTour(tour: Tour, copy = false): Draft {
  return {
    id: copy ? null : tour.id,
    revision: copy ? undefined : tour.revision,
    name: copy ? `${tour.name} (copy)` : tour.name,
    description: tour.description,
    enabled: tour.enabled,
    settings: { ...DEFAULT_TOUR_SETTINGS, ...tour.settings, alerts: { ...DEFAULT_TOUR_SETTINGS.alerts, ...tour.settings?.alerts } },
    pages: tour.pages.map((s) => ({ uid: uid(), label: s.label, layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: [...s.camera_ids] })),
  }
}

export function TourEditor() {
  const { t } = useTranslation()
  const { tourId } = useParams()
  const [params] = useSearchParams()
  const editingId = tourId ? Number(tourId) : null
  const copyFrom = !editingId && params.get('from') ? Number(params.get('from')) : null
  const sourceId = editingId ?? copyFrom
  const back = params.get('return') || TOURS_LIST_PATH

  const source = useQuery({
    queryKey: ['tour', sourceId],
    enabled: sourceId != null && Number.isInteger(sourceId),
    queryFn: async () => (await apiService.getTour(sourceId!)).data as Tour,
    staleTime: 0,
  })
  const windowSettings = useQuery({
    queryKey: ['window-settings'],
    queryFn: async () => (await apiService.getWindowSettings()).data as WindowLayoutSettings,
    staleTime: 5 * 60_000,
  })
  const cams = useCameras({ active_only: false })

  if (sourceId != null && source.isPending) return <div className="p-4"><Skeleton className="h-96 w-full" /></div>
  if (sourceId != null && source.isError) {
    return <ErrorCard message={(source.error as any)?.message || t('tours.loadFailed')} onRetry={() => source.refetch()} />
  }
  const initial = source.data ? fromTour(source.data, copyFrom != null) : blankDraft()
  return (
    <EditorBody
      key={`${sourceId ?? 'new'}:${source.data?.revision ?? 0}`}
      initial={initial}
      readOnly={!!source.data && editingId != null && !source.data.editable}
      cameras={cams.data?.cameras ?? []}
      windowSettings={windowSettings.data}
      back={back}
      onReload={() => source.refetch()}
    />
  )
}

/** A yes/no editor preference kept in this browser (panel folded or not). */
function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v == null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  const set = (v: boolean) => {
    setValue(v)
    try { localStorage.setItem(key, v ? '1' : '0') } catch { /* private mode */ }
  }
  return [value, set]
}

function EditorBody({ initial, readOnly, cameras, windowSettings, back, onReload }: {
  initial: Draft
  readOnly: boolean
  cameras: CameraItem[]
  windowSettings: WindowLayoutSettings | undefined
  back: string
  onReload: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { showSuccess } = useSnackbar()
  const [draft, setDraft] = useState<Draft>(initial)
  const [selected, setSelected] = useState(initial.pages[0]?.uid)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<{ text: string; conflict?: boolean } | null>(null)
  const [badCameras, setBadCameras] = useState<Set<number>>(new Set())
  const [badLayouts, setBadLayouts] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)

  const camById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras])
  const [rail, setRail] = usePref('opennvr.tourEditor.rail', false)
  const [pagesOpen, setPagesOpen] = usePref('opennvr.tourEditor.pages', true)
  const [settingsOpen, setSettingsOpen] = usePref('opennvr.tourEditor.settings', true)
  const dirty = JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(initial))
  const resolve = (lid: string) => resolveLayout(lid, windowSettings)
  const shown = buildPages(draft.pages, resolve)
  const page = draft.pages.find((s) => s.uid === selected) ?? draft.pages[0]
  const emptyPages = draft.pages.filter((s) => camerasOf(s.camera_ids).length === 0).length
  const canSave = !readOnly && !!draft.name.trim() && draft.pages.length > 0 && emptyPages === 0 && !saving
  const nameError = touched && !draft.name.trim()

  // Leaving with unsaved changes asks first: in-app links, and the tab itself.
  const blocker = useBlocker(dirty && !saved && !saving)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    confirm({ title: t('tours.discardTitle'), message: t('tours.discardMessage'), confirmLabel: t('tours.discard'), danger: true })
      .then((ok) => (ok ? blocker.proceed() : blocker.reset()))
  }, [blocker, confirm, t])
  useEffect(() => {
    if (!dirty || saved) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, saved])

  const setPage = (key: string, patch: Partial<DraftPage>) =>
    setDraft((d) => ({ ...d, pages: d.pages.map((s) => (s.uid === key ? { ...s, ...patch } : s)) }))
  const setSettings = (patch: Partial<TourSettings>) => setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }))
  const setAlerts = (patch: Partial<TourSettings['alerts']>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, alerts: { ...d.settings.alerts, ...patch } } }))

  const addPage = () => {
    const s = newPage(draft.pages[draft.pages.length - 1]?.layout_id)
    setDraft((d) => ({ ...d, pages: [...d.pages, s] }))
    setSelected(s.uid)
  }
  const duplicatePage = (key: string) => {
    const i = draft.pages.findIndex((s) => s.uid === key)
    if (i < 0) return
    const copy = { ...draft.pages[i], uid: uid(), camera_ids: [...draft.pages[i].camera_ids] }
    setDraft((d) => { const pages = [...d.pages]; pages.splice(i + 1, 0, copy); return { ...d, pages } })
    setSelected(copy.uid)
  }
  const removePage = (key: string) => {
    const i = draft.pages.findIndex((s) => s.uid === key)
    setDraft((d) => ({ ...d, pages: d.pages.filter((s) => s.uid !== key) }))
    const next = draft.pages[i + 1] ?? draft.pages[i - 1]
    if (next) setSelected(next.uid)
  }
  // Cameras that did not fit on page `key` go onto new pages right after it,
  // with its label, layout and time. The page being edited stays selected.
  const spill = (key: string, cams: number[], tiles: number) => {
    if (!cams.length) return
    setDraft((d) => {
      const i = d.pages.findIndex((s) => s.uid === key)
      if (i < 0) return d
      const from = d.pages[i]
      const added = chunk(cams, tiles).map((ids) => ({ ...from, uid: uid(), camera_ids: ids }))
      const pages = [...d.pages]
      pages.splice(i + 1, 0, ...added)
      return { ...d, pages }
    })
  }

  const save = async () => {
    setTouched(true)
    if (!canSave) return
    setSaving(true)
    setError(null)
    setBadCameras(new Set())
    setBadLayouts(new Set())
    try {
      if (draft.id == null) await apiService.createTour(toInput(draft))
      else await apiService.updateTour(draft.id, toInput(draft))
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['tours'] })
      qc.invalidateQueries({ queryKey: ['tour'] })
      showSuccess(t('tours.saved', { name: draft.name.trim() }))
      navigate(back)
    } catch (e: any) {
      const detail = e?.data?.detail
      if (e?.status === 409) setError({ text: t('tours.conflict'), conflict: true })
      else if (e?.status === 422 && Array.isArray(detail?.camera_ids)) {
        setBadCameras(new Set(detail.camera_ids))
        setError({ text: t('tours.badCameras', { names: detail.camera_ids.map((id: number) => camById.get(id)?.name ?? `#${id}`).join(', ') }) })
      } else if (e?.status === 422 && Array.isArray(detail?.layout_ids)) {
        setBadLayouts(new Set(detail.layout_ids))
        setError({ text: t('tours.badLayouts') })
      } else setError({ text: typeof detail === 'string' ? detail : e?.message || t('tours.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onPageDrag = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    setDraft((d) => {
      const from = d.pages.findIndex((s) => s.uid === active.id)
      const to = d.pages.findIndex((s) => s.uid === over.id)
      return from < 0 || to < 0 ? d : { ...d, pages: arrayMove(d.pages, from, to) }
    })
  }

  return (
    <div className="space-y-2" data-testid="tour-editor">
      {/* One sticky toolbar: back, the tour's name (it is the title), on/off,
          the cycle summary and the two actions, always in reach. */}
      <h1 className="sr-only">{draft.id == null ? t('tours.newTitle') : t('tours.editTitle', { name: initial.name })}</h1>
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 py-2 border-b border-[var(--border)] bg-[var(--bg)]" data-testid="tour-toolbar">
        <IconAction label={t('tours.backToList')} onClick={() => navigate(back)}><ArrowLeft size={16} /></IconAction>
        <Route size={16} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <div className="min-w-[12rem] flex-1">
          <Input id="tour-name" value={draft.name} maxLength={100} autoFocus={draft.id == null}
            placeholder={t('tours.namePlaceholder')} aria-label={t('tours.name')} title={t('tours.name')}
            aria-invalid={nameError || undefined}
            className={clsx('font-semibold', nameError && '!border-[var(--danger)]')}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onBlur={() => setTouched(true)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label={t('tours.enabled')} />
          {t('tours.enabled')}
        </label>
        <span className="hidden lg:inline text-xs text-[var(--text-dim)] font-mono tabular-nums" data-testid="tour-cycle">
          {t('tours.cycleSummary', { pages: draft.pages.length, cycle: formatDuration(cycleSeconds(shown)) })}
        </span>
        <Button variant="ghost" onClick={() => navigate(back)}>{t('tours.cancel')}</Button>
        <Button variant="primary" onClick={save} disabled={saving || readOnly || (touched && !canSave)}>
          {saving ? t('tours.saving') : t('tours.save')}
        </Button>
      </div>
      {nameError && <p className="-mt-2 text-xs text-[var(--danger)]">{t('tours.nameRequired')}</p>}

      {readOnly && <div className="text-sm text-[var(--text-dim)] border border-[var(--border)] p-2">{t('tours.readOnly')}</div>}
      {error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] border border-[color-mix(in_oklab,var(--danger)_45%,var(--border))] p-2">
          <span className="flex-1">{error.text}</span>
          {error.conflict && <Button size="sm" variant="outline" onClick={onReload}>{t('tours.reload')}</Button>}
        </div>
      )}

      {/* Two columns from xl up (pages + settings | the selected page); below
          that one column in reading order: pages, the page, then settings.
          From xl the left column can fold to a rail of page numbers. The page
          panel spans both left rows; the first row stays as tall as the page
          list and the second takes the rest, so settings sit right under it. */}
      <div className={clsx('grid gap-4 xl:grid-rows-[auto_1fr] items-start',
        rail ? 'xl:grid-cols-[3rem_minmax(0,1fr)]' : 'xl:grid-cols-[20rem_minmax(0,1fr)]')}>
        {rail && (
          <nav className="hidden xl:flex xl:col-start-1 xl:row-start-1 xl:row-span-2 flex-col items-center gap-1 py-2 border border-[var(--border)] bg-[var(--panel-2)]" aria-label={t('tours.pages')} data-testid="tour-pages-rail">
            <IconAction label={t('tours.showPanel')} onClick={() => setRail(false)}><PanelLeftOpen size={15} /></IconAction>
            <span className="w-6 h-px bg-[var(--border)] my-1" aria-hidden="true" />
            {draft.pages.map((s, i) => (
              <button key={s.uid} type="button" onClick={() => setSelected(s.uid)}
                title={s.label || t('tours.pageN', { n: i + 1 })} aria-label={s.label || t('tours.pageN', { n: i + 1 })} aria-current={s.uid === page?.uid || undefined}
                className={clsx('w-8 h-8 text-xs font-mono border',
                  s.uid === page?.uid ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]',
                  touched && camerasOf(s.camera_ids).length === 0 && 'border-[var(--danger)]')}>
                {i + 1}
              </button>
            ))}
            <IconAction label={t('tours.addPage')} onClick={addPage}><Plus size={14} /></IconAction>
          </nav>
        )}

        <section className={clsx('border border-[var(--border)] bg-[var(--panel-2)] xl:col-start-1 xl:row-start-1', rail && 'xl:hidden')} data-testid="tour-pages">
          <header className="flex items-center gap-2 pl-1 pr-1 py-1 border-b border-[var(--border)] text-sm font-medium">
            <button type="button" onClick={() => setPagesOpen(!pagesOpen)} aria-expanded={pagesOpen}
              className="flex flex-1 min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-left hover:bg-[var(--panel)]">
              {pagesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t('tours.pages')}
              <span className="text-xs font-normal text-[var(--text-dim)] truncate">
                {pagesOpen ? t('tours.dragToReorder') : t('tours.pagesCount', { count: draft.pages.length })}
              </span>
            </button>
            <span className="hidden xl:inline-flex">
              <IconAction label={t('tours.hidePanel')} onClick={() => setRail(true)}><PanelLeftClose size={15} /></IconAction>
            </span>
          </header>
          {pagesOpen && (
            <>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onPageDrag}>
                <SortableContext items={draft.pages.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
                  <ol className="divide-y divide-[var(--border)]">
                    {draft.pages.map((s, i) => (
                      <PageRow
                        key={s.uid}
                        page={s}
                        index={i}
                        selected={s.uid === page?.uid}
                        layout={resolve(s.layout_id)}
                        invalid={touched && camerasOf(s.camera_ids).length === 0}
                        onSelect={() => setSelected(s.uid)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              <div className="p-2 border-t border-[var(--border)]">
                <Button variant="outline" size="sm" onClick={addPage}><Plus size={14} /> {t('tours.addPage')}</Button>
              </div>
            </>
          )}
        </section>

        {/* The selected page */}
        {page && (
          <div className="min-w-0 xl:col-start-2 xl:row-start-1 xl:row-span-2">
            <PageDetail
              key={page.uid}
              page={page}
              index={draft.pages.indexOf(page)}
              count={draft.pages.length}
              windowSettings={windowSettings}
              cameras={cameras}
              camById={camById}
              badCameras={badCameras}
              badLayout={badLayouts.has(page.layout_id)}
              showErrors={touched}
              cover={draft.settings.fit === 'fill'}
              onChange={(patch) => setPage(page.uid, patch)}
              onSpill={(cams, tiles) => spill(page.uid, cams, tiles)}
              onDuplicate={() => duplicatePage(page.uid)}
              onRemove={() => removePage(page.uid)}
            />
          </div>
        )}

        <div className={clsx('xl:col-start-1 xl:row-start-2', rail && 'xl:hidden')}>
          <TourSettingsPanel settings={draft.settings} open={settingsOpen} onToggle={() => setSettingsOpen(!settingsOpen)}
            onSettings={setSettings} onAlerts={setAlerts} />
        </div>
      </div>
    </div>
  )
}

function PageRow({ page, index, selected, layout, invalid, onSelect }: {
  page: DraftPage
  index: number
  selected: boolean
  layout: LayoutDefinition | null
  invalid: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.uid })
  const count = camerasOf(page.camera_ids).length
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('flex items-center gap-2 px-2 py-2 bg-[var(--panel-2)]', selected && 'bg-[color-mix(in_oklab,var(--accent)_12%,var(--panel-2))]', isDragging && 'relative z-10 shadow-lg')}
      data-testid="tour-page-row"
    >
      <button type="button" className="p-1 text-[var(--text-dim)] cursor-grab active:cursor-grabbing" aria-label={t('tours.dragPage', { n: index + 1 })} {...attributes} {...listeners}>
        <GripVertical size={14} />
      </button>
      <button type="button" onClick={onSelect} className="flex-1 min-w-0 flex items-center gap-2 text-left" aria-current={selected || undefined}>
        <span className="text-xs font-mono text-[var(--text-dim)] w-4 text-right">{index + 1}</span>
        {layout && <LayoutPreview layout={layout} small />}
        <span className="min-w-0 flex-1">
          <span className={clsx('block text-sm truncate', selected && 'font-semibold')}>{page.label || t('tours.pageN', { n: index + 1 })}</span>
          <span className={clsx('block text-[11px] font-mono tabular-nums', invalid ? 'text-[var(--danger)]' : 'text-[var(--text-dim)]')}>
            {count === 0
              ? t('tours.noCamerasYet')
              : `${t('tours.tilesUsed', { count, tiles: layout?.tiles.length ?? count })} · ${formatDuration(page.duration_s)}`}
          </span>
        </span>
      </button>
    </li>
  )
}

function TourSettingsPanel({ settings, open, onToggle, onSettings, onAlerts }: {
  settings: TourSettings
  open: boolean
  onToggle: () => void
  onSettings: (patch: Partial<TourSettings>) => void
  onAlerts: (patch: Partial<TourSettings['alerts']>) => void
}) {
  const { t } = useTranslation()
  const a = settings.alerts
  const toggleSource = (s: AlertSource) => {
    const has = a.sources.includes(s)
    const next = has ? a.sources.filter((x) => x !== s) : [...a.sources, s]
    if (next.length) onAlerts({ sources: next })
  }
  return (
    <section className="border border-[var(--border)] bg-[var(--panel-2)]">
      <header className={clsx('pl-1 pr-1 py-1 text-sm font-medium', open && 'border-b border-[var(--border)]')}>
        <button type="button" onClick={onToggle} aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left hover:bg-[var(--panel)]">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t('tours.settings')}
          {!open && (
            <span className="text-xs font-normal text-[var(--text-dim)] truncate">
              {settings.fit === 'fill' ? t('tours.fitFill') : t('tours.fitFit')}{settings.alerts.enabled ? ` · ${t('tours.alertsOnChip')}` : ''}
            </span>
          )}
        </button>
      </header>
      {open && <div className="p-3 space-y-4">
        <Field label={t('tours.fitLabel')} hint={t('tours.fitHint')}>
          <Select value={settings.fit} onChange={(e) => onSettings({ fit: e.target.value as TourSettings['fit'] })}>
            <option value="fit">{t('tours.fitFit')}</option>
            <option value="fill">{t('tours.fitFill')}</option>
          </Select>
        </Field>

        <Field label={t('tours.transitionLabel')}>
          <Select value={settings.transition} onChange={(e) => onSettings({ transition: e.target.value as TourSettings['transition'] })}>
            <option value="fade">{t('tours.transitionFade')}</option>
            <option value="cut">{t('tours.transitionCut')}</option>
          </Select>
        </Field>
        <label className="flex items-start gap-2">
          <Switch checked={settings.preload} onChange={(v) => onSettings({ preload: v })} label={t('tours.preload')} />
          <span>
            <span className="block text-sm font-medium">{t('tours.preload')}</span>
            <span className="block text-xs text-[var(--text-dim)]">{t('tours.preloadHint')}</span>
          </span>
        </label>

        <div className="space-y-3">
          <label className="flex items-start gap-2">
            <Switch checked={a.enabled} onChange={(v) => onAlerts({ enabled: v })} label={t('tours.alertsEnable')} />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium"><BellRing size={13} className="text-[var(--danger)]" /> {t('tours.alertsEnable')}</span>
              <span className="block text-xs text-[var(--text-dim)]">{t('tours.alertsHint')}</span>
            </span>
          </label>
          {a.enabled && (
            <div className="space-y-3 pl-1">
              <fieldset className="space-y-1">
                <legend className="text-xs font-medium mb-1">{t('tours.alertSources')}</legend>
                {(['app_alert', 'camera_event'] as AlertSource[]).map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={a.sources.includes(s)} onChange={() => toggleSource(s)}
                      disabled={a.sources.length === 1 && a.sources.includes(s)} />
                    {t(`tours.alertSource.${s}`)}
                  </label>
                ))}
              </fieldset>
              {a.sources.includes('app_alert') && (
                <Field label={t('tours.alertMinSeverity')}>
                  <Select value={a.min_severity} onChange={(e) => onAlerts({ min_severity: e.target.value as AlertSeverity })}>
                    {(['low', 'medium', 'high', 'critical'] as AlertSeverity[]).map((s) => (
                      <option key={s} value={s}>{t(`tours.severity.${s}`)}</option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label={t('tours.alertScope')}>
                <Select value={a.scope} onChange={(e) => onAlerts({ scope: e.target.value as 'tour' | 'visible' })}>
                  <option value="tour">{t('tours.alertScopeTour')}</option>
                  <option value="visible">{t('tours.alertScopeVisible')}</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2 items-start">
                <Field label={t('tours.alertHold')} hint={t('tours.seconds')}>
                  <Input type="number" min={5} max={600} value={a.hold_s}
                    onChange={(e) => onAlerts({ hold_s: Math.min(600, Math.max(5, Number(e.target.value) || 5)) })} />
                </Field>
                <Field label={t('tours.alertCooldown')} hint={t('tours.seconds')}>
                  <Input type="number" min={0} max={3600} value={a.cooldown_s}
                    onChange={(e) => onAlerts({ cooldown_s: Math.min(3600, Math.max(0, Number(e.target.value) || 0)) })} />
                </Field>
              </div>
            </div>
          )}
        </div>
      </div>}
    </section>
  )
}

type LayoutOption = { id: string; label: string; tiles: number }

function layoutOptions(ws: WindowLayoutSettings | undefined): { builtIn: LayoutOption[]; grids: LayoutOption[]; custom: LayoutOption[] } {
  const builtIn = Object.entries(PREDEFINED_LAYOUTS)
    .filter(([id]) => ws?.layouts_enabled?.[id] !== false)
    .map(([id, l]) => ({ id, label: l.name, tiles: l.tiles.length }))
  const grids = PLAIN_GRIDS.map(([c, r]) => ({ id: `grid:${c}x${r}`, label: `${c}×${r}`, tiles: c * r }))
  const custom = (ws?.custom_layouts ?? [])
    .filter((l) => l.enabled !== false)
    .map((l) => ({ id: l.id, label: l.name, tiles: resolveLayout(l.id, ws)?.tiles.length ?? 0 }))
  return { builtIn, grids, custom }
}

function PageDetail({ page, index, count, windowSettings, cameras, camById, badCameras, badLayout, showErrors, cover, onChange, onSpill, onDuplicate, onRemove }: {
  page: DraftPage
  index: number
  count: number
  windowSettings: WindowLayoutSettings | undefined
  cameras: CameraItem[]
  camById: Map<number, CameraItem>
  badCameras: Set<number>
  badLayout: boolean
  showErrors: boolean
  cover: boolean
  onChange: (patch: Partial<DraftPage>) => void
  /** Cameras that did not fit: onto new pages of `tiles` right after this one. */
  onSpill: (cams: number[], tiles: number) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const options = useMemo(() => layoutOptions(windowSettings), [windowSettings])
  // Any grid:CxR is valid, offered or not (a tour made through the API may use 2×2).
  const plain = parseGridId(page.layout_id)
  const extraGrid = plain && !options.grids.some((o) => o.id === page.layout_id)
    ? { id: page.layout_id, label: `${plain[0]}×${plain[1]}`, tiles: plain[0] * plain[1] }
    : null
  const known = !!plain || [...options.builtIn, ...options.custom].some((o) => o.id === page.layout_id)
  const custom = !DURATION_PRESETS.includes(page.duration_s)
  // The page as the wall will show it, even with every tile empty: cameras can still be put on it.
  const [shown] = buildPages([page], (lid) => resolveLayout(lid, windowSettings), { keepEmptyPages: true })
  const layout = shown.layout
  const tiles = layout.tiles.length
  const cameraCount = camerasOf(page.camera_ids).length
  const hasGaps = page.camera_ids.includes(null)
  // Live video only when asked for: one camera at a time, in a dialog.
  const [live, setLive] = useState<number | null>(null)
  // As on a running wall's Arrange: a chosen tile that the next camera
  // clicked in the list goes to, and what the last change did, e.g. that
  // the camera was already on another tile or that some went onto new pages.
  const [target, setTarget] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const nameOf = (id: number) => camById.get(id)?.name ?? `#${id}`
  // A layout Live View no longer offers stands in as the automatic grid.
  const tilesOf = (lid: string) => resolveLayout(lid, windowSettings)?.tiles.length || AUTO_GRID_MAX
  const spilledNotice = (n: number, per: number) => {
    const pages = Math.ceil(n / per)
    return n === 1 ? t('tours.spilledOneCamera') : pages === 1 ? t('tours.spilledOnePage', { count: n }) : t('tours.spilledMany', { count: n, pages })
  }

  const place = (cam: number, at: number) => {
    setNotice(placeMessage(t, page.camera_ids, cam, at, nameOf, tiles))
    onChange({ camera_ids: placeAt(page.camera_ids, cam, at, tiles) })
    setTarget(null)
  }
  const choose = (at: number) => { setTarget(target === at ? null : at); setNotice(null) }
  // A smaller layout keeps the cameras on its tiles where they are; the
  // rest go onto new pages after this one rather than disappearing.
  const changeLayout = (lid: string) => {
    const per = tilesOf(lid)
    const { ids, rest } = fit(page.camera_ids, per)
    onChange({ layout_id: lid, camera_ids: ids })
    onSpill(rest, per)
    setTarget(null)
    setNotice(rest.length ? spilledNotice(rest.length, per) : null)
  }
  // An unnamed page whose cameras share one location is named after it
  // (and so are the pages its overflow goes onto).
  const withCameras = (ids: Slot[]): Partial<DraftPage> => {
    const locs = new Set(camerasOf(ids).map((id) => camById.get(id)?.location?.trim()).filter(Boolean))
    return !page.label && locs.size === 1 ? { camera_ids: ids, label: [...locs][0] as string } : { camera_ids: ids }
  }
  // Unticked, a camera leaves its tile empty; ticked, it fills the first
  // empty tile, and on a full page nothing changes but the hint.
  const toggle = (cam: number) => {
    setTarget(null)
    const at = page.camera_ids.indexOf(cam)
    if (at >= 0) { onChange({ camera_ids: removeAt(page.camera_ids, at) }); setNotice(null); return }
    if (firstEmpty(page.camera_ids, tiles) == null) { setNotice(t('tours.pageFull')); return }
    onChange(withCameras(addCamera(page.camera_ids, cam, tiles)))
    setNotice(null)
  }
  // "Add all": as many as fit here, the rest on new pages after this one.
  const addAll = (cams: number[]) => {
    const { ids, rest } = fill(page.camera_ids, cams, tiles)
    onChange(withCameras(ids))
    onSpill(rest, tiles)
    setTarget(null)
    setNotice(rest.length ? spilledNotice(rest.length, tiles) : null)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // A camera from the list lands where the pointer is, or nowhere (let go
  // over the list and nothing changes); a tile being reordered snaps to
  // the nearest one.
  const collide: CollisionDetection = (args) =>
    String(args.active.id).startsWith('pick:') ? pointerWithin(args) : closestCenter(args)
  const onDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id)
    // Only a camera from the list needs an overlay: a tile moves itself.
    setDragging(id.startsWith('pick:') ? Number(id.slice(5)) : null)
  }
  const onCameraDrag = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over || active.id === over.id) return
    const ids = page.camera_ids
    const overId = String(over.id)
    const at = overId.startsWith('slot:') ? Number(overId.slice(5)) : ids.indexOf(Number(over.id))
    if (at < 0) return
    const activeId = String(active.id)
    if (activeId.startsWith('pick:')) { place(Number(activeId.slice(5)), at); return }
    setNotice(null)
    // Swapped, as on a running wall: the cameras between the two stay put.
    onChange({ camera_ids: moveTo(ids, ids.indexOf(Number(active.id)), at, tiles) })
  }
  const sortBy = (key: 'name' | 'location') => {
    const name = (id: number) => (camById.get(id)?.name ?? '').toLowerCase()
    const loc = (id: number) => (camById.get(id)?.location ?? '').toLowerCase()
    onChange({
      camera_ids: camerasOf(page.camera_ids).sort((a, b) =>
        key === 'location' ? loc(a).localeCompare(loc(b)) || name(a).localeCompare(name(b)) : name(a).localeCompare(name(b))),
    })
  }
  const byLocation = useMemo(() => {
    const m = new Map<string, number>()
    for (const id of camerasOf(page.camera_ids)) {
      const loc = camById.get(id)?.location?.trim() || t('tours.noLocation')
      m.set(loc, (m.get(loc) ?? 0) + 1)
    }
    return [...m.entries()]
  }, [page.camera_ids, camById, t])

  return (
    <section className="@container border border-[var(--border)] bg-[var(--panel-2)] min-w-0" data-testid="tour-page-editor" aria-label={t('tours.pageN', { n: index + 1 })}
      onKeyDown={(e) => { if (e.key === 'Escape' && target != null) { e.stopPropagation(); setTarget(null) } }}>
      {/* One row: the page's number, label, layout and time, then its actions.
          The controls carry their own names (placeholder, tooltip, aria). */}
      <header className="flex flex-wrap items-center gap-2 px-2 py-1.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
        <span className="shrink-0 w-6 h-6 inline-flex items-center justify-center text-xs font-semibold font-mono bg-[var(--accent)] text-white">{index + 1}</span>
        <div className="min-w-[10rem] flex-1">
          <Input value={page.label} maxLength={60} placeholder={t('tours.pageLabelPlaceholder')}
            aria-label={t('tours.pageLabel')} title={t('tours.pageLabel')} onChange={(e) => onChange({ label: e.target.value })} />
        </div>
        <div className="w-44 shrink-0">
          <Select value={page.layout_id} onChange={(e) => changeLayout(e.target.value)}
            aria-label={t('tours.layout')} title={t('tours.layout')}
            className={clsx((badLayout || !known) && '!border-[var(--danger)]')}>
            {!known && <option value={page.layout_id}>{t('tours.layoutGone', { id: page.layout_id })}</option>}
            <optgroup label={t('tours.layoutsGrids')}>
              {extraGrid && <option value={extraGrid.id}>{extraGrid.label} ({extraGrid.tiles})</option>}
              {options.grids.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.tiles})</option>)}
            </optgroup>
            <optgroup label={t('tours.layoutsBuiltIn')}>
              {options.builtIn.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.tiles})</option>)}
            </optgroup>
            {options.custom.length > 0 && (
              <optgroup label={t('tours.layoutsCustom')}>
                {options.custom.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.tiles})</option>)}
              </optgroup>
            )}
          </Select>
        </div>
        <div className="shrink-0 flex items-center gap-1" title={t('tours.duration')}>
          <div className="w-32">
            <Select
              value={custom ? 'custom' : String(page.duration_s)}
              onChange={(e) => onChange({ duration_s: e.target.value === 'custom' ? (custom ? page.duration_s : 90) : Number(e.target.value) })}
              aria-label={t('tours.duration')}
            >
              {DURATION_PRESETS.map((d) => <option key={d} value={d}>{t('tours.everyDuration', { d: formatDuration(d) })}</option>)}
              <option value="custom">{t('tours.durationCustom')}</option>
            </Select>
          </div>
          {custom && (
            // Sized by a wrapper: the shared control class is always w-full.
            <div className="w-20">
              <Input
                type="number" min={MIN_DURATION} max={MAX_DURATION} value={page.duration_s}
                aria-label={t('tours.durationSeconds')} title={t('tours.durationSeconds')}
                onChange={(e) => onChange({ duration_s: Math.min(MAX_DURATION, Math.max(MIN_DURATION, Number(e.target.value) || MIN_DURATION)) })}
              />
            </div>
          )}
        </div>
        <span className="flex items-center gap-0.5">
          <IconAction label={t('tours.duplicatePage')} onClick={onDuplicate}><CopyPlus size={13} /></IconAction>
          <IconAction label={t('tours.removePage')} onClick={onRemove} disabled={count === 1} danger><Trash2 size={13} /></IconAction>
        </span>
      </header>
      {(badLayout || !known) && <p className="px-2 pt-1.5 text-xs text-[var(--danger)]">{t('tours.layoutUnavailable')}</p>}

      <div className="p-2 space-y-2">
        {/* Two panes: pick cameras on the left, arrange them on the right in
            the preview itself (drag tiles to reorder, x to remove). They stack
            when the panel is too narrow for both. */}
        <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onDragStart} onDragEnd={onCameraDrag} onDragCancel={() => setDragging(null)}>
        <div className="grid gap-3 @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] items-start">
          <CameraPicker
            cameras={cameras}
            selected={page.camera_ids}
            target={target}
            onPick={(cam) => target != null && place(cam, target)}
            onStopChoosing={() => setTarget(null)}
            onLive={setLive}
            onToggle={toggle}
            onAddAll={addAll}
          />

          <div className="min-w-0 space-y-2" data-testid="tour-page-preview-pane">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t('tours.preview')}</span>
              <span className={clsx('text-xs font-mono tabular-nums', cameraCount === 0 && showErrors ? 'text-[var(--danger)]' : 'text-[var(--text-dim)]')} data-testid="tour-page-capacity">
                {cameraCount === 0 ? t('tours.noCamerasYet') : t('tours.tilesUsed', { count: cameraCount, tiles })}
              </span>
              {byLocation.map(([loc, n]) => (
                <span key={loc} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)]" title={t('tours.byLocation')}>
                  <MapPin size={10} aria-hidden="true" /> {loc} · {n}
                </span>
              ))}
              {(cameraCount > 1 || hasGaps) && (
                <span className="ml-auto flex items-center gap-1">
                  {hasGaps && (
                    <Button size="sm" variant="ghost" onClick={() => { onChange({ camera_ids: closeGaps(page.camera_ids) }); setTarget(null); setNotice(null) }}
                      title={t('tours.closeGapsHint')} data-testid="tour-close-gaps">
                      <Rows3 size={12} /> {t('tours.closeGaps')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => sortBy('name')}><ArrowDownAZ size={12} /> {t('tours.sortName')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => sortBy('location')}><MapPin size={12} /> {t('tours.sortLocation')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { onChange({ camera_ids: [] }); setTarget(null); setNotice(null) }}>{t('tours.clearCameras')}</Button>
                </span>
              )}
            </div>
            <p className={clsx('text-[11px]', notice || target != null ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-dim)]')} role="status" data-testid="tour-page-notice">
              {target != null ? t('tours.editorTarget', { n: target + 1 }) : notice ?? (cameraCount === 0 ? t('tours.previewEmpty') : t('tours.editorHint'))}
            </p>
            <SortableContext items={camerasOf(shown.cameraIds)} strategy={rectSortingStrategy}>
              <PagePreview
                layout={layout}
                cameraIds={shown.cameraIds}
                camById={camById}
                cover={cover}
                bad={badCameras}
                target={target}
                onSelect={choose}
                onLive={setLive}
                onRemove={(cid) => { onChange({ camera_ids: removeAt(page.camera_ids, page.camera_ids.indexOf(cid)) }); setTarget(null); setNotice(null) }}
              />
            </SortableContext>
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging != null && (
            <div className="flex items-center gap-2 w-56 p-1 pr-2 text-xs text-white bg-black/85 border border-[var(--accent)] shadow-lg">
              <CameraThumb cameraId={dragging} alt="" className="w-14 aspect-video shrink-0" />
              <span className="truncate">{nameOf(dragging)}</span>
            </div>
          )}
        </DragOverlay>
        </DndContext>
      </div>
      {live != null && <LivePeek cameraId={live} cam={camById.get(live)} onClose={() => setLive(null)} />}
    </section>
  )
}

/** The page as the wall will show it, from stills; each tile can be
 *  dragged to reorder, removed, or opened live. */
function PagePreview({ layout, cameraIds, camById, cover, bad, target, onSelect, onLive, onRemove }: {
  layout: LayoutDefinition
  cameraIds: Slot[]
  camById: Map<number, CameraItem>
  cover: boolean
  bad: Set<number>
  /** The chosen tile (0-based), if any. */
  target: number | null
  onSelect: (slot: number) => void
  onLive: (cameraId: number) => void
  onRemove: (cameraId: number) => void
}) {
  return (
    <div
      className="w-full max-w-[calc((100vh-15rem)*16/9)] aspect-video bg-black p-px"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.gridRows}, minmax(0, 1fr))`, gap: '1px' }}
      data-testid="tour-page-preview"
    >
      {layout.tiles.map((tile, i) => {
        const cid = cameraIds[i]
        const area = { gridRow: `${tile.row + 1} / span ${tile.rowSpan}`, gridColumn: `${tile.col + 1} / span ${tile.colSpan}` }
        return cid != null ? (
          <PreviewTile key={cid} cameraId={cid} order={i + 1} area={area} cam={camById.get(cid)} cover={cover}
            bad={bad.has(cid)} selected={target === i} onSelect={() => onSelect(i)} onLive={() => onLive(cid)} onRemove={() => onRemove(cid)} />
        ) : (
          <EmptyTile key={`e${i}`} slot={i} order={i + 1} area={area} selected={target === i} onSelect={() => onSelect(i)} />
        )
      })}
    </div>
  )
}

/** An empty tile: a camera can be dropped on it, or it can be chosen. */
function EmptyTile({ slot, order, area, selected, onSelect }: {
  slot: number
  order: number
  area: React.CSSProperties
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const drop = useDroppable({ id: `slot:${slot}` })
  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      style={area}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={t('tours.arrangeEmptyTile', { n: order })}
      title={t('tours.arrangeEmptyTile', { n: order })}
      data-testid="tour-preview-empty"
      className={clsx('flex items-center justify-center border border-dashed bg-[#0b0f16] text-[10px] font-mono text-white/30 hover:bg-white/5',
        selected ? 'border-transparent ring-2 ring-inset ring-[var(--accent)]' : drop.isOver ? 'border-transparent ring-2 ring-inset ring-[var(--accent)] bg-[var(--accent)]/15' : 'border-white/10')}
    >
      {order}
    </button>
  )
}

function PreviewTile({ cameraId, order, area, cam, cover, bad, selected, onSelect, onLive, onRemove }: {
  cameraId: number
  order: number
  area: React.CSSProperties
  cam: CameraItem | undefined
  cover: boolean
  bad: boolean
  selected: boolean
  onSelect: () => void
  onLive: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } = useSortable({ id: cameraId })
  // A camera from the list held over this tile would replace it.
  const pickOver = isOver && String(active?.id ?? '').startsWith('pick:')
  const name = cam?.name ?? `#${cameraId}`
  return (
    <div
      ref={setNodeRef}
      style={{ ...area, transform: CSS.Transform.toString(transform), transition }}
      className={clsx('group/tile relative min-w-0 min-h-0 overflow-hidden bg-[#0b0f16]', isDragging && 'z-10 opacity-80 ring-2 ring-[var(--accent)]', bad && 'ring-2 ring-inset ring-[var(--danger)]')}
      data-testid="tour-preview-tile"
      data-camera-id={cameraId}
    >
      <div className="absolute inset-0 cursor-grab active:cursor-grabbing" {...attributes} {...listeners}
        onClick={onSelect} aria-pressed={selected} aria-label={t('tours.arrangeTile', { n: order, name })} title={t('tours.arrangeTile', { n: order, name })}>
        <CameraThumb cameraId={cameraId} alt={name} className={clsx('absolute inset-0', !cover && '[&_img]:object-contain')} />
      </div>
      <div className={clsx('pointer-events-none absolute inset-0',
        selected ? 'ring-4 ring-inset ring-[var(--accent)]' : pickOver && 'ring-2 ring-inset ring-[var(--accent)] bg-[var(--accent)]/15')} />
      <span className="pointer-events-none absolute left-1 top-1 px-1 text-[10px] font-mono text-white bg-black/60">{order}</span>
      <span className="pointer-events-none absolute left-1 right-1 bottom-0.5 text-[10px] text-white truncate [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">{name}</span>
      {/* Shown on hover or keyboard focus; always reachable by Tab. */}
      <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 transition-opacity">
        <button type="button" onClick={onLive} className="p-1 text-white bg-black/65 hover:bg-black/85" aria-label={t('tours.watchLive', { name })} title={t('tours.watchLive', { name })}>
          <Play size={11} />
        </button>
        <button type="button" onClick={onRemove} className="p-1 text-white bg-black/65 hover:bg-[var(--danger)]" aria-label={t('tours.removeCamera', { name })} title={t('tours.removeCamera', { name })}>
          <X size={11} />
        </button>
      </span>
    </div>
  )
}

/** One camera live, on demand: the picker and the preview show stills only. */
function LivePeek({ cameraId, cam, onClose }: { cameraId: number; cam: CameraItem | undefined; onClose: () => void }) {
  const { t } = useTranslation()
  const info = useQuery({
    queryKey: ['tour-stream', cameraId],
    queryFn: async () => (await apiService.getTourStreamInfo(cameraId)).data as { urls?: { webrtc?: string; hls?: string }; token?: string },
    staleTime: 45 * 60_000,
  })
  const name = cam?.name ?? `#${cameraId}`
  return (
    <Modal open title={t('tours.liveTitle', { name })} onClose={onClose} widthClassName="w-[calc(100vw-2rem)] max-w-4xl" bodyClassName="p-0">
      <div className="aspect-video bg-black" data-testid="tour-live-peek">
        {info.data?.urls ? (
          <VideoPlayer
            mode="live"
            chrome="controls"
            whepUrl={rebaseToCurrentOrigin(info.data.urls.webrtc)}
            hlsUrl={rebaseToCurrentOrigin(info.data.urls.hls)}
            mediamtxToken={info.data.token}
            onAuthExpired={() => info.refetch()}
            preferredStreamType="webrtc"
            autoPlay
            muted
            displayAspectOverride={cam?.display_aspect_ratio}
            cameraId={cameraId}
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-white/60">
            {info.isError ? t('tours.liveFailed') : t('tours.loading')}
          </div>
        )}
      </div>
      {cam && (
        <div className="px-3 py-2 text-xs text-[var(--text-dim)]">{[cam.location, cam.ip_address].filter(Boolean).join(' · ')}</div>
      )}
    </Modal>
  )
}

function LayoutPreview({ layout, small }: { layout: LayoutDefinition; small?: boolean }) {
  return (
    <div
      className={clsx('shrink-0 aspect-video bg-[var(--bg)] p-[2px]', small ? 'w-9' : 'w-12')}
      style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.gridCols}, 1fr)`, gridTemplateRows: `repeat(${layout.gridRows}, 1fr)`, gap: '1px' }}
      aria-hidden="true"
    >
      {layout.tiles.map((tile, i) => (
        <div key={i} className="bg-[var(--accent)]/40"
          style={{ gridRow: `${tile.row + 1} / span ${tile.rowSpan}`, gridColumn: `${tile.col + 1} / span ${tile.colSpan}` }} />
      ))}
    </div>
  )
}

const NO_LOCATION = '\u0000none'

function CameraPicker({ cameras, selected, target, onPick, onStopChoosing, onToggle, onAddAll, onLive }: {
  cameras: CameraItem[]
  /** The page's tiles; null is an empty one. */
  selected: Slot[]
  /** A chosen tile: a click then puts the camera there. */
  target: number | null
  onPick: (cameraId: number) => void
  onStopChoosing: () => void
  /** Ticked or unticked. */
  onToggle: (cameraId: number) => void
  /** "Add all": these cameras, in order. */
  onAddAll: (cameraIds: number[]) => void
  onLive: (cameraId: number) => void
}) {
  const { t } = useTranslation()
  const position = useMemo(() => new Map(selected.flatMap((id, i) => (id == null ? [] : [[id, i] as const]))), [selected])
  const [q, setQ] = useState('')
  const [location, setLocation] = useState('')
  const chosen = useMemo(() => new Set(selected), [selected])

  const locations = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of cameras) {
      const loc = c.location?.trim() || NO_LOCATION
      counts.set(loc, (counts.get(loc) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => (a === NO_LOCATION ? 1 : b === NO_LOCATION ? -1 : a.localeCompare(b)))
  }, [cameras])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return cameras
      .filter((c) => !location || (c.location?.trim() || NO_LOCATION) === location)
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.ip_address?.includes(needle) || c.location?.toLowerCase().includes(needle))
      .sort((a, b) => (a.location ?? '').localeCompare(b.location ?? '') || a.name.localeCompare(b.name))
  }, [cameras, q, location])

  const notYet = shown.filter((c) => !chosen.has(c.id))
  const locationLabel = (loc: string) => (loc === NO_LOCATION ? t('tours.noLocation') : loc)

  return (
    <div className="@container border border-[var(--border)] bg-[var(--panel)] min-w-0" data-testid="tour-camera-picker" role="group" aria-label={t('tours.addCameras')}>
      {/* Search on its own line (the pane is narrow); location and "add all" share the next. */}
      <div className="space-y-2 p-2 border-b border-[var(--border)]">
        {target != null && (
          <div className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--accent)] border border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]">
            <span className="flex-1">{t('tours.editorTarget', { n: target + 1 })}</span>
            <IconAction label={t('tours.stopChoosing')} onClick={onStopChoosing}><X size={12} /></IconAction>
          </div>
        )}
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tours.searchCameras')} className="pl-7" aria-label={t('tours.searchCameras')} />
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label={t('tours.location')}>
              <option value="">{t('tours.allLocations', { count: cameras.length })}</option>
              {locations.map(([loc, n]) => <option key={loc} value={loc}>{locationLabel(loc)} ({n})</option>)}
            </Select>
          </div>
          {notYet.length > 0 && (
            <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" onClick={() => onAddAll(notYet.map((c) => c.id))}>
              {location
                ? t('tours.addAllFrom', { count: notYet.length, location: locationLabel(location) })
                : t('tours.addAllShown', { count: notYet.length })}
            </Button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="p-3 text-xs text-[var(--text-dim)]">{t('tours.noCamerasMatch')}</div>
      ) : (
        <ul className="max-h-[calc(100vh-18rem)] min-h-48 overflow-auto divide-y divide-[var(--border)]">
          {shown.map((c) => (
            <PickerRow key={c.id} cam={c} at={position.get(c.id)} choosing={target != null}
              onToggle={() => onToggle(c.id)} onPick={() => onPick(c.id)} onLive={() => onLive(c.id)} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** A camera in the picker: tick to add or remove it, drag it onto a tile,
 *  or, with a tile chosen, click to put it there. */
function PickerRow({ cam, at, choosing, onToggle, onPick, onLive }: {
  cam: CameraItem
  /** Its tile on the page, when it is on it. */
  at: number | undefined
  choosing: boolean
  onToggle: () => void
  onPick: () => void
  onLive: () => void
}) {
  const { t } = useTranslation()
  const drag = useDraggable({ id: `pick:${cam.id}` })
  const onPage = at != null
  return (
    <li ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} role={undefined} tabIndex={-1}
      className={clsx('flex items-center gap-2 pr-1 hover:bg-[var(--panel-2)] cursor-grab active:cursor-grabbing', onPage && 'bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]', drag.isDragging && 'opacity-40')}
      data-testid="tour-picker-row">
      <label className="flex flex-1 min-w-0 items-center gap-2 pl-2 py-1.5 text-xs cursor-pointer"
        title={choosing ? t('tours.arrangePick', { name: cam.name }) : undefined}
        onClick={(e) => { if (choosing) { e.preventDefault(); onPick() } }}>
        <input type="checkbox" checked={onPage} onChange={onToggle} />
        <CameraThumb cameraId={cam.id} alt={cam.name} className="w-16 aspect-video shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{cam.name}</span>
          <span className="block truncate text-[10px] text-[var(--text-dim)]">
            {onPage && <span className="text-[var(--accent)]">{t('tours.arrangeOnTile', { n: at + 1 })} · </span>}
            {[cam.location, cam.ip_address].filter(Boolean).join(' · ')}
            {!cam.is_active && ` · ${t('tours.cameraPaused')}`}
          </span>
        </span>
      </label>
      <IconAction label={t('tours.watchLive', { name: cam.name })} onClick={onLive}><Play size={12} /></IconAction>
    </li>
  )
}
