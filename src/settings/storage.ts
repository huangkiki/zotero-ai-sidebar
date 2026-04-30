import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  type AgentPermissionMode,
  type ModelPreset,
  type ProviderKind,
  type ReasoningEffort,
  type ReasoningSummary,
} from './types';

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
    return Array.isArray(parsed)
      ? parsed.map(normalizePreset).filter((p): p is ModelPreset => p != null)
      : [];
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

function normalizePreset(value: unknown): ModelPreset | null {
  if (!value || typeof value !== 'object') return null;
  const preset = value as Partial<ModelPreset>;
  if (preset.provider !== 'openai' && preset.provider !== 'anthropic') return null;
  const provider = preset.provider as ProviderKind;
  return {
    id: String(preset.id || `preset-${Date.now()}`),
    label: String(preset.label || (provider === 'anthropic' ? 'Claude' : 'GPT')),
    provider,
    apiKey: String(preset.apiKey || ''),
    baseUrl: String(preset.baseUrl || DEFAULT_BASE_URLS[provider]),
    model: String(preset.model || DEFAULT_MODELS[provider]),
    maxTokens: Number(preset.maxTokens || 8192),
    extras: normalizeExtras(provider, preset.extras),
  };
}

function normalizeExtras(
  provider: ProviderKind,
  extras: ModelPreset['extras'],
): ModelPreset['extras'] {
  if (provider !== 'openai') return extras;
  const rawEffort = extras?.reasoningEffort;
  return {
    ...extras,
    reasoningEffort: isReasoningEffort(rawEffort)
      ? rawEffort
      : DEFAULT_REASONING_EFFORT,
    reasoningSummary: isReasoningSummary(extras?.reasoningSummary)
      ? extras.reasoningSummary
      : DEFAULT_REASONING_SUMMARY,
    agentPermissionMode: isAgentPermissionMode(extras?.agentPermissionMode)
      ? extras.agentPermissionMode
      : 'default',
  };
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  );
}

function isReasoningSummary(value: unknown): value is ReasoningSummary {
  return (
    value === 'auto' ||
    value === 'concise' ||
    value === 'detailed' ||
    value === 'none'
  );
}

function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return value === 'default' || value === 'yolo';
}
