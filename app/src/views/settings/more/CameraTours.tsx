// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings › More Settings › Camera Tours: the tours a display board cycles
 * through (views/TourView.tsx runs them, views/TourEditor.tsx edits them,
 * routers/tours.py stores them). Each card runs its tour on a display, copies
 * the display link, switches it on or off, or opens it in the editor.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { BellRing, Copy, CopyPlus, ExternalLink, Lock, Pencil, Plus, Route, Trash2 } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../../../i18n'
import { apiService } from '../../../lib/apiService'
import { resolveLayout, type WindowLayoutSettings } from '../../../lib/liveLayouts'
import { buildPages, cycleSeconds, formatDuration } from '../../../lib/tourPlan'
import type { Tour } from '../../../services/tourService'
import { usePermissions } from '../../../hooks/usePermissions'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { useSnackbar } from '../../../components/Snackbar'
import { Button, EmptyState, ErrorCard, Skeleton } from '../../../components/ui'
import { Switch } from '../../../components/ui/Switch'
import { IconAction } from '../../../components/live/IconAction'

/** The bare display route: the tour with no app shell around it (main.tsx). */
const displayPath = (id: number) => `/display/tour/${id}`
const displayUrl = (id: number) => `${window.location.origin}${displayPath(id)}`

export function CameraTours() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { showSuccess, showError } = useSnackbar()
  const { hasPermission } = usePermissions()
  const canManage = hasPermission('cameras.manage')

  const tours = useQuery({
    queryKey: ['tours'],
    queryFn: async () => ((await apiService.getTours()).data?.tours ?? []) as Tour[],
  })
  const windowSettings = useQuery({
    queryKey: ['window-settings'],
    queryFn: async () => (await apiService.getWindowSettings()).data as WindowLayoutSettings,
    staleTime: 5 * 60_000,
  })
  const resolve = (lid: string) => resolveLayout(lid, windowSettings.data)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tours'] })
    qc.invalidateQueries({ queryKey: ['tour'] })
  }

  const toggleEnabled = async (tour: Tour) => {
    try {
      // PATCH, not a re-save of this filtered copy: that would fail on a
      // deleted layout and drop the cameras now in the bin.
      await apiService.setTourEnabled(tour.id, { enabled: !tour.enabled, expected_revision: tour.revision })
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

  const newTour = () => navigate('/tours/new')

  return (
    <div className="space-y-4" data-testid="camera-tours">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold flex items-center gap-2"><Route size={18} /> {t('settings.cameraTours')}</h2>
          <p className="mt-1 text-xs text-[var(--text-dim)] max-w-2xl">{t('tours.description')}</p>
        </div>
        {canManage && (
          <Button variant="primary" size="sm" onClick={newTour}>
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
              <Button variant="primary" size="sm" onClick={newTour}>
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
                  {tour.settings?.alerts.enabled && (
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 border border-[color-mix(in_oklab,var(--danger)_45%,var(--border))] text-[var(--danger)]">
                      <BellRing size={10} aria-hidden="true" /> {t('tours.alertsOnChip')}
                    </span>
                  )}
                </div>
                {locked && (
                  <div className="flex items-center gap-1 text-[11px] text-[var(--text-dim)]"><Lock size={11} /> {t('tours.readOnly')}</div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                  <Button size="sm" variant="outline" onClick={() => window.open(displayPath(tour.id), '_blank', 'noopener')} disabled={!tour.enabled}>
                    <ExternalLink size={12} /> {t('tours.run')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => copyUrl(tour)} title={displayUrl(tour.id)}>
                    <Copy size={12} /> {t('tours.copyUrl')}
                  </Button>
                  {canManage && (
                    <span className="ml-auto flex items-center gap-1">
                      <IconAction label={t('tours.edit')} onClick={() => navigate(`/tours/${tour.id}/edit`)} disabled={locked}><Pencil size={13} /></IconAction>
                      <IconAction label={t('tours.duplicate')} onClick={() => navigate(`/tours/new?from=${tour.id}`)}><CopyPlus size={13} /></IconAction>
                      <IconAction label={t('tours.delete')} onClick={() => remove(tour)} disabled={locked} danger><Trash2 size={13} /></IconAction>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
