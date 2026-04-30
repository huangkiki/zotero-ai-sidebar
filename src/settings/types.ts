export type ProviderKind = 'anthropic' | 'openai';

export interface ModelPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  extras?: Record<string, unknown>;
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

export function newPreset(provider: ProviderKind): ModelPreset {
  return {
    id: crypto.randomUUID(),
    label: provider === 'anthropic' ? 'Claude' : 'GPT',
    provider,
    apiKey: '',
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: '',
    maxTokens: 8192,
  };
}
