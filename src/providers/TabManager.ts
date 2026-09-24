import * as vscode from 'vscode';
import { StateManager } from '../services/StateManager';
import { FOCUS_DETECTION_DEBOUNCE_MS } from '../constants';

/**
 * Manages the bidirectional mapping between Claude Code editor tabs and
 * Claudine conversation IDs.  Handles tab focus detection and stale tab
 * cleanup.
 *
 * The map is keyed by tab label, lives only in memory, and loses an entry
 * whenever Claude Code renames a tab to the session title. An unmapped tab
 * whose label matches exactly one conversation is therefore adopted back into
 * the map. Claudine never closes a Claude tab on its own: Claude Code restores
 * its panels with their sessions after a restart, so an unmapped tab is a live
 * session, not an empty shell.
 */
/** Claude Code shortens long tab titles and ends them with this character. */
const ELLIPSIS = '\u2026';
/** Shortest truncated label that may be matched by prefix. */
const MIN_TRUNCATED_PREFIX = 8;

export class TabManager {
  // Bidirectional tab ↔ conversation mapping
  private _tabToConversation = new Map<string, string>(); // tab label → conversationId
  private _conversationToTab = new Map<string, string>(); // conversationId → tab label

  // Focus detection debounce & suppression
  private _focusDetectionTimer: ReturnType<typeof setTimeout> | undefined;
  private _suppressFocusUntil = 0;

  private _onFocusChanged: (conversationId: string | null) => void = () => {};

  constructor(private readonly _stateManager: StateManager) {}

  /** Register a callback fired whenever the focused conversation changes. */
  set onFocusChanged(cb: (conversationId: string | null) => void) {
    this._onFocusChanged = cb;
  }

  /** Suppress event-driven focus detection for the given duration. */
  suppressFocus(ms: number) {
    this._suppressFocusUntil = Date.now() + ms;
  }

  // ── Tab identification ──────────────────────────────────────────────

  /** Check if a tab is a Claude Code Visual Editor (not Claudine). */
  isClaudeCodeTab(tab: vscode.Tab): boolean {
    const input = tab.input;
    return (
      input instanceof vscode.TabInputWebview &&
      /claude/i.test(input.viewType) &&
      !/claudine/i.test(input.viewType)
    );
  }

  // ── Tab ↔ conversation mapping ─────────────────────────────────────

  /** Record a mapping between a conversation and the currently active Claude tab. */
  recordActiveTabMapping(conversationId: string) {
    for (const group of vscode.window.tabGroups.all) {
      if (!group.isActive) continue;
      const tab = group.activeTab;
      if (tab && this.isClaudeCodeTab(tab)) {
        const oldLabel = this._conversationToTab.get(conversationId);
        if (oldLabel) this._tabToConversation.delete(oldLabel);

        this._tabToConversation.set(tab.label, conversationId);
        this._conversationToTab.set(conversationId, tab.label);
        console.log(`Claudine: Mapped tab "${tab.label}" → conversation ${conversationId}`);
        return;
      }
    }
  }

  /** Remove mappings for tabs that no longer exist. */
  pruneStaleTabMappings() {
    const allLabels = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.isClaudeCodeTab(tab)) {
          allLabels.add(tab.label);
        }
      }
    }

    for (const [label, convId] of this._tabToConversation) {
      if (!allLabels.has(label)) {
        this._tabToConversation.delete(label);
        this._conversationToTab.delete(convId);
        console.log(`Claudine: Pruned stale tab mapping "${label}"`);
      }
    }
  }

  /** Get the known tab label for a conversation, if any. */
  getTabLabel(conversationId: string): string | undefined {
    return this._conversationToTab.get(conversationId);
  }

  /**
   * IDs of conversations whose title matches a tab label: exactly, or by
   * prefix when Claude Code truncated a long title with an ellipsis. Forked
   * sessions share their parent's title, so callers must treat more than one
   * match as ambiguous.
   */
  matchTitle(label: string): string[] {
    const tabLabel = (label || '').toLowerCase().trim();
    if (!tabLabel) return [];
    const prefix = tabLabel.endsWith(ELLIPSIS) ? tabLabel.slice(0, -1).trimEnd() : null;

    const ids: string[] = [];
    for (const conv of this._stateManager.getConversations()) {
      const title = (conv.title || '').toLowerCase().trim();
      if (!title) continue;
      if (title === tabLabel || (prefix && prefix.length >= MIN_TRUNCATED_PREFIX && title.startsWith(prefix))) {
        ids.push(conv.id);
      }
    }
    return ids;
  }

  /** Map a tab label to a conversation, replacing either side's old mapping. */
  adoptTab(label: string, conversationId: string) {
    const oldLabel = this._conversationToTab.get(conversationId);
    if (oldLabel && oldLabel !== label) this._tabToConversation.delete(oldLabel);
    const oldConversation = this._tabToConversation.get(label);
    if (oldConversation && oldConversation !== conversationId) this._conversationToTab.delete(oldConversation);

    this._tabToConversation.set(label, conversationId);
    this._conversationToTab.set(conversationId, label);
    console.log(`Claudine: Adopted tab "${label}" → conversation ${conversationId}`);
  }

  /** Remove a stale tab mapping for a conversation. */
  removeMapping(conversationId: string) {
    const label = this._conversationToTab.get(conversationId);
    if (label) {
      this._tabToConversation.delete(label);
      this._conversationToTab.delete(conversationId);
    }
  }

  // ── Tab operations ──────────────────────────────────────────────────

  /**
   * Close empty and duplicate Claude Code Visual Editor tabs (user action).
   *
   * A tab is closed when it duplicates another tab's label, or when it is
   * unmapped and its label matches no conversation title. An empty map does
   * NOT mean every tab is an empty shell: the map is in-memory and starts
   * empty after every restart, while the restored tabs hold live sessions.
   */
  async closeEmptyClaudeTabs(): Promise<number> {
    const tabsToClose: vscode.Tab[] = [];
    const seenLabels = new Set<string>();

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!this.isClaudeCodeTab(tab)) continue;
        if (tab.isDirty) continue;

        if (seenLabels.has(tab.label)) {
          tabsToClose.push(tab);
          continue;
        }
        seenLabels.add(tab.label);

        if (this._tabToConversation.has(tab.label)) continue;
        if (this.matchTitle(tab.label).length > 0) continue;

        tabsToClose.push(tab);
      }
    }

    if (tabsToClose.length === 0) return 0;

    console.log(`Claudine: Clean sweep — closing ${tabsToClose.length} empty/duplicate Claude tab(s)`);
    await vscode.window.tabGroups.close(tabsToClose);
    return tabsToClose.length;
  }

  /**
   * Focus an unmapped Claude tab that already shows this conversation (its
   * label matches only this conversation's title) and adopt it. Returns false
   * when there is no such tab, so the caller can open one.
   */
  async focusUnmappedTabForConversation(conversationId: string): Promise<boolean> {
    for (const group of vscode.window.tabGroups.all) {
      for (let i = 0; i < group.tabs.length; i++) {
        const tab = group.tabs[i];
        if (!this.isClaudeCodeTab(tab)) continue;
        if (this._tabToConversation.has(tab.label)) continue;
        const matches = this.matchTitle(tab.label);
        if (matches.length === 1 && matches[0] === conversationId) {
          await this.focusTabAtIndex(group, i);
          this.adoptTab(tab.label, conversationId);
          return true;
        }
      }
    }
    return false;
  }

  /** Focus a specific Claude Code tab by its label. */
  async focusTabByLabel(label: string): Promise<boolean> {
    for (const group of vscode.window.tabGroups.all) {
      for (let i = 0; i < group.tabs.length; i++) {
        const tab = group.tabs[i];
        if (tab.label === label && this.isClaudeCodeTab(tab)) {
          await this.focusTabAtIndex(group, i);
          return true;
        }
      }
    }
    return false;
  }

  /** Focus ANY open Claude Code editor tab (first found). */
  async focusAnyClaudeTab(): Promise<boolean> {
    for (const group of vscode.window.tabGroups.all) {
      for (let i = 0; i < group.tabs.length; i++) {
        if (this.isClaudeCodeTab(group.tabs[i])) {
          await this.focusTabAtIndex(group, i);
          return true;
        }
      }
    }
    return false;
  }

  private async focusTabAtIndex(group: vscode.TabGroup, index: number) {
    const focusCmds = [
      'workbench.action.focusFirstEditorGroup',
      'workbench.action.focusSecondEditorGroup',
      'workbench.action.focusThirdEditorGroup',
    ];
    const groupIdx = (group.viewColumn ?? 1) - 1;
    if (groupIdx >= 0 && groupIdx < focusCmds.length) {
      await vscode.commands.executeCommand(focusCmds[groupIdx]);
    }
    await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
  }

  // ── Focus detection ─────────────────────────────────────────────────

  /** Schedule a debounced focus detection. */
  scheduleFocusDetection() {
    clearTimeout(this._focusDetectionTimer);
    if (Date.now() < this._suppressFocusUntil) return;
    this._focusDetectionTimer = setTimeout(() => {
      this.detectFocusedConversation();
    }, FOCUS_DETECTION_DEBOUNCE_MS);
  }

  /**
   * Detect which Claude Code conversation is currently focused
   * by checking: 1) active Claude Code Visual Editor tabs, 2) active terminals.
   */
  detectFocusedConversation() {
    let focusedId: string | null = null;

    const claudeTab = this.getActiveClaudeCodeTab();
    if (claudeTab) {
      const isMapped = this._tabToConversation.has(claudeTab.label);
      focusedId = this.matchTabToConversation(claudeTab);

      // Unmapped tab (restored after a restart, or renamed by Claude Code):
      // adopt it when its label identifies exactly one conversation. Never
      // close it; it is a live session.
      if (!isMapped) {
        const matches = this.matchTitle(claudeTab.label);
        if (matches.length === 1) {
          focusedId = matches[0];
          this.adoptTab(claudeTab.label, focusedId);
        }
      }

      console.log(`Claudine: Focused Claude tab "${claudeTab.label}" → conversation ${focusedId}`);
    }

    // Fall back to terminal detection
    if (!focusedId) {
      const activeTerminal = vscode.window.activeTerminal;
      if (activeTerminal && /claude/i.test(activeTerminal.name) && !/claudine/i.test(activeTerminal.name)) {
        const activeConv = this._stateManager.getConversations().find(c => c.status === 'in-progress');
        if (activeConv) {
          focusedId = activeConv.id;
        }
      }
    }

    this._onFocusChanged(focusedId);
  }

  private getActiveClaudeCodeTab(): vscode.Tab | null {
    for (const group of vscode.window.tabGroups.all) {
      if (!group.isActive) continue;
      const tab = group.activeTab;
      if (tab && this.isClaudeCodeTab(tab)) return tab;
    }
    return null;
  }

  private matchTabToConversation(tab: vscode.Tab): string | null {
    const mapped = this._tabToConversation.get(tab.label);
    if (mapped) return mapped;

    const conversations = this._stateManager.getConversations();
    const tabLabel = tab.label.toLowerCase().trim();

    for (const conv of conversations) {
      if (conv.title.toLowerCase().trim() === tabLabel) return conv.id;
    }

    for (const conv of conversations) {
      const title = conv.title.toLowerCase().trim();
      if (title && tabLabel && (tabLabel.includes(title) || title.includes(tabLabel))) {
        return conv.id;
      }
    }

    return null;
  }

  dispose() {
    clearTimeout(this._focusDetectionTimer);
  }
}
