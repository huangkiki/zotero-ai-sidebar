import type { Provider } from './types';
import type { ModelPreset } from '../settings/types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

export function getProvider(preset: ModelPreset): Provider {
  switch (preset.provider) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider();
  }
}
