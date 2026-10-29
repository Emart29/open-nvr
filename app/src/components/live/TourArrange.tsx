// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Arrange mode of a running wall (views/TourView.tsx): the page the wall
 * was showing, laid out exactly as it was, from stills, next to a camera
 * search. Remove a camera, drag tiles onto each other to swap them, and put
 * a camera on a tile by dragging it there or by clicking the tile, then the
 * camera. The list edits themselves are lib/tourArrange.ts.
 */

import { useMemo, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { Search, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useTranslation } from '../../i18n'
import type { CameraItem } from '../../lib/queries'
import type { LayoutDefinition } from '../../lib/liveLayouts'
import { camerasOf, type Slot } from '../../lib/tourPlan'
import { firstEmpty, placeMessage } from '../../lib/tourArrange'
import { Input, Select } from '../ui/form'
import { CameraThumb } from './CameraThumb'

const NO_LOCATION = '\u0000none'
const slotId = (i: number) => `slot:${i}`
const pickId = (cam: number) => `pick:${cam}`

export function ArrangeBoard({ layout, pageIds, cameras, camById, cover, labelClass, target, onTarget, onRemove, onMove, onPlace }: {
  layout: LayoutDefinition
  /** The cameras on this page, in tile order; null is an empty tile. */
  pageIds: Slot[]
  cameras: CameraItem[]
  camById: Map<number, CameraItem>
  cover: boolean
  labelClass: string
  /** The tile (0-based) a clicked camera goes to. */
  target: number | null
  onTarget: (slot: number | null) => void
  /** Positions below are tiles of this page. */
  onRemove: (at: number) => void
  onMove: (from: number, to: number) => void
  onPlace: (cam: number, at: number) => void
}) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const [dragging, setDragging] = useState<number | null>(null)
  // What the last placement did ("was already on tile 2…"), until the next action.
  const [notice, setNotice] = useState<string | null>(null)
  const nameOf = (id: number) => camById.get(id)?.name ?? t('tours.cameraN', { id })
  const tiles = layout.tiles.length
  const place = (cam: number, at: number) => {
    setNotice(placeMessage(t, pageIds, cam, at, nameOf, tiles))
    onPlace(cam, at)
  }
  const lastCamera = camerasOf(pageIds).length <= 1
  const firstFree = firstEmpty(pageIds, tiles)

  const onDragStart = ({ active }: DragStartEvent) => {
    const [kind, n] = String(active.id).split(':')
    setDragging(kind === 'pick' ? Number(n) : pageIds[Number(n)] ?? null)
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return
    const to = Number(String(over.id).split(':')[1])
    const [kind, n] = String(active.id).split(':')
    if (kind === 'pick') place(Number(n), to)
    else { setNotice(null); onMove(Number(n), to) }
    onTarget(null)
  }

  // A camera clicked in the list goes to the chosen tile, or to the first
  // empty one; a full page with no tile chosen says to choose one.
  const [nudge, setNudge] = useState(false)
  const pick = (cam: number) => {
    const slot = target ?? firstFree
    if (slot == null) { setNudge(true); setNotice(null); return }
    place(cam, slot)
    onTarget(null)
    setNudge(false)
  }

  const hint = target != null
    ? t('tours.arrangeTarget', { n: target + 1 })
    : nudge ? t('tours.arrangeChooseTile') : notice ?? t('tours.arrangeHint')

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="absolute inset-0 flex" data-testid="tour-arrange">
        <div className="relative flex-1 min-w-0">
          <div
            className="absolute inset-0 grid gap-px bg-[#1a1f29]"
            style={{ gridTemplateColumns: `repeat(${layout.gridCols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.gridRows}, minmax(0, 1fr))` }}
          >
            {layout.tiles.map((tile, i) => {
              const area = { gridRow: `${tile.row + 1} / span ${tile.rowSpan}`, gridColumn: `${tile.col + 1} / span ${tile.colSpan}` }
              const cid = pageIds[i]
              return (
                <ArrangeTile key={cid != null ? `cam-${cid}` : `empty-${i}`} slot={i} order={i + 1} area={area}
                  cameraId={cid ?? undefined} cam={cid != null ? camById.get(cid) : undefined} cover={cover} labelClass={labelClass}
                  selected={target === i} canRemove={!lastCamera}
                  onSelect={() => { onTarget(target === i ? null : i); setNudge(false); setNotice(null) }}
                  onRemove={() => { onRemove(i); onTarget(null); setNotice(null) }} />
              )
            })}
          </div>
        </div>
        <ArrangePicker cameras={cameras} pageIds={pageIds} hint={hint} urgent={nudge || target != null || notice != null} onPick={pick} />
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging != null && (
          <div className="flex items-center gap-2 w-56 p-1 pr-2 text-xs text-white bg-black/85 border border-[var(--accent)] shadow-lg">
            <CameraThumb cameraId={dragging} alt="" className="w-14 aspect-video shrink-0" />
            <span className="truncate">{camById.get(dragging)?.name ?? t('tours.cameraN', { id: dragging })}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}

function ArrangeTile({ slot, order, area, cameraId, cam, cover, labelClass, selected, canRemove, onSelect, onRemove }: {
  slot: number
  order: number
  area: React.CSSProperties
  cameraId: number | undefined
  cam: CameraItem | undefined
  cover: boolean
  labelClass: string
  selected: boolean
  canRemove: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const drop = useDroppable({ id: slotId(slot) })
  const drag = useDraggable({ id: slotId(slot), disabled: cameraId == null })
  const ref = (el: HTMLElement | null) => { drop.setNodeRef(el); drag.setNodeRef(el) }
  const name = cameraId != null ? cam?.name ?? t('tours.cameraN', { id: cameraId }) : ''
  const label = cameraId != null ? t('tours.arrangeTile', { n: order, name }) : t('tours.arrangeEmptyTile', { n: order })

  return (
    <div style={area} className={clsx('relative min-w-0 min-h-0 overflow-hidden', cameraId == null && 'border border-dashed border-white/15 bg-[#0b0f16]')}>
      <div
        ref={ref}
        {...drag.listeners}
        {...drag.attributes}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onSelect() } }}
        className={clsx('absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:-outline-offset-2',
          cameraId != null ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer hover:bg-white/5',
          drag.isDragging && 'opacity-40')}
        data-testid="tour-arrange-tile"
        data-camera-id={cameraId}
      >
        {cameraId != null && (
          <CameraThumb cameraId={cameraId} alt={name} className={clsx('absolute inset-0', !cover && '[&_img]:object-contain')} />
        )}
      </div>
      {/* Where a drop or a picked camera would land. */}
      <div className={clsx('pointer-events-none absolute inset-0 z-10',
        selected ? 'ring-4 ring-inset ring-[var(--accent)]' : drop.isOver && 'ring-2 ring-inset ring-[var(--accent)] bg-[var(--accent)]/15')} />
      <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 px-1 text-[11px] font-mono text-white bg-black/60">{order}</span>
      {cameraId != null && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/80 to-transparent" />
          <span className={clsx(labelClass, 'pointer-events-none absolute left-2 right-2 bottom-1.5 font-semibold text-white truncate [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]')}>{name}</span>
          <button
            type="button"
            onClick={onRemove}
            disabled={!canRemove}
            className="absolute right-1.5 top-1.5 z-20 p-1 text-white bg-black/65 hover:bg-[var(--danger)] border border-white/20 disabled:opacity-40 disabled:hover:bg-black/65 disabled:cursor-not-allowed"
            aria-label={canRemove ? t('tours.removeCamera', { name }) : t('tours.arrangeLastCamera')}
            title={canRemove ? t('tours.removeCamera', { name }) : t('tours.arrangeLastCamera')}
          >
            <X size={13} />
          </button>
        </>
      )}
      {cameraId == null && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-white/35">{t('tours.arrangeAddHere')}</span>
      )}
    </div>
  )
}

function ArrangePicker({ cameras, pageIds, hint, urgent, onPick }: {
  cameras: CameraItem[]
  pageIds: Slot[]
  hint: string
  urgent: boolean
  onPick: (cam: number) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [location, setLocation] = useState('')
  const onPage = useMemo(() => new Map(pageIds.flatMap((id, i) => (id == null ? [] : [[id, i] as const]))), [pageIds])

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

  return (
    <aside className="w-72 xl:w-80 shrink-0 flex flex-col min-h-0 border-l border-[var(--border)] bg-[var(--panel)] text-[var(--text)]" aria-label={t('tours.addCameras')} data-testid="tour-arrange-picker">
      <div className="space-y-2 p-2 border-b border-[var(--border)]">
        <p className={clsx('text-xs', urgent ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-dim)]')} role="status">{hint}</p>
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-dim)]" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('tours.searchCameras')} className="pl-7" aria-label={t('tours.searchCameras')} />
        </div>
        <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label={t('tours.location')}>
          <option value="">{t('tours.allLocations', { count: cameras.length })}</option>
          {locations.map(([loc, n]) => <option key={loc} value={loc}>{loc === NO_LOCATION ? t('tours.noLocation') : loc} ({n})</option>)}
        </Select>
      </div>
      {shown.length === 0 ? (
        <div className="p-3 text-xs text-[var(--text-dim)]">{t('tours.noCamerasMatch')}</div>
      ) : (
        <ul className="flex-1 min-h-0 overflow-auto divide-y divide-[var(--border)]">
          {shown.map((c) => {
            const at = onPage.get(c.id)
            const where = at == null ? null : t('tours.arrangeOnTile', { n: at + 1 })
            return <PickRow key={c.id} cam={c} where={where} here={at != null} onPick={() => onPick(c.id)} />
          })}
        </ul>
      )}
    </aside>
  )
}

function PickRow({ cam, where, here, onPick }: { cam: CameraItem; where: string | null; here: boolean; onPick: () => void }) {
  const { t } = useTranslation()
  const drag = useDraggable({ id: pickId(cam.id) })
  return (
    <li className={clsx(here && 'bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]')}>
      <button
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        type="button"
        onClick={onPick}
        className={clsx('flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--panel-2)] cursor-grab active:cursor-grabbing', drag.isDragging && 'opacity-40')}
        title={t('tours.arrangePick', { name: cam.name })}
        data-testid="tour-arrange-pick"
      >
        <CameraThumb cameraId={cam.id} alt={cam.name} className="w-16 aspect-video shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{cam.name}</span>
          <span className="block truncate text-[10px] text-[var(--text-dim)]">
            {where ?? [cam.location, cam.ip_address].filter(Boolean).join(' · ')}
            {!cam.is_active && ` · ${t('tours.cameraPaused')}`}
          </span>
        </span>
      </button>
    </li>
  )
}
