/**
 * BUG8 fork labels on the board — the webview groups each parent's forks from the
 * forks' forkedFrom, so a parent card can say it was forked and into what.
 */
import { describe, it, expect } from 'vitest';
import { conversations, forkLinks, parentTitleOf, type ForkLinks } from '../../webview/src/stores/conversations';
import type { Conversation } from '../../webview/src/lib/vscode';

// svelte resolves from webview/node_modules only through the store module, so
// read stores by subscribing rather than importing svelte/store here.
function current(): ForkLinks {
  let value!: ForkLinks;
  forkLinks.subscribe(v => { value = v; })();
  return value;
}

function card(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, title: id, description: '', category: 'task', status: 'in-review', lastMessage: '',
    agents: [], hasError: false, isInterrupted: false, hasQuestion: false, isRateLimited: false,
    createdAt: '2026-10-01T16:55:37.254Z', updatedAt: '2026-10-05T16:29:52.705Z', ...extra,
  };
}

describe('forkLinks', () => {
  it('lists the forks of each parent on the board', () => {
    conversations.set([
      card('P'),
      card('F1', { forkedFrom: 'P' }),
      card('F2', { forkedFrom: 'P' }),
      card('G', { forkedFrom: 'F2' }),
      card('Q'),
    ]);
    const links = current();
    expect(links.forks.get('P')!.map(c => c.id)).toEqual(['F1', 'F2']);
    expect(links.forks.get('F2')!.map(c => c.id)).toEqual(['G']);
    expect(links.forks.has('Q')).toBe(false);
    expect(links.byId.get('P')!.id).toBe('P');
  });

  it('ignores a fork whose parent left the board', () => {
    conversations.set([card('F1', { forkedFrom: 'gone' })]);
    expect(current().forks.size).toBe(0);
  });

  it('strips one fork suffix for the fallback parent title', () => {
    expect(parentTitleOf('Exalt accuracy (fork) (fork)')).toBe('Exalt accuracy (fork)');
  });
});
