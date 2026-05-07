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
      selectionQuestionAnnotationEnabled: true,
      customButtons: [
        { id: 'method', label: '方法', prompt: '总结方法', shortcut: 't' },
      ],
    });

    expect(loadQuickPromptSettings(prefs)).toEqual({
      builtIns: {
        summary: 'summary prompt',
        fullTextHighlight: 'highlight prompt',
        explainSelection: 'explain prompt',
      },
      selectionQuestionAnnotationEnabled: true,
      customButtons: [
        { id: 'method', label: '方法', prompt: '总结方法', shortcut: 't' },
      ],
    });
  });

  it('drops custom buttons without prompt and falls back for empty built-ins', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.quickPrompts',
      JSON.stringify({
        builtIns: {
          summary: '',
          fullTextHighlight: 'x',
          explainSelection: 'y',
        },
        // Non-boolean garbage: with the new "default on unless explicit
        // false" rule, anything that isn't === false is treated as on.
        selectionQuestionAnnotationEnabled: 'yes',
        customButtons: [
          { id: 'bad', label: '空提示词', prompt: '' },
          { id: 'nameless-bad', label: '', prompt: 'No trigger' },
          { id: 'ok', label: 'OK', prompt: 'Do it', shortcut: 'Enter' },
        ],
      }),
    );

    const settings = loadQuickPromptSettings(prefs);
    expect(settings.builtIns.summary).toBe(
      DEFAULT_QUICK_PROMPT_SETTINGS.builtIns.summary,
    );
    expect(settings.selectionQuestionAnnotationEnabled).toBe(true);
    expect(settings.customButtons).toEqual([
      { id: 'ok', label: 'OK', prompt: 'Do it' },
    ]);
  });

  it('keeps an explicit `false` for selectionQuestionAnnotationEnabled', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.quickPrompts',
      JSON.stringify({ selectionQuestionAnnotationEnabled: false }),
    );
    expect(loadQuickPromptSettings(prefs).selectionQuestionAnnotationEnabled).toBe(
      false,
    );
  });

  it('defaults selectionQuestionAnnotationEnabled to true on a fresh profile', () => {
    expect(
      loadQuickPromptSettings(memPrefs()).selectionQuestionAnnotationEnabled,
    ).toBe(true);
  });

  it('keeps only unique single-key custom shortcuts', () => {
    const prefs = memPrefs();
    saveQuickPromptSettings(prefs, {
      ...DEFAULT_QUICK_PROMPT_SETTINGS,
      customButtons: [
        { id: 'translate', label: '翻译', prompt: '翻译选区', shortcut: 'T' },
        { id: 'dup', label: '重复', prompt: '重复', shortcut: 't' },
        { id: 'num', label: '数字', prompt: '数字', shortcut: '1' },
      ],
    });

    expect(loadQuickPromptSettings(prefs).customButtons).toEqual([
      { id: 'translate', label: '翻译', prompt: '翻译选区', shortcut: 't' },
      { id: 'dup', label: '重复', prompt: '重复' },
      { id: 'num', label: '数字', prompt: '数字', shortcut: '1' },
    ]);
  });

  it('allows shortcut-only prompts without rendering a button label', () => {
    const prefs = memPrefs();
    saveQuickPromptSettings(prefs, {
      ...DEFAULT_QUICK_PROMPT_SETTINGS,
      customButtons: [
        { id: 'translate-key', label: '', prompt: '翻译选区', shortcut: 't' },
      ],
    });

    expect(loadQuickPromptSettings(prefs).customButtons).toEqual([
      { id: 'translate-key', label: '', prompt: '翻译选区', shortcut: 't' },
    ]);
  });

  it('migrates the old annotation suggestion switch name', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.quickPrompts',
      JSON.stringify({ annotationSuggestionColorEnabled: true }),
    );

    expect(loadQuickPromptSettings(prefs).selectionQuestionAnnotationEnabled).toBe(
      true,
    );
  });
});
