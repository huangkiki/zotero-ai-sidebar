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

// Model-preset persistence backed by Zotero's preferences API.
//
// INVARIANT: all presets serialize to a SINGLE JSON string under one pref
// key. WHY one blob (instead of one pref per field): keeps `crud` atomic
// and lets us evolve the preset shape without registering new prefs each
// time. Cost: any read parses the whole list — fine, the list is small.
//
// `PrefsStore` is the seam used by tests so we don't need a Zotero global.
// `zoteroPrefs()` is the production binding — `Zotero.Prefs.get(k, true)`
// where the trailing `true` is the GLOBAL pref flag (per-profile, not
// per-zotero-instance). REF: Zotero source `chrome/content/zotero/xpcom/prefs.js`.

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

// Schema-rot resilience: treats every persisted preset as untrusted JSON.
// Provider is the only HARD constraint — without a valid provider we can't
// build a Provider object, so we drop the entry. Every other field gets a
// best-effort coercion + default. Mirrors chat-history.ts normalization.
// GOTCHA: `id` defaults to `preset-${Date.now()}` rather than a UUID; this
// fallback is only hit on legacy entries that pre-date `crypto.randomUUID()`.
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

// `extras` is provider-specific. Only OpenAI uses reasoning-* fields
// (Responses-API specific); Anthropic ignores them. WHY pass-through for
// non-OpenAI providers: future Anthropic extensions (e.g. extended-thinking
// settings) can be stored here without touching this normalizer.
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
