import { describe, it, expect } from 'vitest';
import { loadPresets, savePresets, type PrefsStore } from '../../src/settings/storage';
import type { ModelPreset } from '../../src/settings/types';

function memPrefs(): PrefsStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
  };
}

const p1: ModelPreset = {
  id: 'a',
  label: 'Opus',
  provider: 'anthropic',
  apiKey: 'sk-x',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-7-20251101',
  maxTokens: 8192,
};

describe('preset storage', () => {
  it('returns empty list when nothing saved', () => {
    expect(loadPresets(memPrefs())).toEqual([]);
  });

  it('round-trips presets through JSON', () => {
    const prefs = memPrefs();
    savePresets(prefs, [p1]);
    expect(loadPresets(prefs)).toEqual([p1]);
  });

  it('returns empty list when stored value is corrupt JSON', () => {
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.presets', '{not json');
    expect(loadPresets(prefs)).toEqual([]);
  });

  it('normalizes the agent permission mode', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.presets',
      JSON.stringify([
        {
          id: 'o',
          label: 'GPT',
          provider: 'openai',
          apiKey: 'sk',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.2',
          maxTokens: 1000,
          extras: { agentPermissionMode: 'yolo' },
        },
      ]),
    );

    expect(loadPresets(prefs)[0].extras?.agentPermissionMode).toBe('yolo');
  });
});
