// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The camera-tour editor, a page of its own (/tours/new, /tours/:id/edit;
 * opened from Settings › Camera Tours or from a running wall's Edit button,
 * where ?return= brings it back on save).
 *
 * Steps on the left, dragged into order; the selected step on the right:
 * its layout, how long each page shows, a preview of every page built from
 * camera stills, the chosen cameras (dragged into order, sorted, counted by
 * location) and a picker that shows each camera's picture. Below the steps,
 * the tour's own settings: Fit or Fill, and the alarm takeover.
 */

import { useEffect, useMemo, useState } from 'react'
import { useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDownAZ, ArrowLeft, BellRing, ChevronDown, ChevronRight, CopyPlus, GripVertical, MapPin, PanelLeftClose, PanelLeftOpen, Play, Plus, Route, Search, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../i18n'
import { apiService } from '../lib/apiService'
import { rebaseToCurrentOrigin } from '../lib/streamUrl'
import { Modal } from '../components/Modal'
import { VideoPlayer } from '../components/VideoPlayer'
import { useCameras, type CameraItem } from '../lib/queries'
import { PLAIN_GRIDS, PREDEFINED_LAYOUTS, parseGridId, resolveLayout, type LayoutDefinition, type WindowLayoutSettings } from '../lib/liveLayouts'
import { buildPages, cycleSeconds, formatDuration } from '../lib/tourPlan'
import { DEFAULT_TOUR_SETTINGS, type AlertSeverity, type AlertSource, type Tour, type TourInput, type TourSettings } from '../services/tourService'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useSnackbar } from '../components/Snackbar'
import { Button, ErrorCard, Skeleton } from '../components/ui'
import { Field, Input, Select } from '../components/ui/form'
import { Switch } from '../components/ui/Switch'
import { CameraThumb } from '../components/live/CameraThumb'
import { IconAction } from '../components/live/IconAction'

export const TOURS_LIST_PATH = '/settings/more-settings/camera-tours'

const DURATION_PRESETS = [30, 60, 120, 300]
const MIN_DURATION = 10
const MAX_DURATION = 3600

type DraftStep = { uid: string; label: string; layout_id: string; duration_s: number; camera_ids: number[] }
// `description` has no field in the editor; it rides along so a save keeps it.
type Draft = {
  id: number | null
  revision?: number
  name: string
  description?: string | null
  enabled: boolean
  settings: TourSettings
  steps: DraftStep[]
}

let uidSeq = 0
const uid = () => `s${++uidSeq}`
const newStep = (layout_id = 'grid:5x4'): DraftStep => ({ uid: uid(), label: '', layout_id, duration_s: 60, camera_ids: [] })
const blankDraft = (): Draft => ({ id: null, name: '', enabled: true, settings: DEFAULT_TOUR_SETTINGS, steps: [newStep()] })

function toInput(d: Draft): TourInput {
  return {
    name: d.name.trim(),
    description: d.description ?? null,
    enabled: d.enabled,
    settings: d.settings,
    steps: d.steps.map((s) => ({ label: s.label.trim(), layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: s.camera_ids })),
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
    steps: tour.steps.map((s) => ({ uid: uid(), label: s.label, layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: [...s.camera_ids] })),
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
  const [selected, setSelected] = useState(initial.steps[0]?.uid)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<{ text: string; conflict?: boolean } | null>(null)
  const [badCameras, setBadCameras] = useState<Set<number>>(new Set())
  const [badLayouts, setBadLayouts] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)

  const camById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras])
  const [rail, setRail] = usePref('opennvr.tourEditor.rail', false)
  const [stepsOpen, setStepsOpen] = usePref('opennvr.tourEditor.steps', true)
  const [settingsOpen, setSettingsOpen] = usePref('opennvr.tourEditor.settings', true)
  const dirty = JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(initial))
  const resolve = (lid: string) => resolveLayout(lid, windowSettings)
  const pages = buildPages(draft.steps, resolve)
  const step = draft.steps.find((s) => s.uid === selected) ?? draft.steps[0]
  const emptySteps = draft.steps.filter((s) => s.camera_ids.length === 0).length
  const canSave = !readOnly && !!draft.name.trim() && draft.steps.length > 0 && emptySteps === 0 && !saving

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

  const setStep = (key: string, patch: Partial<DraftStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.uid === key ? { ...s, ...patch } : s)) }))
  const setSettings = (patch: Partial<TourSettings>) => setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }))
  const setAlerts = (patch: Partial<TourSettings['alerts']>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, alerts: { ...d.settings.alerts, ...patch } } }))

  const addStep = () => {
    const s = newStep(draft.steps[draft.steps.length - 1]?.layout_id)
    setDraft((d) => ({ ...d, steps: [...d.steps, s] }))
    setSelected(s.uid)
  }
  const duplicateStep = (key: string) => {
    const i = draft.steps.findIndex((s) => s.uid === key)
    if (i < 0) return
    const copy = { ...draft.steps[i], uid: uid(), camera_ids: [...draft.steps[i].camera_ids] }
    setDraft((d) => { const steps = [...d.steps]; steps.splice(i + 1, 0, copy); return { ...d, steps } })
    setSelected(copy.uid)
  }
  const removeStep = (key: string) => {
    const i = draft.steps.findIndex((s) => s.uid === key)
    setDraft((d) => ({ ...d, steps: d.steps.filter((s) => s.uid !== key) }))
    const next = draft.steps[i + 1] ?? draft.steps[i - 1]
    if (next) setSelected(next.uid)
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
  const onStepDrag = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    setDraft((d) => {
      const from = d.steps.findIndex((s) => s.uid === active.id)
      const to = d.steps.findIndex((s) => s.uid === over.id)
      return from < 0 || to < 0 ? d : { ...d, steps: arrayMove(d.steps, from, to) }
    })
  }

  return (
    <div className="space-y-3" data-testid="tour-editor">
      {/* Title and summary on the left, the two actions pinned right at every width. */}
      <div className="flex items-start gap-3 border-b border-[var(--border)] pb-3">
        <div className="min-w-0 flex-1">
          <Button variant="ghost" size="sm" onClick={() => navigate(back)} className="-ml-2"><ArrowLeft size={14} /> {t('tours.backToList')}</Button>
          <h1 className="mt-1 text-base font-semibold flex items-center gap-2 min-w-0">
            <Route size={16} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate">{draft.id == null ? t('tours.newTitle') : t('tours.editTitle', { name: initial.name })}</span>
          </h1>
          <div className="mt-0.5 text-xs text-[var(--text-dim)] font-mono tabular-nums" data-testid="tour-cycle">
            {t('tours.cycleSummary', { steps: draft.steps.length, pages: pages.length, cycle: formatDuration(cycleSeconds(pages)) })}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2 pt-1">
          <Button variant="ghost" onClick={() => navigate(back)}>{t('tours.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={saving || readOnly || (touched && !canSave)}>
            {saving ? t('tours.saving') : t('tours.save')}
          </Button>
        </div>
      </div>

      {readOnly && <div className="text-sm text-[var(--text-dim)] border border-[var(--border)] p-2">{t('tours.readOnly')}</div>}
      {error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] border border-[color-mix(in_oklab,var(--danger)_45%,var(--border))] p-2">
          <span className="flex-1">{error.text}</span>
          {error.conflict && <Button size="sm" variant="outline" onClick={onReload}>{t('tours.reload')}</Button>}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
        <Field label={t('tours.name')} required error={touched && !draft.name.trim() ? t('tours.nameRequired') : undefined} htmlFor="tour-name">
          <Input id="tour-name" value={draft.name} maxLength={100} autoFocus={draft.id == null} placeholder={t('tours.namePlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onBlur={() => setTouched(true)} />
        </Field>
        <label className="flex items-center gap-2 text-sm pb-1.5">
          <Switch checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label={t('tours.enabled')} />
          {t('tours.enabled')}
        </label>
      </div>

      {/* Two columns from xl up (steps + settings | the selected step); below
          that one column in reading order: steps, the step, then settings.
          From xl the left column can fold to a rail of step numbers. The step
          panel spans both left rows; the first row stays as tall as the step
          list and the second takes the rest, so settings sit right under it. */}
      <div className={clsx('grid gap-4 xl:grid-rows-[auto_1fr] items-start',
        rail ? 'xl:grid-cols-[3rem_minmax(0,1fr)]' : 'xl:grid-cols-[20rem_minmax(0,1fr)]')}>
        {rail && (
          <nav className="hidden xl:flex xl:col-start-1 xl:row-start-1 xl:row-span-2 flex-col items-center gap-1 py-2 border border-[var(--border)] bg-[var(--panel-2)]" aria-label={t('tours.steps')} data-testid="tour-steps-rail">
            <IconAction label={t('tours.showPanel')} onClick={() => setRail(false)}><PanelLeftOpen size={15} /></IconAction>
            <span className="w-6 h-px bg-[var(--border)] my-1" aria-hidden="true" />
            {draft.steps.map((s, i) => (
              <button key={s.uid} type="button" onClick={() => setSelected(s.uid)}
                title={s.label || t('tours.stepN', { n: i + 1 })} aria-label={s.label || t('tours.stepN', { n: i + 1 })} aria-current={s.uid === step?.uid || undefined}
                className={clsx('w-8 h-8 text-xs font-mono border',
                  s.uid === step?.uid ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)]',
                  touched && s.camera_ids.length === 0 && 'border-[var(--danger)]')}>
                {i + 1}
              </button>
            ))}
            <IconAction label={t('tours.addStep')} onClick={addStep}><Plus size={14} /></IconAction>
          </nav>
        )}

        <section className={clsx('border border-[var(--border)] bg-[var(--panel-2)] xl:col-start-1 xl:row-start-1', rail && 'xl:hidden')} data-testid="tour-steps">
          <header className="flex items-center gap-2 pl-1 pr-1 py-1 border-b border-[var(--border)] text-sm font-medium">
            <button type="button" onClick={() => setStepsOpen(!stepsOpen)} aria-expanded={stepsOpen}
              className="flex flex-1 min-w-0 items-center gap-1.5 px-1.5 py-0.5 text-left hover:bg-[var(--panel)]">
              {stepsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t('tours.steps')}
              <span className="text-xs font-normal text-[var(--text-dim)] truncate">
                {stepsOpen ? t('tours.dragToReorder') : t('tours.stepsCount', { count: draft.steps.length })}
              </span>
            </button>
            <span className="hidden xl:inline-flex">
              <IconAction label={t('tours.hidePanel')} onClick={() => setRail(true)}><PanelLeftClose size={15} /></IconAction>
            </span>
          </header>
          {stepsOpen && (
            <>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onStepDrag}>
                <SortableContext items={draft.steps.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
                  <ol className="divide-y divide-[var(--border)]">
                    {draft.steps.map((s, i) => (
                      <StepRow
                        key={s.uid}
                        step={s}
                        index={i}
                        selected={s.uid === step?.uid}
                        layout={resolve(s.layout_id)}
                        invalid={touched && s.camera_ids.length === 0}
                        onSelect={() => setSelected(s.uid)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              <div className="p-2 border-t border-[var(--border)]">
                <Button variant="outline" size="sm" onClick={addStep}><Plus size={14} /> {t('tours.addStep')}</Button>
              </div>
            </>
          )}
        </section>

        {/* The selected step */}
        {step && (
          <div className="min-w-0 xl:col-start-2 xl:row-start-1 xl:row-span-2">
            <StepDetail
              key={step.uid}
              step={step}
              index={draft.steps.indexOf(step)}
              count={draft.steps.length}
              layout={resolve(step.layout_id)}
              windowSettings={windowSettings}
              cameras={cameras}
              camById={camById}
              badCameras={badCameras}
              badLayout={badLayouts.has(step.layout_id)}
              showErrors={touched}
              cover={draft.settings.fit === 'fill'}
              onChange={(patch) => setStep(step.uid, patch)}
              onDuplicate={() => duplicateStep(step.uid)}
              onRemove={() => removeStep(step.uid)}
            />
          </div>
        )}

        <div className={clsx('xl:col-start-1 xl:row-start-2', rail && 'xl:hidden')}>
          <TourSettingsPanel settings={draft.settings} open={settingsOpen} onToggle={() => setSettingsOpen(!settingsOpen)}
            onFit={(fit) => setSettings({ fit })} onAlerts={setAlerts} />
        </div>
      </div>
    </div>
  )
}

function StepRow({ step, index, selected, layout, invalid, onSelect }: {
  step: DraftStep
  index: number
  selected: boolean
  layout: LayoutDefinition | null
  invalid: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.uid })
  const tiles = layout?.tiles.length ?? 0
  const pages = tiles ? Math.ceil(step.camera_ids.length / tiles) : 0
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx('flex items-center gap-2 px-2 py-2 bg-[var(--panel-2)]', selected && 'bg-[color-mix(in_oklab,var(--accent)_12%,var(--panel-2))]', isDragging && 'relative z-10 shadow-lg')}
      data-testid="tour-step-row"
    >
      <button type="button" className="p-1 text-[var(--text-dim)] cursor-grab active:cursor-grabbing" aria-label={t('tours.dragStep', { n: index + 1 })} {...attributes} {...listeners}>
        <GripVertical size={14} />
      </button>
      <button type="button" onClick={onSelect} className="flex-1 min-w-0 flex items-center gap-2 text-left" aria-current={selected || undefined}>
        <span className="text-xs font-mono text-[var(--text-dim)] w-4 text-right">{index + 1}</span>
        {layout && <LayoutPreview layout={layout} small />}
        <span className="min-w-0 flex-1">
          <span className={clsx('block text-sm truncate', selected && 'font-semibold')}>{step.label || t('tours.stepN', { n: index + 1 })}</span>
          <span className={clsx('block text-[11px] font-mono tabular-nums', invalid ? 'text-[var(--danger)]' : 'text-[var(--text-dim)]')}>
            {step.camera_ids.length === 0
              ? t('tours.noCamerasYet')
              : `${t('tours.camerasCount', { count: step.camera_ids.length })}${pages > 1 ? ` · ${t('tours.pagesCount', { count: pages })}` : ''} · ${formatDuration(step.duration_s)}`}
          </span>
        </span>
      </button>
    </li>
  )
}

function TourSettingsPanel({ settings, open, onToggle, onFit, onAlerts }: {
  settings: TourSettings
  open: boolean
  onToggle: () => void
  onFit: (fit: TourSettings['fit']) => void
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
          <Select value={settings.fit} onChange={(e) => onFit(e.target.value as TourSettings['fit'])}>
            <option value="fit">{t('tours.fitFit')}</option>
            <option value="fill">{t('tours.fitFill')}</option>
          </Select>
        </Field>

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

function StepDetail({ step, index, count, layout, windowSettings, cameras, camById, badCameras, badLayout, showErrors, cover, onChange, onDuplicate, onRemove }: {
  step: DraftStep
  index: number
  count: number
  layout: LayoutDefinition | null
  windowSettings: WindowLayoutSettings | undefined
  cameras: CameraItem[]
  camById: Map<number, CameraItem>
  badCameras: Set<number>
  badLayout: boolean
  showErrors: boolean
  cover: boolean
  onChange: (patch: Partial<DraftStep>) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const options = useMemo(() => layoutOptions(windowSettings), [windowSettings])
  // Any grid:CxR is valid, offered or not (a tour made through the API may use 2×2).
  const plain = parseGridId(step.layout_id)
  const extraGrid = plain && !options.grids.some((o) => o.id === step.layout_id)
    ? { id: step.layout_id, label: `${plain[0]}×${plain[1]}`, tiles: plain[0] * plain[1] }
    : null
  const known = !!plain || [...options.builtIn, ...options.custom].some((o) => o.id === step.layout_id)
  const custom = !DURATION_PRESETS.includes(step.duration_s)
  const pages = buildPages([step], (lid) => resolveLayout(lid, windowSettings))
  const [previewPage, setPreviewPage] = useState(0)
  const shownPage = pages[Math.min(previewPage, Math.max(0, pages.length - 1))]
  // Live video only when asked for: one camera at a time, in a dialog.
  const [live, setLive] = useState<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onCameraDrag = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = step.camera_ids
    onChange({ camera_ids: arrayMove(ids, ids.indexOf(Number(active.id)), ids.indexOf(Number(over.id))) })
  }
  const sortBy = (key: 'name' | 'location') => {
    const name = (id: number) => (camById.get(id)?.name ?? '').toLowerCase()
    const loc = (id: number) => (camById.get(id)?.location ?? '').toLowerCase()
    onChange({
      camera_ids: [...step.camera_ids].sort((a, b) =>
        key === 'location' ? loc(a).localeCompare(loc(b)) || name(a).localeCompare(name(b)) : name(a).localeCompare(name(b))),
    })
  }
  const byLocation = useMemo(() => {
    const m = new Map<string, number>()
    for (const id of step.camera_ids) {
      const loc = camById.get(id)?.location?.trim() || t('tours.noLocation')
      m.set(loc, (m.get(loc) ?? 0) + 1)
    }
    return [...m.entries()]
  }, [step.camera_ids, camById, t])

  return (
    <section className="@container border border-[var(--border)] bg-[var(--panel-2)] min-w-0" data-testid="tour-step-editor" aria-label={t('tours.stepN', { n: index + 1 })}>
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
        <span className="text-xs font-semibold text-[var(--text-dim)] font-mono">{index + 1}</span>
        <span className="text-sm font-medium truncate">{step.label || t('tours.stepN', { n: index + 1 })}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconAction label={t('tours.duplicateStep')} onClick={onDuplicate}><CopyPlus size={13} /></IconAction>
          <IconAction label={t('tours.removeStep')} onClick={onRemove} disabled={count === 1} danger><Trash2 size={13} /></IconAction>
        </span>
      </header>

      <div className="p-3 space-y-4">
        <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_minmax(0,15rem)]">
          <Field label={t('tours.stepLabel')} hint={t('tours.stepLabelHint')} className="@md:col-span-2 @3xl:col-span-1">
            <Input value={step.label} maxLength={60} placeholder={t('tours.stepLabelPlaceholder')} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
          <Field label={t('tours.layout')} error={badLayout || !known ? t('tours.layoutUnavailable') : undefined}>
            <Select value={step.layout_id} onChange={(e) => { onChange({ layout_id: e.target.value }); setPreviewPage(0) }}>
              {!known && <option value={step.layout_id}>{t('tours.layoutGone', { id: step.layout_id })}</option>}
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
          </Field>
          <Field label={t('tours.duration')}>
            <div className="flex items-center gap-2">
              <Select
                value={custom ? 'custom' : String(step.duration_s)}
                onChange={(e) => onChange({ duration_s: e.target.value === 'custom' ? (custom ? step.duration_s : 90) : Number(e.target.value) })}
                className="flex-1 min-w-0"
              >
                {DURATION_PRESETS.map((d) => <option key={d} value={d}>{formatDuration(d)}</option>)}
                <option value="custom">{t('tours.durationCustom')}</option>
              </Select>
              {custom && (
                // Sized by a wrapper: the shared control class is always w-full.
                <div className="w-24 shrink-0">
                  <Input
                    type="number" min={MIN_DURATION} max={MAX_DURATION} value={step.duration_s}
                    aria-label={t('tours.durationSeconds')} title={t('tours.durationSeconds')}
                    onChange={(e) => onChange({ duration_s: Math.min(MAX_DURATION, Math.max(MIN_DURATION, Number(e.target.value) || MIN_DURATION)) })}
                  />
                </div>
              )}
            </div>
          </Field>
        </div>

        {/* Two panes: pick cameras on the left, arrange them on the right in
            the preview itself (drag tiles to reorder, x to remove). They stack
            when the panel is too narrow for both. */}
        <div className="grid gap-3 @3xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] items-start">
          <CameraPicker
            cameras={cameras}
            selected={step.camera_ids}
            onLive={setLive}
            onChange={(ids) => {
              // An unnamed step whose cameras share one location is named after it.
              const locs = new Set(ids.map((id) => camById.get(id)?.location?.trim()).filter(Boolean))
              onChange(!step.label && locs.size === 1 ? { camera_ids: ids, label: [...locs][0] as string } : { camera_ids: ids })
            }}
          />

          <div className="min-w-0 space-y-2" data-testid="tour-step-preview">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{t('tours.preview')}</span>
              {pages.length > 1 && (
                <span className="flex items-center gap-1" role="tablist" aria-label={t('tours.preview')}>
                  {pages.map((p, i) => (
                    <button key={p.key} type="button" role="tab" aria-selected={p === shownPage}
                      onClick={() => setPreviewPage(i)}
                      className={clsx('text-[11px] px-1.5 py-0.5 border font-mono', p === shownPage ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--text-dim)]')}>
                      {i + 1}
                    </button>
                  ))}
                </span>
              )}
              <span className={clsx('text-xs font-mono tabular-nums', step.camera_ids.length === 0 && showErrors ? 'text-[var(--danger)]' : 'text-[var(--text-dim)]')} data-testid="tour-step-capacity">
                {step.camera_ids.length === 0
                  ? t('tours.noCamerasYet')
                  : pages.length > 1
                    ? t('tours.pagesOf', { count: step.camera_ids.length, pages: pages.length, per: layout?.tiles.length ?? 0 })
                    : t('tours.tilesUsed', { count: step.camera_ids.length, tiles: layout?.tiles.length ?? 0 })}
              </span>
              {step.camera_ids.length > 1 && (
                <span className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => sortBy('name')}><ArrowDownAZ size={12} /> {t('tours.sortName')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => sortBy('location')}><MapPin size={12} /> {t('tours.sortLocation')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => onChange({ camera_ids: [] })}>{t('tours.clearCameras')}</Button>
                </span>
              )}
            </div>
            {byLocation.length > 0 && (
              <div className="flex flex-wrap gap-1" aria-label={t('tours.byLocation')}>
                {byLocation.map(([loc, n]) => (
                  <span key={loc} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 border border-[var(--border)] text-[var(--text-dim)]">
                    <MapPin size={10} aria-hidden="true" /> {loc} · {n}
                  </span>
                ))}
              </div>
            )}
            {shownPage ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCameraDrag}>
                <SortableContext items={shownPage.cameraIds} strategy={rectSortingStrategy}>
                  <PagePreview
                    layout={shownPage.layout}
                    cameraIds={shownPage.cameraIds}
                    firstOrder={step.camera_ids.indexOf(shownPage.cameraIds[0]) + 1}
                    camById={camById}
                    cover={cover}
                    bad={badCameras}
                    onLive={setLive}
                    onRemove={(cid) => onChange({ camera_ids: step.camera_ids.filter((x) => x !== cid) })}
                  />
                </SortableContext>
              </DndContext>
            ) : (
              <div className="aspect-video w-full flex items-center justify-center border border-dashed border-[var(--border)] text-sm text-[var(--text-dim)] px-4 text-center">
                {t('tours.previewEmpty')}
              </div>
            )}
            {pages.length > 1 && <p className="text-[11px] text-[var(--text-dim)]">{t('tours.reorderAcrossPages')}</p>}
          </div>
        </div>
      </div>
      {live != null && <LivePeek cameraId={live} cam={camById.get(live)} onClose={() => setLive(null)} />}
    </section>
  )
}

/** The step's page as the wall will show it, from stills; each tile can be
 *  dragged to reorder, removed, or opened live. */
function PagePreview({ layout, cameraIds, firstOrder, camById, cover, bad, onLive, onRemove }: {
  layout: LayoutDefinition
  cameraIds: number[]
  /** The 1-based position of this page's first camera in the step. */
  firstOrder: number
  camById: Map<number, CameraItem>
  cover: boolean
  bad: Set<number>
  onLive: (cameraId: number) => void
  onRemove: (cameraId: number) => void
}) {
  return (
    <div
      className="w-full max-w-[calc(60vh*16/9)] aspect-video bg-black p-px"
      style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.gridRows}, minmax(0, 1fr))`, gap: '1px' }}
      data-testid="tour-page-preview"
    >
      {layout.tiles.map((tile, i) => {
        const cid = cameraIds[i]
        const area = { gridRow: `${tile.row + 1} / span ${tile.rowSpan}`, gridColumn: `${tile.col + 1} / span ${tile.colSpan}` }
        return cid != null ? (
          <PreviewTile key={cid} cameraId={cid} order={firstOrder + i} area={area} cam={camById.get(cid)} cover={cover}
            bad={bad.has(cid)} onLive={() => onLive(cid)} onRemove={() => onRemove(cid)} />
        ) : (
          <div key={`e${i}`} style={area} className="bg-[#0b0f16]" />
        )
      })}
    </div>
  )
}

function PreviewTile({ cameraId, order, area, cam, cover, bad, onLive, onRemove }: {
  cameraId: number
  order: number
  area: React.CSSProperties
  cam: CameraItem | undefined
  cover: boolean
  bad: boolean
  onLive: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cameraId })
  const name = cam?.name ?? `#${cameraId}`
  return (
    <div
      ref={setNodeRef}
      style={{ ...area, transform: CSS.Transform.toString(transform), transition }}
      className={clsx('group/tile relative min-w-0 min-h-0 overflow-hidden bg-[#0b0f16]', isDragging && 'z-10 opacity-80 ring-2 ring-[var(--accent)]', bad && 'ring-2 ring-inset ring-[var(--danger)]')}
      data-testid="tour-preview-tile"
    >
      <div className="absolute inset-0 cursor-grab active:cursor-grabbing" {...attributes} {...listeners} aria-label={t('tours.dragCamera', { name })}>
        <CameraThumb cameraId={cameraId} alt={name} className={clsx('absolute inset-0', !cover && '[&_img]:object-contain')} />
      </div>
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

function CameraPicker({ cameras, selected, onChange, onLive }: {
  cameras: CameraItem[]
  selected: number[]
  onChange: (ids: number[]) => void
  onLive: (cameraId: number) => void
}) {
  const { t } = useTranslation()
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

  const toggle = (id: number) => onChange(chosen.has(id) ? selected.filter((x) => x !== id) : [...selected, id])
  const notYet = shown.filter((c) => !chosen.has(c.id))
  const locationLabel = (loc: string) => (loc === NO_LOCATION ? t('tours.noLocation') : loc)

  return (
    <div className="@container border border-[var(--border)] bg-[var(--panel)] min-w-0" data-testid="tour-camera-picker">
      <div className="space-y-2 p-2 border-b border-[var(--border)]">
        <div className="text-sm font-medium">{t('tours.addCameras')}</div>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tours.searchCameras')} className="pl-7" aria-label={t('tours.searchCameras')} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-40">
            <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label={t('tours.location')}>
              <option value="">{t('tours.allLocations', { count: cameras.length })}</option>
              {locations.map(([loc, n]) => <option key={loc} value={loc}>{locationLabel(loc)} ({n})</option>)}
            </Select>
          </div>
          {notYet.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => onChange([...selected, ...notYet.map((c) => c.id)])}>
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
        <ul className="max-h-[30rem] overflow-auto divide-y divide-[var(--border)]">
          {shown.map((c) => (
            <li key={c.id} className={clsx('flex items-center gap-2 pr-1 hover:bg-[var(--panel-2)]', chosen.has(c.id) && 'bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]')}>
              <label className="flex flex-1 min-w-0 items-center gap-2 pl-2 py-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
                <CameraThumb cameraId={c.id} alt={c.name} className="w-16 aspect-video shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.name}</span>
                  <span className="block truncate text-[10px] text-[var(--text-dim)]">
                    {[c.location, c.ip_address].filter(Boolean).join(' · ')}
                    {!c.is_active && ` · ${t('tours.cameraPaused')}`}
                  </span>
                </span>
              </label>
              <IconAction label={t('tours.watchLive', { name: c.name })} onClick={() => onLive(c.id)}><Play size={12} /></IconAction>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
