/**
 * Filter bar default — the board opens with the category filter bar showing;
 * the toolbar button still closes it.
 */
import { describe, it, expect } from 'vitest';
import { filterBarOpen } from '../../webview/src/stores/conversations';

describe('Filter bar', () => {
  it('is open when the board opens', () => {
    let value: boolean | undefined;
    filterBarOpen.subscribe(v => { value = v; })();
    expect(value).toBe(true);
  });
});
