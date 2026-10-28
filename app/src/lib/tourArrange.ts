// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The edits a running wall's Arrange mode makes to one step's camera list,
 * as pure functions (app/tests/tourArrange.test.mjs).
 *
 * A step's cameras are one list, paged by the layout: slot `i` of page `p`
 * is position `p * tiles + i`. Positions past the end of the list are the
 * empty tiles of the last page, so "an empty tile" always means "the end".
 * Every function returns a new list and never puts a camera in twice.
 */

/** The server's limit on cameras in one step (routers/tours.py). */
export const MAX_STEP_CAMERAS = 256

/** The list without the camera at `at`; later cameras move up one. */
export function removeAt(ids: readonly number[], at: number): number[] {
  if (at < 0 || at >= ids.length) return [...ids]
  return ids.filter((_, i) => i !== at)
}

/**
 * The camera at `from` dropped on position `to`: swapped with the camera
 * there, or, dropped on an empty tile, moved to the end.
 */
export function moveTo(ids: readonly number[], from: number, to: number): number[] {
  const out = [...ids]
  if (from < 0 || from >= out.length || from === to) return out
  if (to >= out.length) {
    const [cam] = out.splice(from, 1)
    out.push(cam)
    return out
  }
  ;[out[from], out[to]] = [out[to], out[from]]
  return out
}

/**
 * Camera `cam` put at position `at`: it replaces the camera there, or,
 * on an empty tile, is added at the end. A camera already in the step is
 * moved instead (swapped into place), so it never shows twice.
 */
export function placeAt(ids: readonly number[], cam: number, at: number): number[] {
  const existing = ids.indexOf(cam)
  if (existing >= 0) return moveTo(ids, existing, at)
  if (at >= ids.length) return ids.length >= MAX_STEP_CAMERAS ? [...ids] : [...ids, cam]
  const out = [...ids]
  out[at] = cam
  return out
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

export function placeOutcome(ids: readonly number[], cam: number, at: number): PlaceOutcome {
  const from = ids.indexOf(cam)
  if (from >= 0) {
    if (from === at) return { kind: 'unchanged', at }
    // Onto an empty tile it goes to the end; already last, nothing moves.
    if (at >= ids.length) return from === ids.length - 1 ? { kind: 'unchanged', at: from } : { kind: 'moved', from, at: ids.length - 1 }
    return { kind: 'swapped', from, at, other: ids[at] }
  }
  if (at >= ids.length) return ids.length >= MAX_STEP_CAMERAS ? { kind: 'full' } : { kind: 'added', at: ids.length }
  return { kind: 'replaced', at, replaced: ids[at] }
}

/** The app's t(): a key and its values, in the operator's language. */
type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * What putting `cam` at step position `at` did, in words, or null when
 * there is nothing to say (a plain add). Above all, a camera already in
 * the step moves instead of showing twice, and the operator is told so.
 * Tile numbers count across the step's pages, as the tiles are labelled.
 */
export function placeMessage(t: Translate, ids: readonly number[], cam: number, at: number, nameOf: (id: number) => string): string | null {
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
