import type { PrefsStore } from '../settings/storage';
import {
  DEFAULT_TRANSLATE_SETTINGS,
  type TranslateSettings,
  type TranslateThinking,
  type TranslateContextLevel,
  type TranslateTriggerMode,
  type TranslateOverlaySize,
} from '../settings/types';

const KEY = 'extensions.zotero-ai-sidebar.translateSettings';

export function loadTranslateSettings(prefs: PrefsStore): TranslateSettings {
  const raw = prefs.get(KEY);
  if (!raw) return { ...DEFAULT_TRANSLATE_SETTINGS };
  try {
    return normalizeTranslateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRANSLATE_SETTINGS };
  }
}

export function saveTranslateSettings(prefs: PrefsStore, settings: TranslateSettings): void {
  prefs.set(KEY, JSON.stringify(normalizeTranslateSettings(settings)));
}

export function normalizeTranslateSettings(value: unknown): TranslateSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<TranslateSettings>;
  return {
    enabled: input.enabled === true,
    presetId: typeof input.presetId === 'string' ? input.presetId : '',
    model: typeof input.model === 'string' ? input.model : '',
    thinking: pickThinking(input.thinking),
    ctxLevel: pickCtxLevel(input.ctxLevel),
    overlayPosition: input.overlayPosition === 'below' ? 'below' : 'above',
    overlaySize: pickOverlaySize(input.overlaySize),
    triggerMode: pickTriggerMode(input.triggerMode),
    prevSentenceKey: typeof input.prevSentenceKey === 'string' && input.prevSentenceKey
      ? input.prevSentenceKey : DEFAULT_TRANSLATE_SETTINGS.prevSentenceKey,
    nextSentenceKey: typeof input.nextSentenceKey === 'string' && input.nextSentenceKey
      ? input.nextSentenceKey : DEFAULT_TRANSLATE_SETTINGS.nextSentenceKey,
  };
}

function pickThinking(v: unknown): TranslateThinking {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh'
    ? v
    : DEFAULT_TRANSLATE_SETTINGS.thinking;
}

function pickCtxLevel(v: unknown): TranslateContextLevel {
  return v === 'none' || v === 'paragraph' || v === 'page'
    ? v
    : DEFAULT_TRANSLATE_SETTINGS.ctxLevel;
}

function pickTriggerMode(v: unknown): TranslateTriggerMode {
  return v === 'double' ? 'double' : DEFAULT_TRANSLATE_SETTINGS.triggerMode;
}

function pickOverlaySize(v: unknown): TranslateOverlaySize {
  return v === 'adaptive' ? 'adaptive' : DEFAULT_TRANSLATE_SETTINGS.overlaySize;
}
