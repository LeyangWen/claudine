/**
 * BUG8 fork labels on the board — the webview groups each parent's forks from the
 * forks' forkedFrom, so a parent card can say it was forked and into what.
 */
import { describe, it, expect } from 'vitest';
import { conversations, forkLinks, parentTitleOf, familyLetter, lineageCode, type ForkLinks } from '../../webview/src/stores/conversations';
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

  // The Exalt family: A forked into B and C; C forked into D, E and F.
  it('letters a fork family in the order the forks were made', () => {
    conversations.set([
      card('orig'),
      card('oct5', { forkedFrom: 'orig', forkedAt: '2026-10-05T16:29:52.705Z' }),
      card('cleanup', { forkedFrom: 'oct5', forkedAt: '2026-10-05T18:38:28.337Z' }),
      card('fresh', { forkedFrom: 'oct5' }),
      card('oct2', { forkedFrom: 'orig', forkedAt: '2026-10-02T22:29:33.005Z' }),
      card('summary', { forkedFrom: 'oct5', forkedAt: '2026-10-05T16:30:45.913Z' }),
      card('alone'),
    ]);
    const links = current();
    const codes = Object.fromEntries(
      ['orig', 'oct2', 'oct5', 'summary', 'cleanup', 'fresh', 'alone']
        .map(id => [id, lineageCode(links, links.byId.get(id)!)]));
    expect(codes).toEqual({
      orig: 'A', oct2: 'A-B', oct5: 'A-C', summary: 'C-D', cleanup: 'C-E', fresh: 'C-F', alone: undefined,
    });
    expect(links.forks.get('oct5')!.map(c => c.id)).toEqual(['summary', 'cleanup', 'fresh']);
  });

  it('keeps separate families apart', () => {
    conversations.set([
      card('P'), card('P1', { forkedFrom: 'P', forkedAt: '2026-10-01T00:00:00.000Z' }),
      card('Q'), card('Q1', { forkedFrom: 'Q', forkedAt: '2026-10-02T00:00:00.000Z' }),
    ]);
    const links = current();
    expect(lineageCode(links, links.byId.get('P1')!)).toBe('A-B');
    expect(lineageCode(links, links.byId.get('Q1')!)).toBe('A-B');
  });

  it('counts letters like spreadsheet columns past Z', () => {
    expect([0, 1, 25, 26, 27, 51, 701, 702].map(familyLetter))
      .toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'ZZ', 'AAA']);
  });

  it('ignores a fork whose parent left the board', () => {
    conversations.set([card('F1', { forkedFrom: 'gone' })]);
    expect(current().forks.size).toBe(0);
    expect(current().letter.size).toBe(0);
  });

  it('strips one fork suffix for the fallback parent title', () => {
    expect(parentTitleOf('Exalt accuracy (fork) (fork)')).toBe('Exalt accuracy (fork)');
  });
});
