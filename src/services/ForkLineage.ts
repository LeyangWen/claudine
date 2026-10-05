/**
 * Fork lineage: which conversation a forked session came from.
 *
 * Claude Code's Fork button copies the parent's history into a new session
 * file (new session id, new record uuids, original timestamps and API message
 * ids) and then appends a `custom-title` of "<parent title> (fork)". The tab
 * switches to the fork, so without a link the parent's card and the fork's
 * card look like one session listed twice. The transcript never names its
 * parent, so it is recovered here from what the copy keeps: the API message
 * ids. The copy does not keep every record (title and bookkeeping records are
 * left behind), so the first timestamps of parent and fork can differ.
 */

const FORK_SUFFIX = ' (fork)';

/** What the parser learns about a transcript for lineage. */
export interface LineageFacts {
  /** First custom-title of the file, when it is a fork title. */
  forkTitle?: string;
  /** API message id of the last assistant message copied from the parent. */
  forkPoint?: string;
  /** API message id of the fork's first assistant message of its own. */
  firstOwnId?: string;
  /** Timestamp of the first record the fork wrote itself. */
  forkedAt?: string;
  /** Every custom-title and ai-title the session has carried. */
  titles: ReadonlySet<string>;
  /** API message ids of the session's (non-sidechain) assistant messages. */
  messageIds: ReadonlySet<string>;
}

export interface LineageNode {
  id: string;
  /** Timestamp of the session's first record. */
  createdAt: string;
  facts: LineageFacts;
}

/** True when the first custom-title of a file names it a fork. */
export function isForkTitle(title: string): boolean {
  return title.endsWith(FORK_SUFFIX) && title.length > FORK_SUFFIX.length;
}

/** The parent's title at the moment of the fork: one " (fork)" suffix removed. */
export function parentTitleOf(forkTitle: string): string {
  return isForkTitle(forkTitle) ? forkTitle.slice(0, -FORK_SUFFIX.length) : forkTitle;
}

/** When a session started being itself: the fork moment for a fork. */
function bornAt(node: LineageNode): string | undefined {
  return node.facts.forkTitle ? node.facts.forkedAt : node.createdAt;
}

/**
 * Map each fork's id to its parent's id, for the forks whose parent is among
 * `nodes`.
 *
 * Candidates hold the fork's last copied message. Its own descendants hold it
 * too, so a candidate that also holds the fork's first message of its own, or
 * that started after the fork did, is dropped. A sibling forked from the same
 * parent at a later point still qualifies, so candidates that carried the
 * fork's parent title win, then the oldest one.
 */
export function resolveForkParents(nodes: LineageNode[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const fork of nodes) {
    const { forkTitle, forkPoint, firstOwnId } = fork.facts;
    if (!forkTitle || !forkPoint) continue;
    const forkBorn = bornAt(fork);

    let candidates = nodes.filter(m => {
      if (m === fork || !m.facts.messageIds.has(forkPoint)) return false;
      if (firstOwnId && m.facts.messageIds.has(firstOwnId)) return false;
      const born = bornAt(m);
      return !forkBorn || !born || born < forkBorn;
    });
    const wanted = parentTitleOf(forkTitle);
    const titled = candidates.filter(m => m.facts.titles.has(wanted));
    if (titled.length > 0) candidates = titled;
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const ab = bornAt(a), bb = bornAt(b);
      if (ab !== bb) return !ab ? 1 : !bb ? -1 : ab < bb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    parents.set(fork.id, candidates[0].id);
  }
  return parents;
}
