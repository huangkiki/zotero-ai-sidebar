import type { PrefsStore } from './storage';

export interface LocalUiSettings {
  chatFontSizePx: number;
}

export const DEFAULT_LOCAL_UI_SETTINGS: LocalUiSettings = {
  chatFontSizePx: 13,
};

const KEY = 'extensions.zotero-ai-sidebar.localUiSettings';
const MIN_CHAT_FONT_SIZE = 11;
const MAX_CHAT_FONT_SIZE = 22;

export function loadLocalUiSettings(prefs: PrefsStore): LocalUiSettings {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_LOCAL_UI_SETTINGS;
  try {
    return normalizeLocalUiSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_LOCAL_UI_SETTINGS;
  }
}

export function saveLocalUiSettings(
  prefs: PrefsStore,
  settings: LocalUiSettings,
): void {
  prefs.set(KEY, JSON.stringify(normalizeLocalUiSettings(settings)));
}

export function normalizeLocalUiSettings(value: unknown): LocalUiSettings {
  const input = value && typeof value === 'object'
    ? (value as Partial<LocalUiSettings>)
    : {};
  return {
    chatFontSizePx: normalizeChatFontSize(input.chatFontSizePx),
  };
}

function normalizeChatFontSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LOCAL_UI_SETTINGS.chatFontSizePx;
  return Math.max(
    MIN_CHAT_FONT_SIZE,
    Math.min(MAX_CHAT_FONT_SIZE, Math.round(numeric)),
  );
}
