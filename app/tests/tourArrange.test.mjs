import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_STEP_CAMERAS, moveTo, placeAt, removeAt } from '../src/lib/tourArrange.ts'

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
