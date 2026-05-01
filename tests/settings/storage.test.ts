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
  models: ['claude-opus-4-7-20251101'],
  maxTokens: 8192,
};

function writePresetsRaw(prefs: PrefsStore, presets: unknown[]): void {
  prefs.set('extensions.zotero-ai-sidebar.presets', JSON.stringify(presets));
}

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

  it('back-fills models[] from a legacy preset with only `model`', () => {
    const prefs = memPrefs();
    writePresetsRaw(prefs, [
      {
        id: 'legacy',
        label: 'GPT',
        provider: 'openai',
        apiKey: 'sk',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.2',
        maxTokens: 4000,
      },
    ]);
    const [preset] = loadPresets(prefs);
    expect(preset.model).toBe('gpt-5.2');
    expect(preset.models).toEqual(['gpt-5.2']);
  });

  it('repairs a preset where active model is not in models[]', () => {
    const prefs = memPrefs();
    writePresetsRaw(prefs, [
      {
        id: 'mismatch',
        label: 'GPT',
        provider: 'openai',
        apiKey: 'sk',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.2-mini',
        models: ['gpt-5.2', 'gpt-4o'],
        maxTokens: 4000,
      },
    ]);
    const [preset] = loadPresets(prefs);
    // Active model preserved AND prepended to the list so it is selectable.
    expect(preset.model).toBe('gpt-5.2-mini');
    expect(preset.models).toEqual(['gpt-5.2-mini', 'gpt-5.2', 'gpt-4o']);
  });

  it('falls back to models[0] when `model` is empty', () => {
    const prefs = memPrefs();
    writePresetsRaw(prefs, [
      {
        id: 'no-active',
        label: 'GPT',
        provider: 'openai',
        apiKey: 'sk',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        models: ['gpt-5.2', 'gpt-4o'],
        maxTokens: 4000,
      },
    ]);
    const [preset] = loadPresets(prefs);
    expect(preset.model).toBe('gpt-5.2');
    expect(preset.models).toEqual(['gpt-5.2', 'gpt-4o']);
  });

  it('round-trips a multi-model preset', () => {
    const prefs = memPrefs();
    const multi: ModelPreset = {
      ...p1,
      model: 'claude-sonnet-4-6',
      models: ['claude-opus-4-7-20251101', 'claude-sonnet-4-6'],
    };
    savePresets(prefs, [multi]);
    expect(loadPresets(prefs)[0]).toEqual(multi);
  });
});
