import type { PrefsStore } from "./storage";

export type UiLanguage = "zh-CN" | "en-US";

export const DEFAULT_UI_LANGUAGE: UiLanguage = "zh-CN";
export const UI_LANGUAGE_PREF =
  "extensions.zotero-ai-sidebar.interfaceLanguage";

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === "en-US" ? "en-US" : DEFAULT_UI_LANGUAGE;
}

export function loadUiLanguage(prefs: PrefsStore): UiLanguage {
  return normalizeUiLanguage(prefs.get(UI_LANGUAGE_PREF));
}

export function saveUiLanguage(prefs: PrefsStore, language: UiLanguage): void {
  prefs.set(UI_LANGUAGE_PREF, normalizeUiLanguage(language));
}

/**
 * Read the live application preference without making pure storage modules
 * depend on Zotero during tests.
 */
export function currentUiLanguage(): UiLanguage {
  const runtime = globalThis as typeof globalThis & {
    Zotero?: {
      Prefs?: { get(key: string, global: boolean): unknown };
    };
  };
  return normalizeUiLanguage(
    runtime.Zotero?.Prefs?.get(UI_LANGUAGE_PREF, true),
  );
}
