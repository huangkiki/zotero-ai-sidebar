import type { Provider } from './types';
import type { ModelPreset } from '../settings/types';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';

// Provider registry keyed by `preset.provider`. INVARIANT: exhaustive on
// `ProviderKind` — TypeScript will error here if a new provider is added
// to `settings/types.ts` without a case. WHY new instances per call (not
// cached): providers are stateless wrappers around an SDK client built
// per stream() with the preset's apiKey/baseUrl, so caching gains nothing.
export function getProvider(preset: ModelPreset): Provider {
  switch (preset.provider) {
    case 'anthropic':
      return new AnthropicProvider();
    case 'openai':
      return new OpenAIProvider();
  }
}
