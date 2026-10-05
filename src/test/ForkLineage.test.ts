/**
 * BUG8 fork lineage — Claude Code's Fork button copies the parent's history into a
 * new session and switches the tab to it, so the parent's card and the fork's
 * card looked like one session listed twice. Forks now link to their parent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsp from 'fs/promises';
import { ConversationParser } from '../providers/ConversationParser';
import { LineageNode, resolveForkParents, isForkTitle, parentTitleOf } from '../services/ForkLineage';

vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
  readFile: vi.fn().mockResolvedValue(''),
  access: vi.fn().mockRejectedValue(new Error('ENOENT')),
  open: vi.fn(),
}));

function node(id: string, opts: {
  createdAt?: string;
  forkTitle?: string;
  forkPoint?: string;
  firstOwnId?: string;
  forkedAt?: string;
  titles?: string[];
  ids: string[];
}): LineageNode {
  return {
    id,
    createdAt: opts.createdAt ?? '2026-10-01T16:55:37.201Z',
    facts: {
      forkTitle: opts.forkTitle,
      forkPoint: opts.forkPoint,
      firstOwnId: opts.firstOwnId,
      forkedAt: opts.forkedAt,
      titles: new Set(opts.titles ?? []),
      messageIds: new Set(opts.ids),
    },
  };
}

describe('fork titles', () => {
  it('recognises the title Claude Code gives a fork', () => {
    expect(isForkTitle('Exalt accuracy (fork)')).toBe(true);
    expect(isForkTitle('Exalt accuracy (fork) (fork)')).toBe(true);
    expect(isForkTitle('Exalt accuracy')).toBe(false);
    expect(isForkTitle(' (fork)')).toBe(false);
  });

  it('removes one fork suffix to get the parent title', () => {
    expect(parentTitleOf('X (fork) (fork)')).toBe('X (fork)');
    expect(parentTitleOf('X (fork)')).toBe('X');
    expect(parentTitleOf('X')).toBe('X');
  });
});

describe('resolveForkParents', () => {
  // The 2026-10-05 Exalt family: P forked twice into two "X (fork)" cards, and
  // the second fork F2 forked three more times.
  const P = node('P', { titles: ['X'], ids: ['m1', 'm2', 'm3', 'm4'] });
  const F1 = node('F1', {
    createdAt: '2026-10-01T16:55:37.254Z', forkTitle: 'X (fork)', titles: ['X (fork)'],
    forkPoint: 'm2', firstOwnId: 'a1', forkedAt: '2026-10-02T22:29:33.005Z', ids: ['m1', 'm2', 'a1'],
  });
  const F2 = node('F2', {
    createdAt: '2026-10-01T16:55:37.254Z', forkTitle: 'X (fork)', titles: ['X (fork)'],
    forkPoint: 'm4', firstOwnId: 'b1', forkedAt: '2026-10-05T16:29:52.705Z', ids: ['m1', 'm2', 'm3', 'm4', 'b1', 'b2'],
  });
  // Forked from F2 at its own message b2; has written nothing yet.
  const G = node('G', {
    createdAt: '2026-10-01T16:55:37.254Z', forkTitle: 'X (fork) (fork)', titles: ['X (fork) (fork)'],
    forkPoint: 'b2', ids: ['m1', 'm2', 'm3', 'm4', 'b1', 'b2'],
  });
  // Forked from F2 at F2's fork point, a minute after F2, then renamed.
  const H = node('H', {
    createdAt: '2026-10-01T16:55:37.254Z', forkTitle: 'X (fork) (fork)', titles: ['X (fork) (fork)', 'X - summary'],
    forkPoint: 'm4', firstOwnId: 'c1', forkedAt: '2026-10-05T16:30:45.913Z', ids: ['m1', 'm2', 'm3', 'm4', 'c1'],
  });

  it('links each fork to the session it was forked from', () => {
    const parents = resolveForkParents([P, F1, F2, G, H]);
    expect(Object.fromEntries(parents)).toEqual({ F1: 'P', F2: 'P', G: 'F2', H: 'F2' });
  });

  it('does not depend on the order of the nodes', () => {
    const parents = resolveForkParents([H, G, F2, F1, P]);
    expect(Object.fromEntries(parents)).toEqual({ F1: 'P', F2: 'P', G: 'F2', H: 'F2' });
  });

  it('matches across different first timestamps (the copy drops early bookkeeping records)', () => {
    expect(P.createdAt).not.toBe(F1.createdAt);
    expect(resolveForkParents([P, F1]).get('F1')).toBe('P');
  });

  it('never picks a descendant that holds the fork\'s own messages', () => {
    // Without P on the board, F2's only candidates descend from it.
    expect(resolveForkParents([F2, G, H]).get('F2')).toBeUndefined();
  });

  it('picks the candidate that carried the parent title over a later sibling', () => {
    // S was forked from P after m3; F was forked from P at m2 later on.
    const S = node('S', {
      forkTitle: 'X (fork)', titles: ['X (fork)'], forkPoint: 'm3', firstOwnId: 's1',
      forkedAt: '2026-10-02T10:00:00.000Z', ids: ['m1', 'm2', 'm3', 's1'],
    });
    const F = node('F', {
      forkTitle: 'X (fork)', titles: ['X (fork)'], forkPoint: 'm2', firstOwnId: 'f1',
      forkedAt: '2026-10-03T10:00:00.000Z', ids: ['m1', 'm2', 'f1'],
    });
    expect(resolveForkParents([S, F, P]).get('F')).toBe('P');
  });

  it('falls back to the oldest candidate when the parent was renamed out of its title', () => {
    const Q = node('Q', { titles: ['renamed'], ids: ['m1', 'm2'] });
    const F = node('F', {
      forkTitle: 'old name (fork)', forkPoint: 'm2', forkedAt: '2026-10-03T10:00:00.000Z', ids: ['m1', 'm2'],
    });
    expect(resolveForkParents([Q, F]).get('F')).toBe('Q');
  });

  it('leaves a fork unlinked when its parent is not on the board', () => {
    expect(resolveForkParents([F1]).size).toBe(0);
  });

  it('leaves non-forks unlinked', () => {
    expect(resolveForkParents([P]).size).toBe(0);
  });
});

describe('ConversationParser lineage facts', () => {
  let parser: ConversationParser;

  beforeEach(() => {
    parser = new ConversationParser();
    vi.clearAllMocks();
    vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));
  });

  function parse(lines: object[], filePath: string, birthtimeMs?: number) {
    const content = lines.map(l => JSON.stringify(l)).join('\n');
    vi.mocked(fsp.stat).mockResolvedValue({ size: Buffer.byteLength(content, 'utf-8'), birthtimeMs } as any);
    vi.mocked(fsp.readFile).mockResolvedValue(content);
    return parser.parseFile(filePath);
  }

  const user = (text: string, timestamp: string) => ({
    type: 'user', timestamp, sessionId: 's', parentUuid: null, isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  const assistant = (id: string, text: string, timestamp: string) => ({
    type: 'assistant', timestamp, sessionId: 's', parentUuid: null, isSidechain: false,
    message: { role: 'assistant', id, content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });

  it('reads a fork: title, fork point, first own message and fork time', async () => {
    const conv = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      assistant('m1', 'Looking.', '2026-10-01T16:56:00.000Z'),
      assistant('m2', 'Done.', '2026-10-01T16:57:00.000Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
      { type: 'atis-latch', sessionId: 's' },
      user('lets continue', '2026-10-05T16:29:52.742Z'),
      assistant('a1', 'Continuing.', '2026-10-05T16:30:00.000Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
    ], '/p/fork.jsonl');

    expect(conv!.title).toBe('Exalt accuracy (fork)');
    expect(conv!.forkTitle).toBe('Exalt accuracy (fork)');
    expect(conv!.forkedAt).toBe('2026-10-05T16:29:52.742Z');
    const facts = parser.lineageFacts('/p/fork.jsonl')!;
    expect(facts.forkPoint).toBe('m2');
    expect(facts.firstOwnId).toBe('a1');
    expect([...facts.messageIds]).toEqual(['m1', 'm2', 'a1']);
  });

  it('keeps the fork title after the fork is renamed', async () => {
    const conv = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      assistant('m1', 'Looking.', '2026-10-01T16:56:00.000Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
      { type: 'custom-title', customTitle: 'Exalt - clean up', sessionId: 's' },
    ], '/p/renamed.jsonl');

    expect(conv!.title).toBe('Exalt - clean up');
    expect(conv!.forkTitle).toBe('Exalt accuracy (fork)');
    expect([...parser.lineageFacts('/p/renamed.jsonl')!.titles]).toEqual(['Exalt accuracy (fork)', 'Exalt - clean up']);
  });

  it('does not take a renamed session for a fork', async () => {
    const conv = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      assistant('m1', 'Looking.', '2026-10-01T16:56:00.000Z'),
      { type: 'ai-title', aiTitle: 'Exalt Health takeoff accuracy', sessionId: 's' },
      { type: 'custom-title', customTitle: 'bug: Exalt accuracy', sessionId: 's' },
      // A later rename that happens to end in "(fork)" is still not a fork
      { type: 'custom-title', customTitle: 'bug: Exalt accuracy (fork)', sessionId: 's' },
    ], '/p/parent.jsonl');

    expect(conv!.forkTitle).toBeUndefined();
    const facts = parser.lineageFacts('/p/parent.jsonl')!;
    expect(facts.forkPoint).toBeUndefined();
    expect(facts.titles.has('Exalt Health takeoff accuracy')).toBe(true);
    expect(facts.titles.has('bug: Exalt accuracy')).toBe(true);
  });

  it('has no fork time until the fork writes a record of its own', async () => {
    const conv = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      assistant('m1', 'Looking.', '2026-10-01T16:56:00.000Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
      { type: 'atis-latch', sessionId: 's' },
    ], '/p/fresh.jsonl');

    expect(conv!.forkTitle).toBe('Exalt accuracy (fork)');
    expect(conv!.forkedAt).toBeUndefined();
    expect(parser.lineageFacts('/p/fresh.jsonl')!.firstOwnId).toBeUndefined();
  });

  it('dates a fork with no records of its own by when its file was created', async () => {
    const born = Date.parse('2026-10-05T20:55:50.000Z');
    const fork = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      assistant('m1', 'Looking.', '2026-10-01T16:56:00.000Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
    ], '/p/fresh-born.jsonl', born);
    expect(fork!.forkedAt).toBe('2026-10-05T20:55:50.000Z');
    expect(parser.lineageFacts('/p/fresh-born.jsonl')!.forkedAt).toBe('2026-10-05T20:55:50.000Z');

    // Its own first record wins once it has one; a non-fork gets no fork time
    const written = await parse([
      user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z'),
      { type: 'custom-title', customTitle: 'Exalt accuracy (fork)', sessionId: 's' },
      user('lets continue', '2026-10-05T21:00:00.000Z'),
    ], '/p/written.jsonl', born);
    expect(written!.forkedAt).toBe('2026-10-05T21:00:00.000Z');
    const plain = await parse([user('look at the Exalt sheets', '2026-10-01T16:55:37.254Z')], '/p/plain.jsonl', born);
    expect(plain!.forkedAt).toBeUndefined();
  });
});
