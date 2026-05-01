export type ProviderKind = 'anthropic' | 'openai';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type AgentPermissionMode = 'default' | 'yolo';

export interface ModelPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  // Currently-active model — what providers actually send to the API. Stays
  // a single string so provider adapters don't need to change.
  model: string;
  // Available models for this preset. The composer-footer switcher lets the
  // user pick one and writes the choice back to `model`. Persisted in prefs
  // so the selection is sticky across sessions.
  // GOTCHA: optional for back-compat with legacy presets that only had
  // `model`. `normalizePreset` in storage.ts back-fills this on load.
  models?: string[];
  maxTokens: number;
  extras?: {
    reasoningEffort?: ReasoningEffort;
    reasoningSummary?: ReasoningSummary;
    agentPermissionMode?: AgentPermissionMode;
    omitMaxOutputTokens?: boolean;
    [key: string]: unknown;
  };
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: '',
  openai: '',
};

export const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: '',
  openai: '',
};

export const MODEL_SUGGESTIONS: Record<ProviderKind, string[]> = {
  anthropic: [],
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
};

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'xhigh';
export const DEFAULT_REASONING_SUMMARY: ReasoningSummary = 'concise';

export const REASONING_EFFORT_OPTIONS: Array<[ReasoningEffort, string]> = [
  ['low', 'Low - 快速，较少推理'],
  ['medium', 'Medium - 默认平衡'],
  ['high', 'High - 更强推理'],
  ['xhigh', 'Extra high - 最强推理'],
];

export const REASONING_SUMMARY_OPTIONS: Array<[ReasoningSummary, string]> = [
  ['concise', 'Concise - 简短显示思考摘要'],
  ['detailed', 'Detailed - 更详细的思考摘要'],
  ['auto', 'Auto - 由模型决定'],
  ['none', 'None - 不显示思考'],
];

export function newPreset(provider: ProviderKind): ModelPreset {
  const defaultModel = DEFAULT_MODELS[provider];
  return {
    id: crypto.randomUUID(),
    label: provider === 'anthropic' ? 'Claude' : 'GPT',
    provider,
    apiKey: '',
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: defaultModel,
    models: defaultModel ? [defaultModel] : [],
    maxTokens: 8192,
    extras: provider === 'openai'
      ? {
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          reasoningSummary: DEFAULT_REASONING_SUMMARY,
        }
      : undefined,
  };
}
