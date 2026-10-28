import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_STEP_CAMERAS, addCamera, closeGaps, moveTo, placeAt, placeMessage, placeOutcome, removeAt, tidy } from '../src/lib/tourArrange.ts'

test('removing a camera leaves its tile empty; no other camera moves', () => {
  assert.deepEqual(removeAt([1, 2, 3, 4], 1), [1, null, 3, 4])
  assert.deepEqual(removeAt([1, 2], 5), [1, 2])
})

test('removing the last camera trims the empty tiles at the end', () => {
  assert.deepEqual(removeAt([1, null, 3], 2), [1])
  assert.deepEqual(tidy([null, 1, null, null]), [null, 1])
})

test('dropping a tile on another swaps the two', () => {
  assert.deepEqual(moveTo([1, 2, 3, 4], 0, 2), [3, 2, 1, 4])
  assert.deepEqual(moveTo([1, 2, 3], 1, 1), [1, 2, 3])
})

test('dropping a tile on an empty tile moves it exactly there', () => {
  assert.deepEqual(moveTo([1, null, 3], 0, 1), [null, 1, 3])
  assert.deepEqual(moveTo([1, 2, 3], 0, 5), [null, 2, 3, null, null, 1])
  assert.deepEqual(moveTo([1, 2, 3], 2, 6), [1, 2, null, null, null, null, 3])
})

test('an empty tile cannot be dragged', () => {
  assert.deepEqual(moveTo([1, null, 3], 1, 0), [1, null, 3])
})

test('a picked camera replaces the one on its tile', () => {
  assert.deepEqual(placeAt([1, 2, 3], 9, 1), [1, 9, 3])
})

test('a picked camera on an empty tile goes on that tile', () => {
  assert.deepEqual(placeAt([1, null, 3], 9, 1), [1, 9, 3])
  assert.deepEqual(placeAt([1, 2, 3], 9, 5), [1, 2, 3, null, null, 9])
})

test('a camera already in the step is moved, never shown twice', () => {
  assert.deepEqual(placeAt([1, 2, 3], 3, 0), [3, 2, 1])
  assert.deepEqual(placeAt([1, 2, 3], 1, 4), [null, 2, 3, null, 1])
  assert.deepEqual(placeAt([1, 2, 3], 2, 1), [1, 2, 3])
})

test('adding fills the first empty tile, else goes at the end', () => {
  assert.deepEqual(addCamera([1, null, 3, null, 5], 9), [1, 9, 3, null, 5])
  assert.deepEqual(addCamera([1, 2], 9), [1, 2, 9])
  assert.deepEqual(addCamera([1, 2], 2), [1, 2])
})

test('closing the gaps packs the cameras in order', () => {
  assert.deepEqual(closeGaps([null, 1, null, 3, 4]), [1, 3, 4])
})

test('a full step takes no more cameras', () => {
  const full = Array.from({ length: MAX_STEP_CAMERAS }, (_, i) => i + 1)
  assert.equal(placeAt(full, 9999, MAX_STEP_CAMERAS).length, MAX_STEP_CAMERAS)
  assert.deepEqual(placeAt(full, 9999, 0).slice(0, 2), [9999, 2])
  assert.deepEqual(addCamera(full, 9999), full)
})

test('the input list is never changed', () => {
  const ids = Object.freeze([1, null, 3])
  removeAt(ids, 0)
  moveTo(ids, 0, 1)
  placeAt(ids, 9, 1)
  addCamera(ids, 9)
  closeGaps(ids)
  assert.deepEqual(ids, [1, null, 3])
})

test('placing says what happened, above all to a camera already there', () => {
  assert.deepEqual(placeOutcome([1, 2, 3], 9, 1), { kind: 'replaced', at: 1, replaced: 2 })
  assert.deepEqual(placeOutcome([1, 2, 3], 9, 7), { kind: 'added', at: 7 })
  assert.deepEqual(placeOutcome([1, null, 3], 9, 1), { kind: 'added', at: 1 })
  assert.deepEqual(placeOutcome([1, 2, 3], 3, 0), { kind: 'swapped', from: 2, at: 0, other: 1 })
  assert.deepEqual(placeOutcome([1, 2, 3], 1, 5), { kind: 'moved', from: 0, at: 5 })
  assert.deepEqual(placeOutcome([1, 2, 3], 2, 1), { kind: 'unchanged', at: 1 })
  const full = Array.from({ length: MAX_STEP_CAMERAS }, (_, i) => i + 1)
  assert.deepEqual(placeOutcome(full, 9999, MAX_STEP_CAMERAS), { kind: 'full' })
})

test('the outcome matches what placeAt does', () => {
  const ids = [1, null, 3, 4]
  for (const cam of [3, 4, 9]) for (const at of [0, 1, 3, 6]) {
    const after = placeAt(ids, cam, at)
    const o = placeOutcome(ids, cam, at)
    if (o.kind === 'unchanged') assert.deepEqual(after, ids)
    else if (o.kind !== 'full') assert.equal(after[o.at], cam)
  }
})

test('a camera already on the page is reported, a plain add is not', () => {
  const t = (key, v) => `${key} ${JSON.stringify(v)}`
  const nameOf = (id) => `cam${id}`
  assert.equal(placeMessage(t, [1, 2, 3], 9, 3, nameOf), null)
  assert.equal(placeMessage(t, [1, 2, 3], 3, 0, nameOf), 'tours.placeSwapped {"name":"cam3","from":3,"to":1,"other":"cam1"}')
  assert.equal(placeMessage(t, [1, 2, 3], 2, 1, nameOf), 'tours.placeSame {"name":"cam2","n":2}')
})
