import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_STEP_CAMERAS, moveTo, placeAt, placeMessage, placeOutcome, removeAt } from '../src/lib/tourArrange.ts'

test('removing a camera closes the gap', () => {
  assert.deepEqual(removeAt([1, 2, 3, 4], 1), [1, 3, 4])
  assert.deepEqual(removeAt([1, 2], 5), [1, 2])
})

test('dropping a tile on another swaps the two', () => {
  assert.deepEqual(moveTo([1, 2, 3, 4], 0, 2), [3, 2, 1, 4])
  assert.deepEqual(moveTo([1, 2, 3], 1, 1), [1, 2, 3])
})

test('dropping a tile on an empty tile moves it to the end', () => {
  assert.deepEqual(moveTo([1, 2, 3], 0, 7), [2, 3, 1])
})

test('a picked camera replaces the one on its tile', () => {
  assert.deepEqual(placeAt([1, 2, 3], 9, 1), [1, 9, 3])
})

test('a picked camera on an empty tile is added at the end', () => {
  assert.deepEqual(placeAt([1, 2, 3], 9, 10), [1, 2, 3, 9])
})

test('a camera already in the step is moved, never shown twice', () => {
  assert.deepEqual(placeAt([1, 2, 3], 3, 0), [3, 2, 1])
  assert.deepEqual(placeAt([1, 2, 3], 1, 9), [2, 3, 1])
  assert.deepEqual(placeAt([1, 2, 3], 2, 1), [1, 2, 3])
})

test('a full step takes no more cameras', () => {
  const full = Array.from({ length: MAX_STEP_CAMERAS }, (_, i) => i + 1)
  assert.equal(placeAt(full, 9999, MAX_STEP_CAMERAS).length, MAX_STEP_CAMERAS)
  assert.deepEqual(placeAt(full, 9999, 0).slice(0, 2), [9999, 2])
})

test('the input list is never changed', () => {
  const ids = Object.freeze([1, 2, 3])
  removeAt(ids, 0); moveTo(ids, 0, 2); placeAt(ids, 9, 1)
  assert.deepEqual(ids, [1, 2, 3])
})

test('placing says what happened, above all to a camera already there', () => {
  assert.deepEqual(placeOutcome([1, 2, 3], 9, 1), { kind: 'replaced', at: 1, replaced: 2 })
  assert.deepEqual(placeOutcome([1, 2, 3], 9, 7), { kind: 'added', at: 3 })
  assert.deepEqual(placeOutcome([1, 2, 3], 3, 0), { kind: 'swapped', from: 2, at: 0, other: 1 })
  assert.deepEqual(placeOutcome([1, 2, 3], 1, 9), { kind: 'moved', from: 0, at: 2 })
  assert.deepEqual(placeOutcome([1, 2, 3], 2, 1), { kind: 'unchanged', at: 1 })
  assert.deepEqual(placeOutcome([1, 2, 3], 3, 9), { kind: 'unchanged', at: 2 })
  const full = Array.from({ length: MAX_STEP_CAMERAS }, (_, i) => i + 1)
  assert.deepEqual(placeOutcome(full, 9999, MAX_STEP_CAMERAS), { kind: 'full' })
})

test('the outcome matches what placeAt does', () => {
  const ids = [1, 2, 3, 4]
  for (const cam of [2, 4, 9]) for (const at of [0, 1, 3, 6]) {
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
