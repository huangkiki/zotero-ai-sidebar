import type { ModelPreset } from './types';

export interface PrefsStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const KEY = 'extensions.zotero-ai-sidebar.presets';

export function loadPresets(prefs: PrefsStore): ModelPreset[] {
  const raw = prefs.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePresets(prefs: PrefsStore, presets: ModelPreset[]): void {
  prefs.set(KEY, JSON.stringify(presets));
}

export function zoteroPrefs(): PrefsStore {
  return {
    get: (k) => {
      const v = (Zotero as unknown as { Prefs: { get: (k: string, global: boolean) => unknown } }).Prefs.get(k, true);
      return typeof v === 'string' ? v : undefined;
    },
    set: (k, v) => {
      (Zotero as unknown as { Prefs: { set: (k: string, v: string, global: boolean) => void } }).Prefs.set(k, v, true);
    },
  };
}
