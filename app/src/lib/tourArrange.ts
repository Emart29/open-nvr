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
