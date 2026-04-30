import type { Provider, Message, StreamChunk } from './types';
import type { ModelPreset } from '../settings/types';

export class OpenAIProvider implements Provider {
  async *stream(
    _messages: Message[],
    _systemPrompt: string,
    _preset: ModelPreset,
    _signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    throw new Error('not yet implemented');
  }
}
