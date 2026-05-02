import { describe, expect, it } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import {
  DEFAULT_UI_SETTINGS,
  loadUiSettings,
  saveUiSettings,
} from '../../src/settings/ui-settings';

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe('ui settings storage', () => {
  it('returns defaults for missing or invalid settings', () => {
    expect(loadUiSettings(memPrefs())).toEqual(DEFAULT_UI_SETTINGS);
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.uiSettings', '{bad');
    expect(loadUiSettings(prefs)).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('round trips profiles and action position', () => {
    const prefs = memPrefs();
    saveUiSettings(prefs, {
      messageActionsPosition: 'top-right',
      messageActionsLayout: 'inside',
      userProfile: { label: '我', avatar: '🙂' },
      assistantProfile: { label: '助手', avatar: 'https://example.test/ai.png' },
    });

    expect(loadUiSettings(prefs)).toEqual({
      messageActionsPosition: 'top-right',
      messageActionsLayout: 'inside',
      userProfile: { label: '我', avatar: '🙂' },
      assistantProfile: { label: '助手', avatar: 'https://example.test/ai.png' },
    });
  });
});
