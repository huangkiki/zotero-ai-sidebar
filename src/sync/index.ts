import type { PrefsStore } from '../settings/storage';
import {
  loadSyncAccount,
  saveSyncAccount,
  type SyncAccount,
} from './account';
import {
  applySyncSnapshot,
  buildSyncSnapshot,
  parseSyncSnapshot,
  type ApplySnapshotResult,
} from './state';
import {
  ensureFolder,
  getFile,
  putFile,
  testAuth,
  type WebDavConfig,
  WebDavError,
} from './webdav';

// Sync orchestrator: glues account creds + WebDAV verbs + snapshot codec
// into the three operations the preferences UI calls (test/push/pull).
//
// The single sync file lives at `<remoteFolder>/state.json`. WHY one file
// vs. one-per-section: makes pull atomic — we either replace local state
// with a coherent snapshot or leave everything alone. Multiple files would
// open up partial-pull windows where presets and chat history drift.

const SYNC_FILE_NAME = 'state.json';

export interface SyncTestResult {
  ok: boolean;
  message: string;
}

export interface SyncPushResult {
  ok: boolean;
  message: string;
  bytes: number;
}

export interface SyncPullResult {
  ok: boolean;
  message: string;
  applied?: ApplySnapshotResult;
  remoteExportedAt?: string;
}

export async function testSyncConnection(
  account: SyncAccount,
): Promise<SyncTestResult> {
  const config = toConfig(account);
  if (!config) return { ok: false, message: '请先填写 WebDAV URL、用户名和密码' };
  try {
    await testAuth(config);
    await ensureFolder(config, account.remoteFolder);
    return { ok: true, message: 'WebDAV 连接成功' };
  } catch (err) {
    return { ok: false, message: errorMessage('连接失败', err) };
  }
}

export async function pushToCloud(
  prefs: PrefsStore,
  account: SyncAccount,
): Promise<SyncPushResult> {
  const config = toConfig(account);
  if (!config) {
    return { ok: false, message: '请先填写 WebDAV 账号', bytes: 0 };
  }
  try {
    const snapshot = await buildSyncSnapshot(prefs);
    const body = JSON.stringify(snapshot, null, 2);
    await ensureFolder(config, account.remoteFolder);
    await putFile(config, syncFilePath(account), body);
    saveSyncAccount(prefs, { ...account, lastPushAt: new Date().toISOString() });
    return {
      ok: true,
      bytes: byteLength(body),
      message: `已上传 ${formatSize(byteLength(body))} 到 ${syncFilePath(account)}`,
    };
  } catch (err) {
    return { ok: false, bytes: 0, message: errorMessage('上传失败', err) };
  }
}

export async function pullFromCloud(
  prefs: PrefsStore,
  account: SyncAccount,
): Promise<SyncPullResult> {
  const config = toConfig(account);
  if (!config) return { ok: false, message: '请先填写 WebDAV 账号' };
  try {
    const result = await getFile(config, syncFilePath(account));
    if (!result.found) {
      return {
        ok: false,
        message: `云端尚未找到 ${syncFilePath(account)}，请先在另一台设备上点击“上传到云端”。`,
      };
    }
    const snapshot = parseSyncSnapshot(result.body);
    const applied = await applySyncSnapshot(prefs, snapshot);
    saveSyncAccount(prefs, { ...account, lastPullAt: new Date().toISOString() });
    return {
      ok: true,
      message: formatPullMessage(applied),
      applied,
      remoteExportedAt: snapshot.exportedAt,
    };
  } catch (err) {
    return { ok: false, message: errorMessage('下载失败', err) };
  }
}

function syncFilePath(account: SyncAccount): string {
  // Folder is already sanitized (no leading/trailing slashes) in account
  // normalization, so a single join is safe.
  return account.remoteFolder
    ? `${account.remoteFolder}/${SYNC_FILE_NAME}`
    : SYNC_FILE_NAME;
}

function toConfig(account: SyncAccount): WebDavConfig | null {
  if (!account.webdavUrl || !account.username || !account.password) return null;
  return {
    baseUrl: account.webdavUrl,
    username: account.username,
    password: account.password,
  };
}

function errorMessage(prefix: string, err: unknown): string {
  if (err instanceof WebDavError) {
    return `${prefix}：${err.message}`;
  }
  if (err instanceof Error) return `${prefix}：${err.message}`;
  return `${prefix}：${String(err)}`;
}

function formatPullMessage(applied: ApplySnapshotResult): string {
  const { threads, annotations } = applied;
  const lines = [
    `已应用云端配置（账号、显示、提示词、联网/MCP）。`,
    `对话历史：导入 ${threads.imported} 条 / 跳过本地更新 ${threads.unchanged} 条 / 未匹配本地条目 ${threads.unresolved} 条。`,
    `PDF 注释：导入 ${annotations.imported} 条 / 跳过本地更新 ${annotations.unchanged} 条 / 未匹配 PDF ${annotations.unresolved} 条 / 跳过其它 ${annotations.skipped} 条。`,
  ];
  if (threads.unresolved > 0 || annotations.unresolved > 0) {
    lines.push(
      '提示：未匹配的条目通常是 Zotero 主同步还没把对应论文 / PDF 拉过来；等 Zotero 同步完成后再点一次”从云端下载”即可。',
    );
  }
  return lines.join('\n');
}

function byteLength(text: string): number {
  // Approximate: each char encodes to ≤ 4 UTF-8 bytes; for ASCII-heavy
  // sync payloads, `Blob` is overkill. TextEncoder is available in Zotero's
  // privileged context and gives the exact count.
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
