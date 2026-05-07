import {
  exportAllAnnotations,
  importAllAnnotations,
  type ImportAnnotationsResult,
  type PortableAnnotation,
} from './annotations';
import {
  exportAllThreads,
  importAllThreads,
  type ImportThreadsResult,
  type PortableThread,
} from '../settings/chat-history';
import {
  loadQuickPromptSettings,
  normalizeQuickPromptSettings,
  saveQuickPromptSettings,
  type QuickPromptSettings,
} from '../settings/quick-prompts';
import {
  loadPresets,
  normalizePresetList,
  savePresets,
  type PrefsStore,
} from '../settings/storage';
import {
  loadToolSettings,
  normalizeToolSettings,
  saveToolSettings,
  type ToolSettings,
} from '../settings/tool-settings';
import type { ModelPreset, TranslateSettings } from '../settings/types';
import {
  loadTranslateSettings,
  normalizeTranslateSettings,
  saveTranslateSettings,
} from '../translate/settings';
import {
  loadCache as loadTranslateCacheState,
  saveCache as saveTranslateCacheState,
  type TranslateCacheState,
} from '../translate/cache';
import {
  loadUiSettings,
  normalizeUiSettings,
  saveUiSettings,
  type UiSettings,
} from '../settings/ui-settings';

// Sync snapshot: the on-the-wire JSON we push to / pull from the cloud.
//
// `schema` is required so a future format break (e.g. moving to a binary
// chat-history transport) can be detected and rejected with a clear error
// instead of silently mis-merging.

export const SYNC_SCHEMA = 'zotero-ai-sidebar.sync.v1';

export interface SyncSnapshot {
  schema: typeof SYNC_SCHEMA;
  exportedAt: string;
  presets: ModelPreset[];
  uiSettings: UiSettings;
  quickPrompts: QuickPromptSettings;
  toolSettings: ToolSettings;
  threads: PortableThread[];
  // `annotations` was added after the initial v1 snapshot shipped, so it
  // stays optional on the wire — older payloads without it parse fine
  // and just yield zero imports.
  annotations: PortableAnnotation[];
  // Added v1.1 (still under SYNC_SCHEMA v1 — both fields are optional on
  // the wire). Older payloads without these parse to defaults.
  translateSettings?: TranslateSettings;
  translateCache?: TranslateCacheState;
}

export interface ApplySnapshotResult {
  threads: ImportThreadsResult;
  annotations: ImportAnnotationsResult;
}

export async function buildSyncSnapshot(prefs: PrefsStore): Promise<SyncSnapshot> {
  const [threads, annotations] = await Promise.all([
    exportAllThreads(),
    exportAllAnnotations(),
  ]);
  return {
    schema: SYNC_SCHEMA,
    exportedAt: new Date().toISOString(),
    presets: loadPresets(prefs),
    uiSettings: loadUiSettings(prefs),
    quickPrompts: loadQuickPromptSettings(prefs),
    toolSettings: loadToolSettings(prefs),
    threads: stripLocalTaskStateFromThreads(threads),
    annotations,
    translateSettings: loadTranslateSettings(prefs),
    translateCache: loadTranslateCacheState(prefs),
  };
}

export function parseSyncSnapshot(raw: string): SyncSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('云端配置 JSON 解析失败');
  }
  if (!isRecord(parsed)) throw new Error('云端配置必须是 JSON 对象');
  if (parsed.schema !== SYNC_SCHEMA) {
    throw new Error(
      `云端 schema 版本不兼容：本地 ${SYNC_SCHEMA}，云端 ${String(parsed.schema)}`,
    );
  }
  return {
    schema: SYNC_SCHEMA,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    presets: Array.isArray(parsed.presets)
      ? normalizePresetList(parsed.presets)
      : [],
    uiSettings: normalizeUiSettings(parsed.uiSettings),
    quickPrompts: normalizeQuickPromptSettings(parsed.quickPrompts),
    toolSettings: normalizeToolSettings(parsed.toolSettings),
    threads: normalizePortableThreads(parsed.threads),
    annotations: normalizePortableAnnotations(parsed.annotations),
    translateSettings: parsed.translateSettings === undefined
      ? undefined
      : normalizeTranslateSettings(parsed.translateSettings),
    translateCache: normalizeTranslateCache(parsed.translateCache),
  };
}

export async function applySyncSnapshot(
  prefs: PrefsStore,
  snapshot: SyncSnapshot,
): Promise<ApplySnapshotResult> {
  // Settings: write the full normalized blob — no per-key merge. Same
  // semantics as the existing config import in hooks.ts: pulling means
  // "make my local settings match the cloud". Chat threads ARE merged
  // per-thread (last-write-wins by updatedAt) so a partial pull doesn't
  // wipe out conversations recorded since the last push.
  savePresets(prefs, snapshot.presets);
  saveUiSettings(prefs, snapshot.uiSettings);
  saveQuickPromptSettings(prefs, snapshot.quickPrompts);
  saveToolSettings(prefs, snapshot.toolSettings);
  if (snapshot.translateSettings) saveTranslateSettings(prefs, snapshot.translateSettings);
  if (snapshot.translateCache) saveTranslateCacheState(prefs, snapshot.translateCache);
  const [threads, annotations] = await Promise.all([
    importAllThreads(snapshot.threads),
    importAllAnnotations(snapshot.annotations),
  ]);
  return { threads, annotations };
}

function normalizePortableThreads(value: unknown): PortableThread[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const libraryType =
      entry.libraryType === 'user' ||
      entry.libraryType === 'group' ||
      entry.libraryType === 'global'
        ? entry.libraryType
        : null;
    if (!libraryType) return [];
    const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : '';
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const portable: PortableThread = {
      libraryType,
      updatedAt,
      messages: stripLocalTaskState(messages as PortableThread['messages']),
    };
    if (libraryType === 'group' && typeof entry.groupID === 'number') {
      portable.groupID = entry.groupID;
    }
    if (libraryType !== 'global' && typeof entry.itemKey === 'string') {
      portable.itemKey = entry.itemKey;
    }
    if (libraryType !== 'global' && !portable.itemKey) return [];
    if (libraryType === 'group' && typeof portable.groupID !== 'number') {
      return [];
    }
    return [portable];
  });
}

function stripLocalTaskStateFromThreads(
  threads: PortableThread[],
): PortableThread[] {
  return threads.map((thread) => ({
    ...thread,
    messages: stripLocalTaskState(thread.messages),
  }));
}

function stripLocalTaskState(
  messages: PortableThread['messages'],
): PortableThread['messages'] {
  return messages.map((message) => {
    const { task: _task, ...portable } = message;
    return portable;
  });
}

function normalizePortableAnnotations(value: unknown): PortableAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const libraryType =
      entry.libraryType === 'user' || entry.libraryType === 'group'
        ? entry.libraryType
        : null;
    if (!libraryType) return [];
    const parentItemKey =
      typeof entry.parentItemKey === 'string' ? entry.parentItemKey : '';
    const key = typeof entry.key === 'string' ? entry.key : '';
    const dateModified =
      typeof entry.dateModified === 'string' ? entry.dateModified : '';
    const type = entry.type;
    const validType =
      type === 'highlight' ||
      type === 'underline' ||
      type === 'note' ||
      type === 'ink';
    if (!parentItemKey || !key || !dateModified || !validType) return [];
    if (!isRecord(entry.json)) return [];
    if (libraryType === 'group' && typeof entry.groupID !== 'number') return [];
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const portable: PortableAnnotation = {
      libraryType,
      parentItemKey,
      key,
      dateModified,
      type,
      json: entry.json,
      tags,
    };
    if (typeof entry.groupID === 'number') portable.groupID = entry.groupID;
    if (typeof entry.parentParentItemKey === 'string') {
      portable.parentParentItemKey = entry.parentParentItemKey;
    }
    return [portable];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTranslateCache(value: unknown): TranslateCacheState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return { entries: {} };
  const entries = (value as { entries?: Record<string, unknown> }).entries;
  if (!entries || typeof entries !== 'object') return { entries: {} };
  const out: TranslateCacheState['entries'] = {};
  for (const [k, v] of Object.entries(entries)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Partial<{ text: string; model: string; createdAt: number }>;
    if (typeof e.text === 'string' && typeof e.model === 'string' && typeof e.createdAt === 'number') {
      out[k] = { text: e.text, model: e.model, createdAt: e.createdAt };
    }
  }
  return { entries: out };
}
