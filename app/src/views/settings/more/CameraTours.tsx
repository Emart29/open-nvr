// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings › More Settings › Camera Tours: build the tours a display board
 * cycles through (views/TourView.tsx runs them, routers/tours.py stores them).
 *
 * A tour is steps; each step is a set of cameras on one layout for a while.
 * Cameras can be picked one by one or a whole location at a time ("all 60
 * North cameras"), and a step with more cameras than its layout holds pages
 * through them — the editor says how many pages that makes.
 */

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Copy, CopyPlus, ExternalLink, Lock, Pencil, Plus, Route, Search, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../../../i18n'
import { apiService } from '../../../lib/apiService'
import { useCameras, type CameraItem } from '../../../lib/queries'
import { PLAIN_GRIDS, PREDEFINED_LAYOUTS, resolveLayout, type LayoutDefinition, type WindowLayoutSettings } from '../../../lib/liveLayouts'
import { buildPages, cycleSeconds, formatDuration } from '../../../lib/tourPlan'
import type { Tour, TourInput } from '../../../services/tourService'
import { usePermissions } from '../../../hooks/usePermissions'
import { Modal } from '../../../components/Modal'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { useSnackbar } from '../../../components/Snackbar'
import { Button, EmptyState, ErrorCard, Skeleton } from '../../../components/ui'
import { Field, Input, Select } from '../../../components/ui/form'
import { Switch } from '../../../components/ui/Switch'

const DURATION_PRESETS = [30, 60, 120, 300]
const MIN_DURATION = 10
const MAX_DURATION = 3600

type DraftStep = { uid: string; label: string; layout_id: string; duration_s: number; camera_ids: number[] }
type Draft = { id: number | null; revision?: number; name: string; enabled: boolean; steps: DraftStep[] }

let uidSeq = 0
const uid = () => `s${++uidSeq}`
const newStep = (layout_id = 'grid:5x4'): DraftStep => ({ uid: uid(), label: '', layout_id, duration_s: 60, camera_ids: [] })

const displayUrl = (id: number) => `${window.location.origin}/live/tour/${id}`

function toInput(d: Draft): TourInput {
  return {
    name: d.name.trim(),
    enabled: d.enabled,
    steps: d.steps.map((s) => ({ label: s.label.trim(), layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: s.camera_ids })),
    ...(d.id != null && d.revision != null ? { expected_revision: d.revision } : {}),
  }
}

function fromTour(tour: Tour, copy = false): Draft {
  return {
    id: copy ? null : tour.id,
    revision: copy ? undefined : tour.revision,
    name: copy ? `${tour.name} (copy)` : tour.name,
    enabled: tour.enabled,
    steps: tour.steps.map((s) => ({ uid: uid(), label: s.label, layout_id: s.layout_id, duration_s: s.duration_s, camera_ids: [...s.camera_ids] })),
  }
}

export function CameraTours() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { showSuccess, showError } = useSnackbar()
  const { hasPermission } = usePermissions()
  const canManage = hasPermission('cameras.manage')
  const [draft, setDraft] = useState<Draft | null>(null)

  const tours = useQuery({
    queryKey: ['tours'],
    queryFn: async () => ((await apiService.getTours()).data?.tours ?? []) as Tour[],
  })
  const windowSettings = useQuery({
    queryKey: ['window-settings'],
    queryFn: async () => (await apiService.getWindowSettings()).data as WindowLayoutSettings,
    staleTime: 5 * 60_000,
  })
  const cams = useCameras({ active_only: false })
  const camById = useMemo(() => new Map((cams.data?.cameras ?? []).map((c) => [c.id, c])), [cams.data])
  const resolve = (lid: string) => resolveLayout(lid, windowSettings.data)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tours'] })
    qc.invalidateQueries({ queryKey: ['tour'] })
  }

  const toggleEnabled = async (tour: Tour) => {
    try {
      await apiService.updateTour(tour.id, { ...toInput(fromTour(tour)), enabled: !tour.enabled })
      refresh()
    } catch (e: any) {
      showError(e?.status === 409 ? t('tours.conflict') : e?.message || t('tours.saveFailed'))
      refresh()
    }
  }

  const remove = async (tour: Tour) => {
    const ok = await confirm({
      title: t('tours.deleteTitle', { name: tour.name }),
      message: t('tours.deleteMessage'),
      confirmLabel: t('tours.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await apiService.deleteTour(tour.id)
      showSuccess(t('tours.deleted', { name: tour.name }))
      refresh()
    } catch (e: any) {
      showError(e?.message || t('tours.deleteFailed'))
    }
  }

  const copyUrl = async (tour: Tour) => {
    try {
      await navigator.clipboard.writeText(displayUrl(tour.id))
      showSuccess(t('tours.urlCopied'))
    } catch {
      showError(t('tours.urlCopyFailed', { url: displayUrl(tour.id) }))
    }
  }

  return (
    <div className="space-y-4" data-testid="camera-tours">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold flex items-center gap-2"><Route size={18} /> {t('settings.cameraTours')}</h2>
          <p className="mt-1 text-xs text-[var(--text-dim)] max-w-2xl">{t('tours.description')}</p>
        </div>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setDraft({ id: null, name: '', enabled: true, steps: [newStep()] })}>
            <Plus size={14} /> {t('tours.new')}
          </Button>
        )}
      </div>

      {tours.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div>
      ) : tours.isError ? (
        <ErrorCard message={(tours.error as any)?.message || t('tours.loadFailed')} onRetry={() => tours.refetch()} />
      ) : tours.data.length === 0 ? (
        <div className="border border-[var(--border)] bg-[var(--panel-2)]">
          <EmptyState
            icon={<Route size={28} />}
            title={t('tours.emptyTitle')}
            description={t('tours.emptyDescription')}
            action={canManage ? (
              <Button variant="primary" size="sm" onClick={() => setDraft({ id: null, name: '', enabled: true, steps: [newStep()] })}>
                <Plus size={14} /> {t('tours.new')}
              </Button>
            ) : undefined}
          />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {tours.data.map((tour) => {
            const pages = buildPages(tour.steps, resolve)
            const locked = !tour.editable
            return (
              <div
                key={tour.id}
                data-testid="tour-card"
                className={clsx('border border-[var(--border)] bg-[var(--panel-2)] p-3 flex flex-col gap-2', !tour.enabled && 'opacity-70')}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{tour.name}</div>
                    <div className="text-[11px] text-[var(--text-dim)] font-mono tabular-nums">
                      {t('tours.summary', { steps: tour.steps.length, cycle: formatDuration(cycleSeconds(pages)) })}
                    </div>
                  </div>
                  {canManage && (
                    <Switch
                      checked={tour.enabled}
                      onChange={() => toggleEnabled(tour)}
                      disabled={locked}
                      label={tour.enabled ? t('tours.turnOff', { name: tour.name }) : t('tours.turnOn', { name: tour.name })}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {tour.steps.map((s, i) => (
                    <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 border', s.layout_missing ? 'border-[var(--warn)] text-[var(--warn)]' : 'border-[var(--border)] text-[var(--text-dim)]')}
                      title={s.layout_missing ? t('tours.layoutMissingHint') : undefined}>
                      {(s.label || t('tours.stepN', { n: i + 1 }))} · {s.camera_ids.length}
                    </span>
                  ))}
                </div>
                {locked && (
                  <div className="flex items-center gap-1 text-[11px] text-[var(--text-dim)]"><Lock size={11} /> {t('tours.readOnly')}</div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                  <Button size="sm" variant="outline" onClick={() => window.open(`/live/tour/${tour.id}`, '_blank', 'noopener')} disabled={!tour.enabled}>
                    <ExternalLink size={12} /> {t('tours.run')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copyUrl(tour)} title={displayUrl(tour.id)}>
                    <Copy size={12} /> {t('tours.copyUrl')}
                  </Button>
                  {canManage && (
                    <span className="ml-auto flex items-center gap-1">
                      <IconAction label={t('tours.edit')} onClick={() => setDraft(fromTour(tour))} disabled={locked}><Pencil size={13} /></IconAction>
                      <IconAction label={t('tours.duplicate')} onClick={() => setDraft(fromTour(tour, true))}><CopyPlus size={13} /></IconAction>
                      <IconAction label={t('tours.delete')} onClick={() => remove(tour)} disabled={locked} danger><Trash2 size={13} /></IconAction>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {draft && (
        <TourEditor
          initial={draft}
          cameras={cams.data?.cameras ?? []}
          camById={camById}
          windowSettings={windowSettings.data}
          onClose={() => setDraft(null)}
          onSaved={(name) => { setDraft(null); refresh(); showSuccess(t('tours.saved', { name })) }}
        />
      )}
    </div>
  )
}

function IconAction({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx('p-1.5 border border-transparent disabled:opacity-40 disabled:cursor-not-allowed',
        danger ? 'text-[var(--danger)] hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]' : 'text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--panel)]')}
    >
      {children}
    </button>
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

function TourEditor({ initial, cameras, camById, windowSettings, onClose, onSaved }: {
  initial: Draft
  cameras: CameraItem[]
  camById: Map<number, CameraItem>
  windowSettings: WindowLayoutSettings | undefined
  onClose: () => void
  onSaved: (name: string) => void
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [draft, setDraft] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [badCameras, setBadCameras] = useState<Set<number>>(new Set())
  const [badLayouts, setBadLayouts] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)
  const dirty = JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(initial))

  const options = useMemo(() => layoutOptions(windowSettings), [windowSettings])
  const resolve = (lid: string) => resolveLayout(lid, windowSettings)
  const pages = buildPages(draft.steps.map((s) => ({ ...s })), resolve)

  const nameError = touched && !draft.name.trim() ? t('tours.nameRequired') : undefined
  const emptySteps = draft.steps.filter((s) => s.camera_ids.length === 0).length
  const canSave = !!draft.name.trim() && draft.steps.length > 0 && emptySteps === 0 && !saving

  const setStep = (uidKey: string, patch: Partial<DraftStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.uid === uidKey ? { ...s, ...patch } : s)) }))
  const moveStep = (i: number, delta: number) =>
    setDraft((d) => {
      const steps = [...d.steps]
      const j = i + delta
      if (j < 0 || j >= steps.length) return d
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
      return { ...d, steps }
    })

  const close = async () => {
    if (dirty && !(await confirm({ title: t('tours.discardTitle'), message: t('tours.discardMessage'), confirmLabel: t('tours.discard'), danger: true }))) return
    onClose()
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
      onSaved(draft.name.trim())
    } catch (e: any) {
      const detail = e?.data?.detail
      if (e?.status === 409) setError(t('tours.conflict'))
      else if (e?.status === 422 && Array.isArray(detail?.camera_ids)) {
        setBadCameras(new Set(detail.camera_ids))
        setError(t('tours.badCameras', { names: detail.camera_ids.map((id: number) => camById.get(id)?.name ?? `#${id}`).join(', ') }))
      } else if (e?.status === 422 && Array.isArray(detail?.layout_ids)) {
        setBadLayouts(new Set(detail.layout_ids))
        setError(t('tours.badLayouts'))
      } else setError(typeof detail === 'string' ? detail : e?.message || t('tours.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title={draft.id == null ? t('tours.newTitle') : t('tours.editTitle', { name: initial.name })}
      onClose={close}
      closeOnBackdrop={false}
      widthClassName="w-[calc(100vw-2rem)] max-w-5xl"
      footer={(
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--text-dim)] font-mono tabular-nums" data-testid="tour-cycle">
            {t('tours.cycleSummary', { steps: draft.steps.length, pages: pages.length, cycle: formatDuration(cycleSeconds(pages)) })}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={close}>{t('tours.cancel')}</Button>
            <Button variant="primary" onClick={save} disabled={saving || (touched && !canSave)}>{saving ? t('tours.saving') : t('tours.save')}</Button>
          </span>
        </div>
      )}
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="text-sm text-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] border border-[color-mix(in_oklab,var(--danger)_45%,var(--border))] p-2">{error}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] items-end">
          <Field label={t('tours.name')} required error={nameError} htmlFor="tour-name">
            <Input id="tour-name" value={draft.name} maxLength={100} autoFocus placeholder={t('tours.namePlaceholder')}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onBlur={() => setTouched(true)} />
          </Field>
          <label className="flex items-center gap-2 text-sm pb-1.5">
            <Switch checked={draft.enabled} onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} label={t('tours.enabled')} />
            {t('tours.enabled')}
          </label>
        </div>

        <div className="space-y-3">
          {draft.steps.map((s, i) => (
            <StepEditor
              key={s.uid}
              index={i}
              count={draft.steps.length}
              step={s}
              layout={resolve(s.layout_id)}
              options={options}
              cameras={cameras}
              camById={camById}
              badCameras={badCameras}
              badLayout={badLayouts.has(s.layout_id)}
              showErrors={touched}
              onChange={(patch) => setStep(s.uid, patch)}
              onMove={(delta) => moveStep(i, delta)}
              onDuplicate={() => setDraft((d) => {
                const steps = [...d.steps]
                steps.splice(i + 1, 0, { ...s, uid: uid(), camera_ids: [...s.camera_ids] })
                return { ...d, steps }
              })}
              onRemove={() => setDraft((d) => ({ ...d, steps: d.steps.filter((x) => x.uid !== s.uid) }))}
            />
          ))}
          <Button variant="outline" size="sm" onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, newStep(d.steps[d.steps.length - 1]?.layout_id)] }))}>
            <Plus size={14} /> {t('tours.addStep')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function StepEditor({ index, count, step, layout, options, cameras, camById, badCameras, badLayout, showErrors, onChange, onMove, onDuplicate, onRemove }: {
  index: number
  count: number
  step: DraftStep
  layout: LayoutDefinition | null
  options: ReturnType<typeof layoutOptions>
  cameras: CameraItem[]
  camById: Map<number, CameraItem>
  badCameras: Set<number>
  badLayout: boolean
  showErrors: boolean
  onChange: (patch: Partial<DraftStep>) => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const [picking, setPicking] = useState(step.camera_ids.length === 0)
  const tiles = layout?.tiles.length ?? 0
  const pages = tiles ? Math.ceil(step.camera_ids.length / tiles) : 0
  const known = [...options.builtIn, ...options.grids, ...options.custom].some((o) => o.id === step.layout_id)
  const custom = !DURATION_PRESETS.includes(step.duration_s)

  return (
    <section className="border border-[var(--border)] bg-[var(--panel-2)]" data-testid="tour-step-editor" aria-label={t('tours.stepN', { n: index + 1 })}>
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-2)_55%,var(--panel-2))]">
        <span className="text-xs font-semibold text-[var(--text-dim)] font-mono">{index + 1}</span>
        <span className="text-sm font-medium truncate">{step.label || t('tours.stepN', { n: index + 1 })}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconAction label={t('tours.moveUp')} onClick={() => onMove(-1)} disabled={index === 0}><ArrowUp size={13} /></IconAction>
          <IconAction label={t('tours.moveDown')} onClick={() => onMove(1)} disabled={index === count - 1}><ArrowDown size={13} /></IconAction>
          <IconAction label={t('tours.duplicateStep')} onClick={onDuplicate}><CopyPlus size={13} /></IconAction>
          <IconAction label={t('tours.removeStep')} onClick={onRemove} disabled={count === 1} danger><Trash2 size={13} /></IconAction>
        </span>
      </header>
      <div className="p-3 space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_minmax(0,14rem)]">
          <Field label={t('tours.stepLabel')} hint={t('tours.stepLabelHint')}>
            <Input value={step.label} maxLength={60} placeholder={t('tours.stepLabelPlaceholder')} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
          <Field label={t('tours.layout')} error={badLayout || !known ? t('tours.layoutUnavailable') : undefined}>
            <div className="flex items-center gap-2">
              <Select value={step.layout_id} onChange={(e) => onChange({ layout_id: e.target.value })} className="flex-1 min-w-0">
                {!known && <option value={step.layout_id}>{t('tours.layoutGone', { id: step.layout_id })}</option>}
                <optgroup label={t('tours.layoutsGrids')}>
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
              {layout && <LayoutPreview layout={layout} />}
            </div>
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

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">{t('tours.cameras')}</span>
            <span className={clsx('text-xs font-mono tabular-nums', step.camera_ids.length === 0 && showErrors ? 'text-[var(--danger)]' : 'text-[var(--text-dim)]')} data-testid="tour-step-capacity">
              {step.camera_ids.length === 0
                ? t('tours.noCamerasYet')
                : pages > 1
                  ? t('tours.pagesOf', { count: step.camera_ids.length, pages, per: tiles })
                  : t('tours.tilesUsed', { count: step.camera_ids.length, tiles })}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {step.camera_ids.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => onChange({ camera_ids: [] })}>{t('tours.clearCameras')}</Button>
              )}
              <Button size="sm" variant={picking ? 'default' : 'outline'} onClick={() => setPicking((p) => !p)}>
                {picking ? t('tours.donePicking') : <><Plus size={12} /> {t('tours.addCameras')}</>}
              </Button>
            </span>
          </div>

          {step.camera_ids.length > 0 && (
            <ol className="flex flex-wrap gap-1" aria-label={t('tours.selectedCameras')}>
              {step.camera_ids.map((cid, i) => {
                const cam = camById.get(cid)
                const pageBreak = tiles > 0 && i > 0 && i % tiles === 0
                return (
                  <li key={cid} className="flex items-center gap-1">
                    {pageBreak && <span className="text-[10px] text-[var(--text-dim)] px-1" aria-hidden="true">│</span>}
                    <span className={clsx('inline-flex items-center gap-1 text-xs pl-1.5 pr-0.5 py-0.5 border',
                      badCameras.has(cid) ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--border)] bg-[var(--panel)]')}>
                      <span className="font-mono text-[10px] text-[var(--text-dim)]">{i + 1}</span>
                      <span className="max-w-[12rem] truncate">{cam?.name ?? `#${cid}`}</span>
                      <button type="button" className="p-0.5 hover:text-[var(--danger)]" aria-label={t('tours.removeCamera', { name: cam?.name ?? `#${cid}` })}
                        onClick={() => onChange({ camera_ids: step.camera_ids.filter((x) => x !== cid) })}>
                        <X size={11} />
                      </button>
                    </span>
                  </li>
                )
              })}
            </ol>
          )}

          {picking && (
            <CameraPicker
              cameras={cameras}
              selected={step.camera_ids}
              onChange={(ids) => {
                // An unnamed step whose cameras share one location is named after it.
                const locs = new Set(ids.map((id) => camById.get(id)?.location?.trim()).filter(Boolean))
                onChange(!step.label && locs.size === 1 ? { camera_ids: ids, label: [...locs][0] as string } : { camera_ids: ids })
              }}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function LayoutPreview({ layout }: { layout: LayoutDefinition }) {
  return (
    <div
      className="shrink-0 w-12 aspect-video bg-[var(--bg)] p-[2px]"
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

function CameraPicker({ cameras, selected, onChange }: { cameras: CameraItem[]; selected: number[]; onChange: (ids: number[]) => void }) {
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
    <div className="border border-[var(--border)] bg-[var(--panel)]" data-testid="tour-camera-picker">
      <div className="flex flex-wrap items-center gap-2 p-2 border-b border-[var(--border)]">
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tours.searchCameras')} className="pl-7" aria-label={t('tours.searchCameras')} />
        </div>
        <div className="w-56 shrink-0">
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
      {shown.length === 0 ? (
        <div className="p-3 text-xs text-[var(--text-dim)]">{t('tours.noCamerasMatch')}</div>
      ) : (
        <ul className="max-h-64 overflow-auto divide-y divide-[var(--border)]">
          {shown.map((c) => (
            <li key={c.id}>
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-[var(--panel-2)]">
                <input type="checkbox" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
                <span className="truncate flex-1">{c.name}</span>
                {c.location && <span className="text-[var(--text-dim)] truncate max-w-[10rem]">{c.location}</span>}
                {!c.is_active && <span className="text-[10px] text-[var(--text-dim)] uppercase">{t('tours.cameraPaused')}</span>}
                <span className="font-mono text-[10px] text-[var(--text-dim)]">{c.ip_address}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
