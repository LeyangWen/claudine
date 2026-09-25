/**
 * Shared column width tests — every non-narrow column on the board has one
 * width, so dragging any handle keeps the columns equal while the handle
 * still follows the cursor.
 */
import { describe, it, expect } from 'vitest';
import { nextColumnWidth, maxColumnWidth, MIN_COLUMN_WIDTH } from '../../webview/src/lib/columnWidth';

describe('Shared column width', () => {
  it('applies the full delta when one column is left of the handle', () => {
    expect(nextColumnWidth(200, 30, 1, 1, Infinity)).toBe(230);
    expect(nextColumnWidth(200, -30, 1, 1, Infinity)).toBe(170);
  });

  it('splits the delta across the columns left of the handle so it tracks the cursor', () => {
    // Handle after 4 equal columns: moving it 40px right widens each by 10px,
    // which moves the handle by exactly 4 * 10 = 40px.
    expect(nextColumnWidth(200, 40, 1, 4, Infinity)).toBe(210);
  });

  it('treats a handle with only narrow columns to its left as a single share', () => {
    expect(nextColumnWidth(200, 40, 1, 0, Infinity)).toBe(240);
  });

  it('compensates for CSS zoom', () => {
    expect(nextColumnWidth(200, 30, 1.5, 1, Infinity)).toBe(220);
    expect(nextColumnWidth(200, 15, 0.5, 1, Infinity)).toBe(230);
  });

  it('never goes below the minimum width', () => {
    expect(nextColumnWidth(170, -500, 1, 1, Infinity)).toBe(MIN_COLUMN_WIDTH);
  });

  it('never exceeds the cap', () => {
    expect(nextColumnWidth(300, 5000, 1, 1, 640)).toBe(640);
  });

  it('caps a column at 80% of the board and is unbounded before the board is measured', () => {
    expect(maxColumnWidth(1000)).toBe(800);
    expect(maxColumnWidth(0)).toBe(Infinity);
  });

  it('keeps sub-pixel precision so slow drags across many columns still move', () => {
    // 1px drag over 6 columns must not round away to zero
    expect(nextColumnWidth(200, 1, 1, 6, Infinity)).toBeGreaterThan(200);
  });
});
