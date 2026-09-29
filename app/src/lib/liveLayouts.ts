// Copyright (c) 2026 OpenNVR
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The built-in Live View layouts, shared by the Live View grid and the
 * Window Settings page that enables them. One table, so the two cannot drift:
 * they were once separate copies, and both carried a "1+12" that had 8 tiles
 * and a "1+1+10" that had 10.
 *
 * A layout's name is its tile count: every "a+b" name must add up to
 * tiles.length, and the tiles must cover the grid exactly once.
 */

export interface LayoutTile {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface LayoutDefinition {
  name: string
  description?: string
  gridCols: number
  gridRows: number
  tiles: LayoutTile[]
}

const cell = (row: number, col: number, span = 1): LayoutTile => ({ row, col, rowSpan: span, colSpan: span })

/** Every 1×1 cell of a cols×rows grid, row by row, skipping those `taken`. */
function cells(cols: number, rows: number, taken: (r: number, c: number) => boolean = () => false): LayoutTile[] {
  const out: LayoutTile[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!taken(r, c)) out.push(cell(r, c))
  return out
}

export const PREDEFINED_LAYOUTS: Record<string, LayoutDefinition> = {
  '1x1': { name: '1×1', description: '1 camera full screen', gridCols: 1, gridRows: 1, tiles: cells(1, 1) },
  '2x2': { name: '2×2', description: '4 cameras in 2×2 grid', gridCols: 2, gridRows: 2, tiles: cells(2, 2) },
  '3x3': { name: '3×3', description: '9 cameras in 3×3 grid', gridCols: 3, gridRows: 3, tiles: cells(3, 3) },
  '4x4': { name: '4×4', description: '16 cameras in 4×4 grid', gridCols: 4, gridRows: 4, tiles: cells(4, 4) },
  '1+5': {
    name: '1+5',
    description: '1 large + 5 small cameras',
    gridCols: 3,
    gridRows: 3,
    tiles: [cell(0, 0, 2), ...cells(3, 3, (r, c) => r < 2 && c < 2)],
  },
  '1+7': {
    name: '1+7',
    description: '1 large + 7 small cameras',
    gridCols: 4,
    gridRows: 4,
    tiles: [cell(0, 0, 3), ...cells(4, 4, (r, c) => r < 3 && c < 3)],
  },
  '2+8': {
    name: '2+8',
    description: '2 large + 8 small cameras',
    gridCols: 4,
    gridRows: 4,
    tiles: [cell(0, 0, 2), cell(0, 2, 2), ...cells(4, 4, (r) => r < 2)],
  },
  // 2×2 large top-left; the other 12 cells of a 4×4 grid are small.
  '1+12': {
    name: '1+12',
    description: '1 large + 12 small cameras',
    gridCols: 4,
    gridRows: 4,
    tiles: [cell(0, 0, 2), ...cells(4, 4, (r, c) => r < 2 && c < 2)],
  },
  '4+9': {
    name: '4+9',
    description: '4 medium + 9 small cameras',
    gridCols: 5,
    gridRows: 5,
    tiles: [cell(0, 0, 2), cell(0, 2, 2), cell(2, 0, 2), cell(2, 2, 2), ...cells(5, 5, (r, c) => r < 4 && c < 4)],
  },
  // Two 2×2 large side by side; a 2×2 block of small to their right and a
  // row of six beneath.
  '1+1+10': {
    name: '1+1+10',
    description: '2 large side-by-side + 10 small',
    gridCols: 6,
    gridRows: 3,
    tiles: [cell(0, 0, 2), cell(0, 2, 2), ...cells(6, 3, (r, c) => r < 2 && c < 4)],
  },
}
