import { beforeEach, describe, expect, it } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import { saveTranslateSettings } from '../../src/translate/settings';
import { saveCache as saveTranslateCacheState } from '../../src/translate/cache';
import { DEFAULT_TRANSLATE_SETTINGS } from '../../src/settings/types';
import { savePresets } from '../../src/settings/storage';
import { saveQuickPromptSettings } from '../../src/settings/quick-prompts';
import { saveToolSettings } from '../../src/settings/tool-settings';
import { saveUiSettings } from '../../src/settings/ui-settings';
import { saveLocalUiSettings } from '../../src/settings/local-ui-settings';
import {
  applySyncSnapshot,
  buildSyncSnapshot,
  parseSyncSnapshot,
  SYNC_SCHEMA,
} from '../../src/sync/state';
import { loadPresets } from '../../src/settings/storage';
import { loadQuickPromptSettings } from '../../src/settings/quick-prompts';
import { loadToolSettings } from '../../src/settings/tool-settings';
import { loadUiSettings } from '../../src/settings/ui-settings';
import { loadChatMessages, saveChatMessages } from '../../src/settings/chat-history';

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

let storedThreads = '{}';

beforeEach(() => {
  storedThreads = '{}';
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Profile: { dir: '/tmp/zotero-profile' },
      File: {
        getContentsAsync: async () => storedThreads,
        putContentsAsync: async (_path: string, contents: string) => {
          storedThreads = contents;
        },
      },
      Items: {
        get: (id: number) =>
          id === 42
            ? { key: 'AAAA1111', libraryID: 1, id: 42 }
            : id === 99
              ? { key: 'BBBB2222', libraryID: 1, id: 99 }
              : false,
        getByLibraryAndKey: (libraryID: number, key: string) => {
          if (libraryID !== 1) return false;
          if (key === 'AAAA1111') return { key, libraryID, id: 42 };
          if (key === 'BBBB2222') return { key, libraryID, id: 99 };
          return false;
        },
        // Empty library by default — annotation tests live in their own
        // file with their own Zotero stub.
        getAll: () => [],
        getAsync: async () => null,
      },
      Libraries: {
        get: (libraryID: number) =>
          libraryID === 1 ? { libraryType: 'user', id: 1 } : undefined,
        userLibraryID: 1,
      },
      Groups: {
        get: () => false,
        getAll: () => [],
      },
      Annotations: {
        saveFromJSON: async () => ({ id: 0, key: '' }),
      },
    },
  });
});

describe('sync snapshot round trip', () => {
  it('builds a snapshot with all settings sections and chat threads', async () => {
    const prefs = memPrefs();
    savePresets(prefs, [
      {
        id: 'preset-1',
        label: 'GPT',
        provider: 'openai',
        apiKey: 'sk-xxx',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.1',
        models: ['gpt-5.1'],
        maxTokens: 8192,
        extras: {
          reasoningEffort: 'medium',
          reasoningSummary: 'auto',
          agentPermissionMode: 'default',
        },
      },
    ]);
    saveUiSettings(prefs, {
      messageActionsPosition: 'bottom-right',
      messageActionsLayout: 'edge',
      chatFontFamily: 'Noto Serif CJK SC, serif',
      userProfile: { label: 'me', avatar: '🙂' },
      assistantProfile: { label: 'ai', avatar: '🤖' },
      composerQueueWhileSending: true,
    });
    saveQuickPromptSettings(prefs, {
      builtIns: {
        summary: 'sum',
        fullTextHighlight: 'highlight',
        explainSelection: 'explain',
      },
      selectionQuestionAnnotationEnabled: true,
      customButtons: [{ id: 'a', label: 'A', prompt: 'do A', shortcut: 't' }],
    });
    saveToolSettings(prefs, {
      webSearchMode: 'live',
      mcpServers: [],
      textAnnotationFontSize: 22,
      arxivMcp: {
        enabled: false,
        serverLabel: 'arxiv',
        serverUrl: '',
        allowedTools: ['search'],
        requireApproval: 'never',
      },
    });
    saveLocalUiSettings(prefs, { chatFontSizePx: 18 });
    await saveChatMessages(42, [
      {
        role: 'user',
        content: 'hello',
        task: {
          id: 'task-local',
          kind: 'selection',
          title: '选中文字提问',
          promptPreview: 'hello',
          createdAt: 1,
          completedAt: 2,
        },
      },
      { role: 'assistant', content: 'hi there' },
    ]);

    const snapshot = await buildSyncSnapshot(prefs);
    expect(snapshot.schema).toBe(SYNC_SCHEMA);
    expect(snapshot.presets).toHaveLength(1);
    expect(snapshot.uiSettings.messageActionsPosition).toBe('bottom-right');
    expect(snapshot.uiSettings.chatFontFamily).toBe('Noto Serif CJK SC, serif');
    expect(snapshot).not.toHaveProperty('localUiSettings');
    expect(JSON.stringify(snapshot)).not.toContain('chatFontSizePx');
    expect(snapshot.quickPrompts.customButtons).toHaveLength(1);
    expect(snapshot.quickPrompts.customButtons[0].shortcut).toBe('t');
    expect(snapshot.quickPrompts.selectionQuestionAnnotationEnabled).toBe(true);
    expect(snapshot.toolSettings.webSearchMode).toBe('live');
    expect(snapshot.toolSettings.textAnnotationFontSize).toBe(22);
    expect(snapshot.uiSettings.composerQueueWhileSending).toBe(true);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]).toMatchObject({
      libraryType: 'user',
      itemKey: 'AAAA1111',
    });
    expect(snapshot.threads[0].messages).toHaveLength(2);
    expect(snapshot.threads[0].messages[0]).not.toHaveProperty('task');
    expect(snapshot.annotations).toEqual([]);
  });

  it('parses, applies, and re-loads the same state on a fresh prefs store', async () => {
    const sourcePrefs = memPrefs();
    saveUiSettings(sourcePrefs, {
      messageActionsPosition: 'top-right',
      messageActionsLayout: 'inside',
      chatFontFamily: 'LXGW WenKai, serif',
      userProfile: { label: 'YOU', avatar: '' },
      assistantProfile: { label: 'AI', avatar: '' },
      composerQueueWhileSending: true,
    });
    saveToolSettings(sourcePrefs, {
      ...loadToolSettings(sourcePrefs),
      textAnnotationFontSize: 24,
    });
    await saveChatMessages(42, [{ role: 'user', content: 'first device' }]);
    const snapshot = await buildSyncSnapshot(sourcePrefs);
    const json = JSON.stringify(snapshot);

    storedThreads = '{}';
    const targetPrefs = memPrefs();
    const parsed = parseSyncSnapshot(json);
    const result = await applySyncSnapshot(targetPrefs, parsed);

    expect(result.threads.imported).toBe(1);
    expect(loadUiSettings(targetPrefs).messageActionsPosition).toBe('top-right');
    expect(loadUiSettings(targetPrefs).chatFontFamily).toBe('LXGW WenKai, serif');
    expect(loadPresets(targetPrefs)).toEqual([]);
    expect(loadQuickPromptSettings(targetPrefs).builtIns.summary).toBeTruthy();
    expect(loadToolSettings(targetPrefs).webSearchMode).toBe('disabled');
    expect(loadToolSettings(targetPrefs).textAnnotationFontSize).toBe(24);
    expect(loadUiSettings(targetPrefs).composerQueueWhileSending).toBe(true);
    expect(await loadChatMessages(42)).toHaveLength(1);
  });

  it('rejects a snapshot with the wrong schema', () => {
    expect(() => parseSyncSnapshot('{"schema":"other"}')).toThrow(/schema/);
  });

  it('rejects unparseable JSON', () => {
    expect(() => parseSyncSnapshot('not json')).toThrow(/解析/);
  });

  it('counts unresolved threads when the local item key is missing', async () => {
    const json = JSON.stringify({
      schema: SYNC_SCHEMA,
      exportedAt: '2026-05-02T00:00:00Z',
      presets: [],
      uiSettings: {},
      quickPrompts: {},
      toolSettings: {},
      threads: [
        {
          libraryType: 'user',
          itemKey: 'ZZZZ9999',
          updatedAt: '2026-05-02T00:00:00Z',
          messages: [{ role: 'user', content: 'orphan' }],
        },
      ],
    });
    const prefs = memPrefs();
    const result = await applySyncSnapshot(prefs, parseSyncSnapshot(json));
    expect(result.threads.unresolved).toBe(1);
    expect(result.threads.imported).toBe(0);
  });

  it('round-trips translateSettings and translateCache', async () => {
    const prefs = memPrefs();
    saveTranslateSettings(prefs, { ...DEFAULT_TRANSLATE_SETTINGS, enabled: true, model: 'gpt-5.4' });
    saveTranslateCacheState(prefs, {
      entries: { k1: { text: '你好', model: 'gpt-5.4', createdAt: 1 } },
    });
    const snap = await buildSyncSnapshot(prefs);
    const json = JSON.stringify(snap);
    const reparsed = parseSyncSnapshot(json);
    expect(reparsed.translateSettings?.enabled).toBe(true);
    expect(reparsed.translateSettings?.model).toBe('gpt-5.4');
    expect(reparsed.translateCache?.entries.k1?.text).toBe('你好');
  });

  it('accepts snapshots missing translate fields (back-compat)', () => {
    const json = JSON.stringify({
      schema: SYNC_SCHEMA,
      exportedAt: '',
      presets: [],
      uiSettings: {},
      quickPrompts: {},
      toolSettings: {},
      threads: [],
      annotations: [],
    });
    const snap = parseSyncSnapshot(json);
    expect(snap.translateSettings).toBeUndefined();
    expect(snap.translateCache).toBeUndefined();
  });
});
