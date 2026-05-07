import type { PrefsStore } from './storage';

export type MessageActionsPosition = 'top-right' | 'bottom-right';
export type MessageActionsLayout = 'edge' | 'inside';

export interface ChatProfileSettings {
  label: string;
  avatar: string;
}

export interface UiSettings {
  messageActionsPosition: MessageActionsPosition;
  messageActionsLayout: MessageActionsLayout;
  chatFontFamily: string;
  userProfile: ChatProfileSettings;
  assistantProfile: ChatProfileSettings;
  // When ON, the composer can submit a new message while a previous task is
  // still streaming — the new one is registered into the queue and runs
  // after the current task finishes (the original PDF selection at queue
  // time is captured with the message). When OFF (default) Enter and the
  // send button are blocked while sending, matching the historical
  // single-task-at-a-time behavior.
  composerQueueWhileSending: boolean;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  messageActionsPosition: 'top-right',
  messageActionsLayout: 'inside',
  chatFontFamily: '',
  userProfile: { label: 'YOU', avatar: '' },
  assistantProfile: { label: 'AI', avatar: '' },
  composerQueueWhileSending: false,
};

const KEY = 'extensions.zotero-ai-sidebar.uiSettings';
const LABEL_MAX = 24;
const AVATAR_MAX = 2048;
const CHAT_FONT_MAX = 240;

export function loadUiSettings(prefs: PrefsStore): UiSettings {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_UI_SETTINGS;
  try {
    return normalizeUiSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_UI_SETTINGS;
  }
}

export function saveUiSettings(prefs: PrefsStore, settings: UiSettings): void {
  prefs.set(KEY, JSON.stringify(normalizeUiSettings(settings)));
}

export function normalizeUiSettings(value: unknown): UiSettings {
  const input = value && typeof value === 'object'
    ? (value as Partial<UiSettings>)
    : {};
  return {
    messageActionsPosition: isMessageActionsPosition(input.messageActionsPosition)
      ? input.messageActionsPosition
      : DEFAULT_UI_SETTINGS.messageActionsPosition,
    messageActionsLayout: isMessageActionsLayout(input.messageActionsLayout)
      ? input.messageActionsLayout
      : DEFAULT_UI_SETTINGS.messageActionsLayout,
    chatFontFamily: normalizeChatFontFamily(input.chatFontFamily),
    userProfile: normalizeProfile(input.userProfile, DEFAULT_UI_SETTINGS.userProfile),
    assistantProfile: normalizeProfile(
      input.assistantProfile,
      DEFAULT_UI_SETTINGS.assistantProfile,
    ),
    // Strict boolean — only `true` enables; anything else (undefined, legacy
    // shapes, garbage) keeps the conservative default-off behavior.
    composerQueueWhileSending: input.composerQueueWhileSending === true,
  };
}

function isMessageActionsPosition(value: unknown): value is MessageActionsPosition {
  return value === 'top-right' || value === 'bottom-right';
}

function isMessageActionsLayout(value: unknown): value is MessageActionsLayout {
  return value === 'edge' || value === 'inside';
}

function normalizeProfile(
  value: unknown,
  fallback: ChatProfileSettings,
): ChatProfileSettings {
  const input = value && typeof value === 'object'
    ? (value as Partial<ChatProfileSettings>)
    : {};
  const label = stringValue(input.label).slice(0, LABEL_MAX) || fallback.label;
  const avatar = stringValue(input.avatar).slice(0, AVATAR_MAX);
  return { label, avatar };
}

function normalizeChatFontFamily(value: unknown): string {
  const font = stringValue(value).slice(0, CHAT_FONT_MAX);
  // Keep normal font-family syntax (quotes, commas, CJK names) but reject
  // characters that only make sense for CSS injection or HTML markup.
  return /[;{}<>]/.test(font) ? '' : font;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
