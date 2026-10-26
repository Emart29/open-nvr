// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Route } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../../i18n'
import { apiService } from '../../lib/apiService'
import { useClickOutside } from '../../hooks/useClickOutside'
import { usePermissions } from '../../hooks/usePermissions'
import { resolveLayout, type WindowLayoutSettings } from '../../lib/liveLayouts'
import { buildPages, cycleSeconds, formatDuration } from '../../lib/tourPlan'
import type { Tour } from '../../services/tourService'

export const TOURS_SETTINGS_PATH = '/settings/more-settings/camera-tours'

/**
 * Live View's "Tours" button: start a tour on this screen, or go and set
 * one up. Hidden for someone who has no tour to run and may not make one.
 */
export function ToursMenu({ dropUp = false }: { dropUp?: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { hasPermission } = usePermissions()
  const canManage = hasPermission('cameras.manage')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, open, () => setOpen(false))

  const tours = useQuery({
    queryKey: ['tours'],
    queryFn: async () => ((await apiService.getTours()).data?.tours ?? []) as Tour[],
    staleTime: 60_000,
  })
  const windowSettings = useQuery({
    queryKey: ['window-settings'],
    queryFn: async () => (await apiService.getWindowSettings()).data as WindowLayoutSettings,
    staleTime: 5 * 60_000,
    enabled: open,
  })

  const runnable = useMemo(() => (tours.data ?? []).filter((x) => x.enabled), [tours.data])
  if (!canManage && runnable.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('tours.menu')}
        className={clsx(
          'h-5 px-1.5 inline-flex items-center gap-1 text-[10px] leading-none border',
          open
            ? 'border-[var(--accent)] text-[var(--accent)]'
            : 'border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--panel)]',
        )}
      >
        <Route size={12} aria-hidden="true" />
        <span className="hidden sm:inline">{t('tours.menu')}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-50 bg-[var(--panel)] border border-[var(--border)] shadow-lg min-w-[220px] max-w-[320px] ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          {runnable.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--text-dim)]">{tours.isPending ? t('tours.loading') : t('tours.noneYet')}</div>
          ) : (
            runnable.map((tour) => {
              const pages = buildPages(tour.steps, (lid) => resolveLayout(lid, windowSettings.data))
              const steps = new Set(pages.map((p) => p.stepIndex)).size
              return (
                <button
                  key={tour.id}
                  type="button"
                  role="menuitem"
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--panel-2)]"
                  onClick={() => { setOpen(false); navigate(`/live/tour/${tour.id}`) }}
                >
                  <div className="text-xs text-[var(--text)] truncate">{tour.name}</div>
                  <div className="text-[10px] text-[var(--text-dim)] font-mono tabular-nums">
                    {t('tours.summary', { steps, cycle: formatDuration(cycleSeconds(pages)) })}
                  </div>
                </button>
              )
            })
          )}
          {canManage && (
            <div className="border-t border-[var(--border)] px-3 py-1.5">
              <button
                type="button"
                role="menuitem"
                className="text-xs text-[var(--text-dim)] hover:text-[var(--accent)]"
                onClick={() => { setOpen(false); navigate(TOURS_SETTINGS_PATH) }}
              >
                ⚙ {t('tours.manage')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
