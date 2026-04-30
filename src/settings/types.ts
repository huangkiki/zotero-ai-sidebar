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
  model: string;
  maxTokens: number;
  extras?: {
    reasoningEffort?: ReasoningEffort;
    reasoningSummary?: ReasoningSummary;
    agentPermissionMode?: AgentPermissionMode;
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
  openai: [],
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
  return {
    id: crypto.randomUUID(),
    label: provider === 'anthropic' ? 'Claude' : 'GPT',
    provider,
    apiKey: '',
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: DEFAULT_MODELS[provider],
    maxTokens: 8192,
    extras: provider === 'openai'
      ? {
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          reasoningSummary: DEFAULT_REASONING_SUMMARY,
        }
      : undefined,
  };
}
