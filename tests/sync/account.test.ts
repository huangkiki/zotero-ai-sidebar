import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import {
  DEFAULT_SYNC_ACCOUNT,
  detectDataDir,
  detectProfileDir,
  effectiveDataDir,
  effectiveProfileDir,
  loadSyncAccount,
  normalizeSyncAccount,
  saveSyncAccount,
} from '../../src/sync/account';

afterEach(() => {
  vi.unstubAllGlobals();
});

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe('sync account storage', () => {
  it('returns defaults for missing or invalid settings', () => {
    expect(loadSyncAccount(memPrefs())).toEqual(DEFAULT_SYNC_ACCOUNT);
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.syncAccount', '{not json');
    expect(loadSyncAccount(prefs)).toEqual(DEFAULT_SYNC_ACCOUNT);
  });

  it('round-trips a saved WebDAV account including local backup paths', () => {
    const prefs = memPrefs();
    saveSyncAccount(prefs, {
      webdavUrl: 'https://dav.example.com/dav/',
      username: 'alice',
      password: 's3cret',
      remoteFolder: 'my/sub/folder',
      dataDir: '/home/alice/Zotero',
      profileDir: '/home/alice/.zotero/zotero/x.default',
      lastPushAt: '2026-05-02T10:00:00Z',
      lastPullAt: '',
    });
    expect(loadSyncAccount(prefs)).toEqual({
      webdavUrl: 'https://dav.example.com/dav/',
      username: 'alice',
      password: 's3cret',
      remoteFolder: 'my/sub/folder',
      dataDir: '/home/alice/Zotero',
      profileDir: '/home/alice/.zotero/zotero/x.default',
      lastPushAt: '2026-05-02T10:00:00Z',
      lastPullAt: '',
    });
  });

  it('strips redundant slashes from the remote folder', () => {
    const account = normalizeSyncAccount({ remoteFolder: '///foo//bar///' });
    expect(account.remoteFolder).toBe('foo/bar');
  });

  it('falls back to the default folder when blank', () => {
    const account = normalizeSyncAccount({ remoteFolder: '   ' });
    expect(account.remoteFolder).toBe(DEFAULT_SYNC_ACCOUNT.remoteFolder);
  });
});

describe('directory detection', () => {
  it('reads dataDir/profileDir from the running Zotero when set', () => {
    vi.stubGlobal('Zotero', {
      DataDirectory: { dir: '/zotero/data' },
      Profile: { dir: '/zotero/profile/abc' },
    });
    expect(detectDataDir()).toBe('/zotero/data');
    expect(detectProfileDir()).toBe('/zotero/profile/abc');
  });

  it('accepts the older DataDirectory.path shape', () => {
    vi.stubGlobal('Zotero', {
      DataDirectory: { path: '/legacy/data' },
      Profile: { dir: '/profile' },
    });
    expect(detectDataDir()).toBe('/legacy/data');
  });

  it('returns hint defaults when Zotero dir APIs are absent', () => {
    vi.stubGlobal('Zotero', {});
    expect(detectDataDir()).toBe('~/Zotero');
    expect(detectProfileDir()).toBe('~/.zotero/zotero/<profile>');
  });

  it('prefers the user-stored path over the auto-detected one', () => {
    vi.stubGlobal('Zotero', {
      DataDirectory: { dir: '/auto/data' },
      Profile: { dir: '/auto/profile' },
    });
    expect(
      effectiveDataDir({
        ...DEFAULT_SYNC_ACCOUNT,
        dataDir: '/manual/data',
      }),
    ).toBe('/manual/data');
    expect(
      effectiveProfileDir({
        ...DEFAULT_SYNC_ACCOUNT,
        profileDir: '',
      }),
    ).toBe('/auto/profile');
  });
});
