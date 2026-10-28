// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The edits the tour editor and a running wall's Arrange mode make to one
 * step's camera list, as pure functions (app/tests/tourArrange.test.mjs).
 *
 * A step's cameras are one list in tile order, paged by the layout: slot `i`
 * of page `p` is position `p * tiles + i`. An empty tile is null, and the
 * positions past the end are the empty tiles of the last page. Taking a
 * camera out leaves its tile empty, so no other camera moves on the wall.
 * Every function returns a new list and never puts a camera in twice.
 */

/** The server's limit on tiles in one step (routers/tours.py). */
export const MAX_STEP_CAMERAS = 256

type Slot = number | null

/** Without the empty tiles at the end: they are simply where the step stops. */
export function tidy(ids: readonly Slot[]): Slot[] {
  let end = ids.length
  while (end > 0 && ids[end - 1] == null) end--
  return ids.slice(0, end)
}

/** Room up to position `at`: tiles past the end are empty. */
function padTo(ids: readonly Slot[], at: number): Slot[] {
  const out = [...ids]
  while (out.length <= at) out.push(null)
  return out
}

/** The camera at `at` taken out: its tile is left empty, no other moves. */
export function removeAt(ids: readonly Slot[], at: number): Slot[] {
  if (at < 0 || at >= ids.length) return [...ids]
  const out = [...ids]
  out[at] = null
  return tidy(out)
}

/**
 * The camera at `from` dropped on position `to`: swapped with the camera
 * there, or, on an empty tile, moved there and its old tile left empty.
 */
export function moveTo(ids: readonly Slot[], from: number, to: number): Slot[] {
  if (from < 0 || from >= ids.length || ids[from] == null || from === to || to < 0 || to >= MAX_STEP_CAMERAS) return [...ids]
  const out = padTo(ids, to)
  ;[out[from], out[to]] = [out[to], out[from]]
  return tidy(out)
}

/**
 * Camera `cam` put at position `at`: it replaces the camera there or fills
 * that empty tile. A camera already in the step is moved instead (swapped
 * into place), so it never shows twice.
 */
export function placeAt(ids: readonly Slot[], cam: number, at: number): Slot[] {
  const existing = ids.indexOf(cam)
  if (existing >= 0) return moveTo(ids, existing, at)
  if (at < 0 || at >= MAX_STEP_CAMERAS) return [...ids]
  const out = padTo(ids, at)
  out[at] = cam
  return tidy(out)
}

/** Camera `cam` added to the step: into its first empty tile, else at the end. */
export function addCamera(ids: readonly Slot[], cam: number): Slot[] {
  if (ids.includes(cam)) return [...ids]
  const gap = ids.indexOf(null)
  return placeAt(ids, cam, gap >= 0 ? gap : ids.length)
}

/** The cameras packed together, every gap closed, in their order. */
export function closeGaps(ids: readonly Slot[]): Slot[] {
  return ids.filter((c) => c != null)
}

/**
 * What `placeAt(ids, cam, at)` will do, so the screen can say so: above
 * all when the camera is already in the step and moves instead of being
 * added a second time. Positions are within the step.
 */
export type PlaceOutcome =
  | { kind: 'added'; at: number }
  | { kind: 'replaced'; at: number; replaced: number }
  | { kind: 'moved'; from: number; at: number }
  | { kind: 'swapped'; from: number; at: number; other: number }
  | { kind: 'unchanged'; at: number }
  | { kind: 'full' }

export function placeOutcome(ids: readonly Slot[], cam: number, at: number): PlaceOutcome {
  const from = ids.indexOf(cam)
  if (from >= 0 && from === at) return { kind: 'unchanged', at }
  if (at < 0 || at >= MAX_STEP_CAMERAS) return from >= 0 ? { kind: 'unchanged', at: from } : { kind: 'full' }
  const there = ids[at] ?? null
  if (from >= 0) return there == null ? { kind: 'moved', from, at } : { kind: 'swapped', from, at, other: there }
  return there == null ? { kind: 'added', at } : { kind: 'replaced', at, replaced: there }
}

/** The app's t(): a key and its values, in the operator's language. */
type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * What putting `cam` at step position `at` did, in words, or null when
 * there is nothing to say (a plain add). Above all, a camera already in
 * the step moves instead of showing twice, and the operator is told so.
 * Tile numbers count across the step's pages, as the tiles are labelled.
 */
export function placeMessage(t: Translate, ids: readonly Slot[], cam: number, at: number, nameOf: (id: number) => string): string | null {
  const o = placeOutcome(ids, cam, at)
  const name = nameOf(cam)
  switch (o.kind) {
    case 'unchanged': return t('tours.placeSame', { name, n: o.at + 1 })
    case 'moved': return t('tours.placeMoved', { name, from: o.from + 1, to: o.at + 1 })
    case 'swapped': return t('tours.placeSwapped', { name, from: o.from + 1, to: o.at + 1, other: nameOf(o.other) })
    case 'replaced': return t('tours.placeReplaced', { name, other: nameOf(o.replaced), n: o.at + 1 })
    case 'full': return t('tours.placeFull', { max: MAX_STEP_CAMERAS })
    default: return null
  }
}
