import { describe, it, expect } from 'vitest';
import { getProvider } from '../../src/providers/factory';
import { AnthropicProvider } from '../../src/providers/anthropic';
import { OpenAIProvider } from '../../src/providers/openai';
import type { ModelPreset } from '../../src/settings/types';

const base: Omit<ModelPreset, 'provider'> = {
  id: 'x',
  label: 'x',
  apiKey: 'k',
  baseUrl: 'https://x',
  model: 'm',
  maxTokens: 1,
};

describe('getProvider', () => {
  it('returns AnthropicProvider for anthropic preset', () => {
    expect(getProvider({ ...base, provider: 'anthropic' })).toBeInstanceOf(AnthropicProvider);
  });

  it('returns OpenAIProvider for openai preset', () => {
    expect(getProvider({ ...base, provider: 'openai' })).toBeInstanceOf(OpenAIProvider);
  });
});
