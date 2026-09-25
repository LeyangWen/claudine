import { IPlatformAdapter, PlatformEvent, PlatformEventEmitter } from '../platform/IPlatformAdapter';
import { StorageService, StarredEntry } from './StorageService';
import { Conversation, ConversationStatus, StarMark } from '../types';
import { SAVE_STATE_DEBOUNCE_MS, NOTIFY_COALESCE_MS, BACKGROUND_TASK_SILENCE_MS } from '../constants';

export class StateManager {
  private _conversations: Map<string, Conversation> = new Map();
  private _onConversationsChanged: PlatformEventEmitter<Conversation[]>;
  private _onNeedsInput: PlatformEventEmitter<Conversation>;
  private _onRateLimitDetected: PlatformEventEmitter<Conversation>;

  public readonly onConversationsChanged: PlatformEvent<Conversation[]>;
  /** Fires when a conversation transitions into 'needs-input' status. */
  public readonly onNeedsInput: PlatformEvent<Conversation>;
  /** Fires when a conversation becomes rate-limited (transition from not-limited to limited). */
  public readonly onRateLimitDetected: PlatformEvent<Conversation>;

  /** Resolves when saved state has been loaded from disk. Await before scanning. */
  public readonly ready: Promise<void>;
  private _readyResolve!: () => void;
  private _saveTimer: ReturnType<typeof setTimeout> | undefined;
  private _notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private _sortedCache: Conversation[] | null = null;
  private _stars: Map<string, StarMark> | null = null;

  constructor(
    private readonly _storageService: StorageService,
    platform: IPlatformAdapter
  ) {
    this._onConversationsChanged = platform.createEventEmitter<Conversation[]>();
    this.onConversationsChanged = this._onConversationsChanged.event;
    this._onNeedsInput = platform.createEventEmitter<Conversation>();
    this.onNeedsInput = this._onNeedsInput.event;
    this._onRateLimitDetected = platform.createEventEmitter<Conversation>();
    this.onRateLimitDetected = this._onRateLimitDetected.event;

    this.ready = new Promise(resolve => { this._readyResolve = resolve; });
    this.loadState();
  }

  private async loadState() {
    try {
      const savedState = await this._storageService.loadBoardState();
      if (savedState?.conversations) {
        for (const conv of savedState.conversations) {
          this._conversations.set(conv.id, {
            ...conv,
            createdAt: new Date(conv.createdAt),
            updatedAt: new Date(conv.updatedAt)
          });
        }
      }
      this.reloadStars();
      for (const conv of this._conversations.values()) this.applyStar(conv);
    } finally {
      this._readyResolve();
    }
  }

  private scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const conversations = this.getConversations();
      this._storageService.saveBoardState({
        conversations,
        lastUpdated: new Date()
      });
    }, SAVE_STATE_DEBOUNCE_MS);
  }

  /** Flush any pending debounced save immediately (e.g. on dispose). */
  public flushSave() {
    if (this._saveTimer !== undefined) {
      clearTimeout(this._saveTimer);
      this._saveTimer = undefined;
      const conversations = this.getConversations();
      this._storageService.saveBoardState({
        conversations,
        lastUpdated: new Date()
      });
    }
  }

  public getConversations(): Conversation[] {
    if (!this._sortedCache) {
      this._sortedCache = Array.from(this._conversations.values())
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
    return this._sortedCache;
  }

  public getConversation(id: string): Conversation | undefined {
    return this._conversations.get(id);
  }

  public setConversations(conversations: Conversation[]) {
    // Another window may have starred or unstarred something
    this.reloadStars();

    // Build the new set of IDs from the scan results
    const scannedIds = new Set(conversations.map(c => c.id));

    // Remove conversations that no longer have a JSONL file on disk
    for (const id of this._conversations.keys()) {
      if (!scannedIds.has(id)) {
        this._conversations.delete(id);
      }
    }

    // Merge with existing conversations, preserving manual overrides
    for (const conv of conversations) {
      const existing = this._conversations.get(conv.id);
      const prevStatus = existing?.status;
      const wasRateLimited = existing?.isRateLimited ?? false;
      this.mergeWithExisting(conv);
      this._conversations.set(conv.id, conv);
      if (conv.status === 'needs-input' && prevStatus && prevStatus !== 'needs-input') {
        this._onNeedsInput.fire(conv);
      }
      if (conv.isRateLimited && !wasRateLimited) {
        this._onRateLimitDetected.fire(conv);
      }
    }

    this.archiveStaleConversations();
    this.invalidateSort();
    this.notifyChange();
    this.scheduleSave();
  }

  private reloadStars() {
    this.setStars(this._storageService.readStarred());
  }

  private setStars(starred: Record<string, StarredEntry>) {
    this._stars = new Map(Object.entries(starred).map(([id, e]) => [id, e.mark === 'paused' ? 'paused' : 'starred']));
  }

  private applyStar(conv: Conversation) {
    if (!this._stars) this.reloadStars();
    const mark = this._stars!.get(conv.id);
    if (mark) conv.star = mark;
    else delete conv.star;
  }

  /**
   * Advance a conversation's star, none -> starred -> paused -> none, and
   * persist it for every window.
   */
  public cycleStar(conversationId: string) {
    const starred = this._storageService.readStarred();
    const entry = starred[conversationId];
    if (!entry) {
      const conv = this._conversations.get(conversationId);
      starred[conversationId] = {
        title: conv?.title ?? '',
        workspacePath: conv?.workspacePath ?? '',
        starredAt: new Date().toISOString(),
        mark: 'starred',
      };
    } else if (entry.mark !== 'paused') {
      entry.mark = 'paused';
    } else {
      delete starred[conversationId];
    }
    try {
      this._storageService.writeStarred(starred);
    } catch (error) {
      console.error('Claudine: Error saving starred conversations', error);
    }
    this.setStars(starred);
    for (const conv of this._conversations.values()) this.applyStar(conv);
    this.invalidateSort();
    this.notifyChange();
    this.scheduleSave();
  }

  public updateConversation(conversation: Conversation) {
    const existing = this._conversations.get(conversation.id);
    const wasRateLimited = existing?.isRateLimited ?? false;
    this.mergeWithExisting(conversation);
    this._conversations.set(conversation.id, conversation);
    if (conversation.isRateLimited && !wasRateLimited) {
      this._onRateLimitDetected.fire(conversation);
    }
    this.invalidateSort();
    this.notifyChange();
    this.scheduleSave();
  }

  /**
   * Merge an incoming (parsed) conversation with the existing one.
   *
   * Handles two key scenarios:
   * 1. Manual status overrides (done/cancelled/archived/parked) are preserved until
   *    new activity is detected (updatedAt advances).
   * 2. Agent active→inactive transitions: when an agent was working (isActive)
   *    and becomes idle, the status is updated based on the conversation state
   *    and the status it had before the agent started working.
   *
   * IMPORTANT: `isActive` is based on a 2-minute time window, so it can flip
   * from true→false on a mere re-parse without any new content. We must only
   * trigger the transition when the JSONL file actually has new messages
   * (updatedAt advanced), not when the time window simply expires.
   */
  private mergeWithExisting(conv: Conversation) {
    this.applyStar(conv);
    const existing = this._conversations.get(conv.id);
    if (!existing) return;

    // Preserve icon
    if (existing.icon && !conv.icon) {
      conv.icon = existing.icon;
    }

    const hasNewContent = conv.updatedAt.getTime() > existing.updatedAt.getTime();

    // Preserve manual done/cancelled/archived/parked while no new messages arrive.
    // Also preserve updatedAt so the archive timer counts from when the status
    // was set (e.g. via moveConversation), not from the JSONL file's last activity.
    // Unlike done, a parked card that gets a new message rejoins the normal
    // cycle: it finishes in in-review, not back in parked.
    if (existing.status === 'done' || existing.status === 'cancelled' || existing.status === 'archived' || existing.status === 'parked') {
      if (!hasNewContent) {
        conv.status = existing.status;
        conv.previousStatus = existing.previousStatus;
        conv.updatedAt = existing.updatedAt;
        return;
      }
    }

    const wasActive = existing.agents.some(a => a.isActive);
    const isNowActive = conv.agents.some(a => a.isActive);

    // Track previousStatus: when a conversation enters in-progress, remember where it came from
    if (hasNewContent && conv.status === 'in-progress' && existing.status !== 'in-progress') {
      conv.previousStatus = existing.status;
    } else {
      // Carry forward the existing previousStatus
      conv.previousStatus = existing.previousStatus;
    }

    // Detect active → inactive transition (agent finished working).
    // Only trigger when the JSONL file has new content — a stale re-parse
    // where isRecentlyActive() naturally expires must NOT cause a transition.
    // BUG6: nor is it finished while its background tasks still run.
    if (wasActive && !isNowActive && hasNewContent && !conv.backgroundTasks) {
      const prev = conv.previousStatus;

      if (conv.hasError) {
        // Error → needs user attention
        conv.status = 'needs-input';
      } else if (conv.hasQuestion) {
        // Agent asked a question → needs user input
        conv.status = 'needs-input';
      } else if (prev === 'done') {
        // Was done, agent re-ran briefly → restore to done
        conv.status = 'done';
      } else if (prev === 'cancelled') {
        // Was cancelled, agent re-ran briefly → restore to cancelled
        conv.status = 'cancelled';
      } else if (prev === 'in-review') {
        // Was in-review, agent re-ran → back to in-review
        conv.status = 'in-review';
      } else if (prev === 'needs-input') {
        // Was needs-input, agent answered → in-review (completed the work)
        conv.status = 'in-review';
      } else {
        // Default: agent finished → in-review
        conv.status = 'in-review';
      }

      // Clear previousStatus since the transition is complete
      conv.previousStatus = undefined;
    }

    // No new content: preserve existing status (parser's detection is based
    // on the same stale data, so the existing status is more trustworthy).
    if (!hasNewContent && !isNowActive) {
      conv.status = existing.status;
    }
  }

  public removeConversation(id: string) {
    this._conversations.delete(id);
    this.invalidateSort();
    this.notifyChange();
    this.scheduleSave();
  }

  public moveConversation(id: string, newStatus: ConversationStatus) {
    const conversation = this._conversations.get(id);
    if (conversation) {
      // Manual moves clear previousStatus — the user explicitly chose this status
      conversation.previousStatus = undefined;
      conversation.status = newStatus;
      conversation.updatedAt = new Date();
      this._conversations.set(id, conversation);
      this.invalidateSort();
      this.notifyChange();
      this.scheduleSave();
    }
  }

  public setConversationIcon(id: string, icon: string) {
    const conversation = this._conversations.get(id);
    if (conversation) {
      conversation.icon = icon;
      this._conversations.set(id, conversation);
      this.invalidateSort();
      this.notifyChange();
      this.scheduleSave();
    }
  }

  public async clearAllIcons() {
    for (const conv of this._conversations.values()) {
      conv.icon = undefined;
    }
    this.invalidateSort();
    this.notifyChange();
    this.scheduleSave();
  }

  public getConversationsByStatus(status: ConversationStatus): Conversation[] {
    return this.getConversations().filter(c => c.status === status);
  }

  /** Get all conversations currently paused due to a rate limit. */
  public getRateLimitedConversations(): Conversation[] {
    return this.getConversations().filter(c => c.isRateLimited);
  }

  public async saveDrafts(drafts: Array<{ id: string; title: string }>): Promise<void> {
    await this._storageService.saveDrafts(drafts);
  }

  public async loadDrafts(): Promise<Array<{ id: string; title: string }>> {
    return this._storageService.loadDrafts();
  }

  private static readonly ARCHIVE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

  public archiveAllDone(): void {
    let changed = false;
    for (const conv of this._conversations.values()) {
      if (conv.status === 'done' || conv.status === 'cancelled') {
        conv.status = 'archived';
        conv.updatedAt = new Date();
        changed = true;
      }
    }
    if (changed) {
      this.invalidateSort();
      this.notifyChange();
      this.scheduleSave();
    }
  }

  public archiveStaleConversations(): void {
    const now = Date.now();
    let changed = false;

    for (const conv of this._conversations.values()) {
      if (
        (conv.status === 'done' || conv.status === 'cancelled') &&
        (now - conv.updatedAt.getTime()) >= StateManager.ARCHIVE_THRESHOLD_MS
      ) {
        conv.status = 'archived';
        changed = true;
      }
      // BUG6: a card held in progress for background tasks falls back to
      // in-review once its transcript has been silent too long. The parser
      // applies the same cutoff, but only when the file is read again.
      if (
        conv.status === 'in-progress' && conv.backgroundTasks &&
        (now - conv.updatedAt.getTime()) >= BACKGROUND_TASK_SILENCE_MS
      ) {
        conv.status = 'in-review';
        conv.backgroundTasks = 0;
        changed = true;
      }
    }

    if (changed) {
      this.invalidateSort();
      this.notifyChange();
      this.scheduleSave();
    }
  }

  private invalidateSort() {
    this._sortedCache = null;
  }

  private notifyChange() {
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => {
      this._onConversationsChanged.fire(this.getConversations());
    }, NOTIFY_COALESCE_MS);
  }
}
