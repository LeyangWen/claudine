/**
 * Shared column width math.
 *
 * Every non-narrow column on the board has the same width. Dragging the
 * handle after `leftCount` non-narrow columns moves that handle by exactly
 * the cursor delta when each of those columns takes an equal share of it,
 * so the handle tracks the mouse and the columns stay equal.
 */

export const MIN_COLUMN_WIDTH = 160;

/** Largest share of the board a single column may take. */
export const MAX_COLUMN_FRACTION = 0.8;

export function maxColumnWidth(boardWidth: number): number {
  return boardWidth > 0 ? Math.floor(boardWidth * MAX_COLUMN_FRACTION) : Infinity;
}

/**
 * @param current    current shared width (logical px, before CSS zoom)
 * @param deltaX     raw cursor delta in screen px (positive = drag right)
 * @param zoom       board zoom factor (screen px per logical px)
 * @param leftCount  non-narrow columns left of the dragged handle
 * @param cap        maximum allowed width (see maxColumnWidth)
 */
export function nextColumnWidth(
  current: number,
  deltaX: number,
  zoom: number,
  leftCount: number,
  cap: number,
  min = MIN_COLUMN_WIDTH
): number {
  const share = Math.max(1, leftCount);
  const next = current + deltaX / zoom / share;
  return Math.max(min, Math.min(cap, next));
}
