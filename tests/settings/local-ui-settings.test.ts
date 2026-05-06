import { describe, expect, it } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import {
  DEFAULT_LOCAL_UI_SETTINGS,
  loadLocalUiSettings,
  saveLocalUiSettings,
} from '../../src/settings/local-ui-settings';

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe('local UI settings storage', () => {
  it('returns defaults for missing or invalid settings', () => {
    expect(loadLocalUiSettings(memPrefs())).toEqual(DEFAULT_LOCAL_UI_SETTINGS);
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.localUiSettings', '{bad');
    expect(loadLocalUiSettings(prefs)).toEqual(DEFAULT_LOCAL_UI_SETTINGS);
  });

  it('round trips and clamps chat font size', () => {
    const prefs = memPrefs();
    saveLocalUiSettings(prefs, { chatFontSizePx: 16 });
    expect(loadLocalUiSettings(prefs).chatFontSizePx).toBe(16);

    saveLocalUiSettings(prefs, { chatFontSizePx: 99 });
    expect(loadLocalUiSettings(prefs).chatFontSizePx).toBe(22);

    saveLocalUiSettings(prefs, { chatFontSizePx: 1 });
    expect(loadLocalUiSettings(prefs).chatFontSizePx).toBe(11);
  });
});
