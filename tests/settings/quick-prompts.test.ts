import { describe, expect, it } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import {
  DEFAULT_QUICK_PROMPT_SETTINGS,
  loadQuickPromptSettings,
  saveQuickPromptSettings,
} from '../../src/settings/quick-prompts';

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe('quick prompt settings storage', () => {
  it('returns defaults for missing or invalid settings', () => {
    expect(loadQuickPromptSettings(memPrefs())).toEqual(
      DEFAULT_QUICK_PROMPT_SETTINGS,
    );
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.quickPrompts', '{bad');
    expect(loadQuickPromptSettings(prefs)).toEqual(
      DEFAULT_QUICK_PROMPT_SETTINGS,
    );
  });

  it('round trips edited built-ins and custom buttons', () => {
    const prefs = memPrefs();
    saveQuickPromptSettings(prefs, {
      builtIns: {
        summary: 'summary prompt',
        fullTextHighlight: 'highlight prompt',
        explainSelection: 'explain prompt',
      },
      customButtons: [
        { id: 'method', label: '方法', prompt: '总结方法' },
      ],
    });

    expect(loadQuickPromptSettings(prefs)).toEqual({
      builtIns: {
        summary: 'summary prompt',
        fullTextHighlight: 'highlight prompt',
        explainSelection: 'explain prompt',
      },
      customButtons: [
        { id: 'method', label: '方法', prompt: '总结方法' },
      ],
    });
  });

  it('drops custom buttons without prompt and falls back for empty built-ins', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.quickPrompts',
      JSON.stringify({
        builtIns: { summary: '', fullTextHighlight: 'x', explainSelection: 'y' },
        customButtons: [
          { id: 'bad', label: '空提示词', prompt: '' },
          { id: 'ok', label: 'OK', prompt: 'Do it' },
        ],
      }),
    );

    const settings = loadQuickPromptSettings(prefs);
    expect(settings.builtIns.summary).toBe(
      DEFAULT_QUICK_PROMPT_SETTINGS.builtIns.summary,
    );
    expect(settings.customButtons).toEqual([
      { id: 'ok', label: 'OK', prompt: 'Do it' },
    ]);
  });
});
