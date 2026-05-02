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
  userProfile: ChatProfileSettings;
  assistantProfile: ChatProfileSettings;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  messageActionsPosition: 'top-right',
  messageActionsLayout: 'inside',
  userProfile: { label: 'YOU', avatar: '' },
  assistantProfile: { label: 'AI', avatar: '' },
};

const KEY = 'extensions.zotero-ai-sidebar.uiSettings';
const LABEL_MAX = 24;
const AVATAR_MAX = 2048;

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
    userProfile: normalizeProfile(input.userProfile, DEFAULT_UI_SETTINGS.userProfile),
    assistantProfile: normalizeProfile(
      input.assistantProfile,
      DEFAULT_UI_SETTINGS.assistantProfile,
    ),
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
