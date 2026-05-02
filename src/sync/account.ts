import type { PrefsStore } from '../settings/storage';

// Cloud-sync account credentials persisted in Zotero prefs.
//
// WHY a single JSON blob (mirrors presets/ui-settings/tool-settings): keeps
// the surface area small and lets us evolve the shape without registering
// new prefs each time.
//
// SECURITY note: the WebDAV password sits next to API keys in the prefs
// file. Same trust model as everything else in this plugin — any local
// process with read access to the Zotero profile can read these.

export interface SyncAccount {
  webdavUrl: string;
  username: string;
  password: string;
  remoteFolder: string;
  // Local paths the plugin knows about for backup-command generation.
  // Stored even when blank — defaults come from Zotero.DataDirectory.dir
  // and Zotero.Profile.dir resolved at render time, so the on-disk record
  // can stay portable across machines.
  dataDir: string;
  profileDir: string;
  lastPushAt: string;
  lastPullAt: string;
}

export const DEFAULT_SYNC_ACCOUNT: SyncAccount = {
  // 坚果云 (Nutstore) is the most common WebDAV target for Zotero users in
  // China; pre-fill it as a hint. Users on NextCloud/ownCloud/Synology just
  // overwrite this with their server URL.
  webdavUrl: 'https://dav.jianguoyun.com/dav/',
  username: '',
  password: '',
  remoteFolder: 'zotero-ai-sidebar',
  dataDir: '',
  profileDir: '',
  lastPushAt: '',
  lastPullAt: '',
};

const KEY = 'extensions.zotero-ai-sidebar.syncAccount';
const URL_MAX = 512;
const USER_MAX = 256;
const PASS_MAX = 1024;
const FOLDER_MAX = 256;
const PATH_MAX = 1024;

export function loadSyncAccount(prefs: PrefsStore): SyncAccount {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_SYNC_ACCOUNT;
  try {
    return normalizeSyncAccount(JSON.parse(raw));
  } catch {
    return DEFAULT_SYNC_ACCOUNT;
  }
}

export function saveSyncAccount(prefs: PrefsStore, account: SyncAccount): void {
  prefs.set(KEY, JSON.stringify(normalizeSyncAccount(account)));
}

export function normalizeSyncAccount(value: unknown): SyncAccount {
  const input =
    value && typeof value === 'object'
      ? (value as Partial<SyncAccount>)
      : {};
  return {
    webdavUrl: trimTo(input.webdavUrl, URL_MAX) || DEFAULT_SYNC_ACCOUNT.webdavUrl,
    username: trimTo(input.username, USER_MAX),
    password: trimTo(input.password, PASS_MAX),
    remoteFolder:
      sanitizeFolder(input.remoteFolder) || DEFAULT_SYNC_ACCOUNT.remoteFolder,
    dataDir: trimTo(input.dataDir, PATH_MAX),
    profileDir: trimTo(input.profileDir, PATH_MAX),
    lastPushAt: trimTo(input.lastPushAt, 64),
    lastPullAt: trimTo(input.lastPullAt, 64),
  };
}

// Auto-detected directory defaults pulled from the running Zotero. We do
// NOT bake these into the persisted SyncAccount because the same prefs
// blob may be pulled from the cloud onto a different machine where these
// paths differ — `effectiveDataDir`/`effectiveProfileDir` always prefers
// the user-set value and falls back to the local Zotero APIs.
export function effectiveDataDir(account: SyncAccount): string {
  return account.dataDir || detectDataDir();
}

export function effectiveProfileDir(account: SyncAccount): string {
  return account.profileDir || detectProfileDir();
}

export function detectDataDir(): string {
  // Two API shapes have shipped: Zotero.DataDirectory.dir (modern) and
  // Zotero.DataDirectory.path (older). Try both, then fall back to '~/Zotero'
  // as a hint so the UI never shows a blank field on an unfamiliar build.
  const Z = (globalThis as unknown as { Zotero?: ZoteroDirsLike }).Zotero;
  return (
    Z?.DataDirectory?.dir ?? Z?.DataDirectory?.path ?? '~/Zotero'
  );
}

export function detectProfileDir(): string {
  const Z = (globalThis as unknown as { Zotero?: ZoteroDirsLike }).Zotero;
  return Z?.Profile?.dir ?? '~/.zotero/zotero/<profile>';
}

interface ZoteroDirsLike {
  DataDirectory?: { dir?: string; path?: string };
  Profile?: { dir?: string };
}

function trimTo(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function sanitizeFolder(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Strip leading/trailing slashes; collapse internal "//" runs. WHY: WebDAV
  // path joining is sensitive to double slashes (some servers 404), so the
  // orchestrator can rebuild a clean URL with one slash between segments.
  return value
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .slice(0, FOLDER_MAX);
}
