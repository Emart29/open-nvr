import assert from 'node:assert/strict'
import test from 'node:test'
import { autoGrid, buildPages, cycleSeconds, formatDuration, wrapIndex } from '../src/lib/tourPlan.ts'

const grid = (cols, rows) => ({
  name: `${cols}x${rows}`,
  gridCols: cols,
  gridRows: rows,
  tiles: Array.from({ length: cols * rows }, (_, i) => ({ row: Math.floor(i / cols), col: i % cols, rowSpan: 1, colSpan: 1 })),
})
const LAYOUTS = { wall: grid(5, 4), '2x2': grid(2, 2) }
const resolve = (id) => LAYOUTS[id] ?? null
const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i)

test('a step with more cameras than tiles pages through them in order', () => {
  const pages = buildPages([{ label: 'North', layout_id: 'wall', duration_s: 60, camera_ids: ids(60) }], resolve)
  assert.equal(pages.length, 3)
  assert.deepEqual(pages.map((p) => [p.page, p.pages, p.cameraIds.length]), [[0, 3, 20], [1, 3, 20], [2, 3, 20]])
  assert.deepEqual(pages[1].cameraIds, ids(20, 21))
  assert.equal(pages[0].durationMs, 60_000)
})

test('the last page holds the remainder', () => {
  const pages = buildPages([{ label: '', layout_id: '2x2', duration_s: 30, camera_ids: ids(5) }], resolve)
  assert.deepEqual(pages.map((p) => p.cameraIds), [[1, 2, 3, 4], [5]])
})

test('a page with fewer cameras than tiles keeps the chosen layout (the preview draws the same)', () => {
  const [short, two] = buildPages([
    { label: '', layout_id: 'wall', duration_s: 30, camera_ids: ids(6) },
    { label: '', layout_id: '2x2', duration_s: 30, camera_ids: ids(2) },
  ], resolve)
  assert.equal(short.layout, LAYOUTS.wall)
  assert.equal(two.layout, LAYOUTS['2x2'])
  assert.equal(short.cameraIds.length, 6)
})

test('a step with no visible camera is skipped', () => {
  const pages = buildPages([
    { label: 'North', layout_id: '2x2', duration_s: 30, camera_ids: [] },
    { label: 'South', layout_id: '2x2', duration_s: 30, camera_ids: [7] },
  ], resolve)
  assert.deepEqual(pages.map((p) => [p.stepIndex, p.label]), [[1, 'South']])
})

test('a tour with every step empty has no pages', () => {
  assert.deepEqual(buildPages([{ label: '', layout_id: '2x2', duration_s: 30, camera_ids: [] }], resolve), [])
  assert.deepEqual(buildPages([], resolve), [])
})

test('a missing layout falls back to an automatic grid', () => {
  for (const step of [
    { label: '', layout_id: 'gone', duration_s: 30, camera_ids: ids(6) },
    { label: '', layout_id: 'wall', duration_s: 30, camera_ids: ids(6), layout_missing: true },
  ]) {
    const [page] = buildPages([step], resolve)
    assert.equal(page.layoutFallback, true)
    assert.equal(page.layout.tiles.length >= 6, true)
    assert.equal(page.cameraIds.length, 6)
  }
})

test('the automatic grid is near-square and capped at 5x5', () => {
  assert.deepEqual([autoGrid(1).gridCols, autoGrid(1).gridRows], [1, 1])
  assert.deepEqual([autoGrid(6).gridCols, autoGrid(6).gridRows], [3, 2])
  assert.deepEqual([autoGrid(20).gridCols, autoGrid(20).gridRows], [5, 4])
  assert.equal(autoGrid(400).tiles.length, 25)
  const pages = buildPages([{ label: '', layout_id: 'gone', duration_s: 30, camera_ids: ids(60) }], resolve)
  assert.equal(pages.length, 3)
})

test('page keys stay the same for an unchanged tour and change when cameras change', () => {
  const step = { label: 'North', layout_id: '2x2', duration_s: 30, camera_ids: [1, 2] }
  assert.equal(buildPages([step], resolve)[0].key, buildPages([{ ...step }], resolve)[0].key)
  assert.notEqual(buildPages([step], resolve)[0].key, buildPages([{ ...step, camera_ids: [1, 3] }], resolve)[0].key)
})

test('stepping wraps around in both directions', () => {
  assert.equal(wrapIndex(2, 1, 3), 0)
  assert.equal(wrapIndex(0, -1, 3), 2)
  assert.equal(wrapIndex(1, 1, 3), 2)
  assert.equal(wrapIndex(0, 1, 0), 0)
})

test('cycle length and durations read like a person says them', () => {
  const pages = buildPages([
    { label: '', layout_id: '2x2', duration_s: 60, camera_ids: ids(8) },
    { label: '', layout_id: 'wall', duration_s: 30, camera_ids: ids(3) },
  ], resolve)
  assert.equal(cycleSeconds(pages), 150)
  assert.equal(formatDuration(45), '45 s')
  assert.equal(formatDuration(150), '2 min 30 s')
  assert.equal(formatDuration(120), '2 min')
  assert.equal(formatDuration(3900), '1 h 5 min')
})

test('an empty tile stays empty: the cameras after it keep their tiles', () => {
  const [page] = buildPages([{ label: '', layout_id: '2x2', duration_s: 30, camera_ids: [1, null, 3] }], resolve)
  assert.deepEqual(page.cameraIds, [1, null, 3])
})

test('a page of empty tiles only is skipped on the wall but kept in the editor', () => {
  const step = { label: '', layout_id: '2x2', duration_s: 30, camera_ids: [1, 2, 3, 4, null, null, null, null, 9] }
  assert.deepEqual(buildPages([step], resolve).map((p) => p.page), [0, 2])
  assert.deepEqual(buildPages([step], resolve, { keepEmptyPages: true }).map((p) => p.page), [0, 1, 2])
})

test('a step of empty tiles only is skipped', () => {
  assert.deepEqual(buildPages([{ label: '', layout_id: '2x2', duration_s: 30, camera_ids: [null, null] }], resolve), [])
})
