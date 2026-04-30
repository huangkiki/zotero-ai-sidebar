import type { ModelPreset } from '../settings/types';

export type MessageRole = 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage'; input: number; output: number; cacheRead?: number }
  | { type: 'error'; message: string };

export interface Provider {
  stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>;
}

export type ProviderFactory = (preset: ModelPreset) => Provider;
