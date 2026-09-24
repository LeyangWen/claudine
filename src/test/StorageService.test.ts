import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import type { IPlatformAdapter } from '../platform/IPlatformAdapter';

const GLOBAL = '/tmp/claudine-global';

function makePlatform(folders: string[]) {
  const files = new Map<string, string>();
  const globalState = new Map<string, unknown>();
  const platform = {
    getGlobalStoragePath: () => GLOBAL,
    getWorkspaceFolders: () => folders,
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(async (p: string, data: string) => { files.set(p, String(data)); }),
    readFile: vi.fn(async (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return Buffer.from(files.get(p)!);
    }),
    setGlobalState: vi.fn(async (k: string, v: unknown) => { globalState.set(k, v); }),
    getGlobalState: vi.fn((k: string, d: unknown) => (globalState.has(k) ? globalState.get(k) : d)),
  } as unknown as IPlatformAdapter;
  return { platform, files, globalState };
}

const state = { conversations: [], lastUpdated: new Date(0) };

describe('StorageService board state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes a folderless board to a file, not to shared global state', async () => {
    const { platform, files, globalState } = makePlatform([]);
    const storage = new StorageService(platform);
    await storage.saveBoardState(state);
    expect(files.has(path.join(GLOBAL, 'boardState.json'))).toBe(true);
    expect(globalState.has('boardState')).toBe(false);
  });

  it('reads the folderless board back from its file', async () => {
    const { platform } = makePlatform([]);
    const storage = new StorageService(platform);
    await storage.saveBoardState(state);
    expect(await storage.loadBoardState()).toEqual(JSON.parse(JSON.stringify(state)));
  });

  it('falls back to the global-state board older versions saved', async () => {
    const { platform, globalState } = makePlatform([]);
    globalState.set('boardState', { conversations: [], lastUpdated: 'old' });
    const storage = new StorageService(platform);
    expect(await storage.loadBoardState()).toEqual({ conversations: [], lastUpdated: 'old' });
  });

  it('still writes .claudine/state.json when the window has a folder', async () => {
    const { platform, files } = makePlatform(['/work/repo']);
    const storage = new StorageService(platform);
    await storage.saveBoardState(state);
    expect(files.has(path.join('/work/repo', '.claudine', 'state.json'))).toBe(true);
    expect(files.has(path.join(GLOBAL, 'boardState.json'))).toBe(false);
  });
});
