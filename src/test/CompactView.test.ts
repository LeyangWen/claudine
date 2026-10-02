/**
 * Compact view default — the board opens with every card in compact form;
 * the toolbar button still switches to the full view.
 */
import { describe, it, expect } from 'vitest';
import { compactView } from '../../webview/src/stores/conversations';

describe('Compact view', () => {
  it('is on when the board opens', () => {
    let value: boolean | undefined;
    compactView.subscribe(v => { value = v; })();
    expect(value).toBe(true);
  });
});
