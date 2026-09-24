import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { TabManager } from '../providers/TabManager';
import type { Conversation } from '../types';

// Replays tab sequences seen in real Cursor/VS Code logs: Claude Code renames
// a tab to the session title, and after a restart every tab is unmapped.

interface FakeTab { label: string; isDirty: boolean; input: unknown }
interface FakeGroup { isActive: boolean; viewColumn: number; tabs: FakeTab[]; activeTab: FakeTab | undefined }

const ELLIPSIS = '…';
let groups: FakeGroup[];
let closed: string[];
let conversations: Array<Pick<Conversation, 'id' | 'title' | 'status'>>;

const claudeTab = (label: string): FakeTab => ({
  label, isDirty: false, input: new vscode.TabInputWebview('mainThreadWebview-claudeVSCodePanel'),
});
const group = (tabs: FakeTab[], active = 0): FakeGroup => {
  const g = { isActive: true, viewColumn: 1, tabs, activeTab: tabs[active] };
  groups.push(g);
  return g;
};

function makeManager() {
  const stateManager = {
    getConversations: () => conversations,
    getConversation: (id: string) => conversations.find(c => c.id === id),
  };
  return new TabManager(stateManager as never);
}

beforeEach(() => {
  groups = [];
  closed = [];
  conversations = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Object.assign(vscode.window.tabGroups, {
    get all() { return groups; },
    close: vi.fn(async (t: FakeTab | FakeTab[]) => {
      for (const tab of Array.isArray(t) ? t : [t]) {
        closed.push(tab.label);
        for (const g of groups) g.tabs = g.tabs.filter(x => x !== tab);
      }
    }),
  });
  (vscode.window as Record<string, unknown>).activeTerminal = undefined;
});

describe('TabManager', () => {
  it('adopts a tab renamed to its session title instead of closing it', () => {
    const tab = claudeTab('Claude Code');
    group([tab]);
    conversations = [{ id: 'a', title: 'Fix login redirect', status: 'in-progress' }];
    const tm = makeManager();
    const focused: Array<string | null> = [];
    tm.onFocusChanged = id => focused.push(id);

    tab.label = 'Fix login redirect'; // Claude Code's rename_tab
    tm.pruneStaleTabMappings();
    tm.detectFocusedConversation();

    expect(closed).toEqual([]);
    expect(tm.getTabLabel('a')).toBe('Fix login redirect');
    expect(focused).toEqual(['a']);
  });

  it('adopts a restored tab whose label Claude Code truncated', () => {
    group([claudeTab(`Investigate slow startu${ELLIPSIS}`)]);
    conversations = [
      { id: 'a', title: 'Investigate slow startup on macOS', status: 'done' },
      { id: 'b', title: 'Something else', status: 'done' },
    ];
    const tm = makeManager();
    tm.detectFocusedConversation();

    expect(tm.getTabLabel('a')).toBe(`Investigate slow startu${ELLIPSIS}`);
    expect(closed).toEqual([]);
  });

  it('leaves a tab alone when forked sessions share its title', () => {
    group([claudeTab('Deploy to staging')]);
    conversations = [
      { id: 'parent', title: 'Deploy to staging', status: 'done' },
      { id: 'fork', title: 'Deploy to staging', status: 'done' },
    ];
    const tm = makeManager();
    tm.detectFocusedConversation();

    expect(tm.getTabLabel('parent')).toBeUndefined();
    expect(tm.getTabLabel('fork')).toBeUndefined();
    expect(closed).toEqual([]);
  });

  it('focuses and adopts an unmapped tab that already shows the conversation', async () => {
    const other = { label: 'notes.md', isDirty: false, input: {} };
    group([other, claudeTab('Deploy to staging')]);
    conversations = [{ id: 'a', title: 'Deploy to staging', status: 'done' }];
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const tm = makeManager();

    expect(await tm.focusUnmappedTabForConversation('a')).toBe(true);
    expect(exec).toHaveBeenCalledWith('workbench.action.openEditorAtIndex', 1);
    expect(tm.getTabLabel('a')).toBe('Deploy to staging');
    expect(await tm.focusUnmappedTabForConversation('missing')).toBe(false);
  });

  it('clean sweep keeps live tabs after a restart and closes blanks and duplicates', async () => {
    group([
      claudeTab('Deploy to staging'),
      claudeTab(`Investigate slow startu${ELLIPSIS}`),
      claudeTab('Claude Code'),
      claudeTab('Deploy to staging'),
    ]);
    conversations = [
      { id: 'a', title: 'Deploy to staging', status: 'done' },
      { id: 'b', title: 'Investigate slow startup on macOS', status: 'done' },
    ];
    const tm = makeManager();

    expect(await tm.closeEmptyClaudeTabs()).toBe(2);
    expect(closed.sort()).toEqual(['Claude Code', 'Deploy to staging']);
  });
});
