// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The schedule of a Live View tour, as pure functions so it can be tested
 * without a browser (app/tests/tourPlan.test.mjs).
 *
 * A tour is steps; a step is a camera list shown on one layout for
 * `duration_s`. A step with more cameras than its layout has tiles pages
 * through them, each page for the full duration — "North, all 60 cameras,
 * 20 at a time" is one step. A step's list is in tile order and may hold
 * empty tiles (null): taking a camera out leaves a gap, it never moves the
 * others. Steps with no camera the viewer may see are skipped, and a step
 * whose layout no longer exists falls back to an automatic grid.
 */

import type { LayoutDefinition, LayoutTile } from './liveLayouts'

/** A tile's camera, or null for a tile left empty. */
export type Slot = number | null

/** The cameras of a step's tile list, empty tiles left out. */
export const camerasOf = (ids: readonly Slot[]): number[] => ids.filter((c): c is number => c != null)

/** A step as GET /api/v1/tours/{id} returns it, already filtered to the viewer. */
export interface TourStep {
  label: string
  layout_id: string
  duration_s: number
  /** In tile order across the step's pages; null is an empty tile. */
  camera_ids: Slot[]
  paused_camera_ids?: number[]
  hidden_count?: number
  layout_missing?: boolean
}

export interface TourPage {
  /** Stable across refetches of an unchanged tour, so the timer is not reset. */
  key: string
  stepIndex: number
  /** 0-based page within the step, and how many pages the step has. */
  page: number
  pages: number
  label: string
  layout: LayoutDefinition
  /** True when the step's layout is gone and an automatic grid stands in. */
  layoutFallback: boolean
  /** One per tile, in tile order: null (or missing, past the end) is empty. */
  cameraIds: Slot[]
  durationMs: number
}

/** The automatic grid never grows past 5×5: beyond that tiles are too small to watch. */
export const AUTO_GRID_MAX = 25

/** A near-square grid for n cameras (1..AUTO_GRID_MAX), widest first. */
export function autoGrid(n: number): LayoutDefinition {
  const count = Math.min(Math.max(1, Math.floor(n) || 1), AUTO_GRID_MAX)
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const tiles: LayoutTile[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ row: r, col: c, rowSpan: 1, colSpan: 1 })
  return { name: `${cols}×${rows}`, gridCols: cols, gridRows: rows, tiles }
}

/**
 * Every page of the tour in play order. `resolve` maps a layout id to its
 * definition, or null when Live View no longer offers that layout. A page
 * of empty tiles only is left out of a running tour; the editor keeps it
 * (`keepEmptyPages`) so cameras can still be put on it.
 */
export function buildPages(
  steps: readonly TourStep[],
  resolve: (layoutId: string) => LayoutDefinition | null,
  { keepEmptyPages = false }: { keepEmptyPages?: boolean } = {},
): TourPage[] {
  const out: TourPage[] = []
  steps.forEach((step, stepIndex) => {
    const ids = step.camera_ids ?? []
    if (camerasOf(ids).length === 0) return
    const resolved = step.layout_missing ? null : resolve(step.layout_id)
    const layout = resolved && resolved.tiles.length > 0 ? resolved : autoGrid(ids.length)
    const per = layout.tiles.length
    const pages = Math.ceil(ids.length / per)
    const durationMs = Math.max(1, step.duration_s) * 1000
    for (let page = 0; page < pages; page++) {
      const cameraIds = ids.slice(page * per, page * per + per)
      if (!keepEmptyPages && camerasOf(cameraIds).length === 0) continue
      out.push({
        key: `${stepIndex}:${page}:${step.layout_id}:${cameraIds.join(',')}`,
        stepIndex,
        page,
        pages,
        label: step.label,
        // Always the layout as chosen, tiles without a camera left empty: the
        // editor's preview draws these same pages, so what the admin arranges
        // is exactly what the wall shows.
        layout,
        layoutFallback: !resolved,
        cameraIds,
        durationMs,
      })
    }
  })
  return out
}

/** Index `i` moved by `delta`, wrapping around a list of `n` (0 when empty). */
export function wrapIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0
  return (((i + delta) % n) + n) % n
}

/** How long one full cycle of the tour takes, in seconds. */
export function cycleSeconds(pages: readonly TourPage[]): number {
  return pages.reduce((sum, p) => sum + p.durationMs / 1000, 0)
}

/** "45 s", "2 min", "1 h 5 min": a duration the way a person says it. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`
  return rest ? `${m} min ${rest} s` : `${m} min`
}
