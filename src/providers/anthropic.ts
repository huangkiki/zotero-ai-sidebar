import Anthropic from '@anthropic-ai/sdk';
import type { Provider, Message, StreamChunk } from './types';
import type { ModelPreset } from '../settings/types';

export class AnthropicProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new Anthropic({
      apiKey: preset.apiKey,
      baseURL: preset.baseUrl,
      dangerouslyAllowBrowser: true,
    });

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.messages.stream(
        {
          model: preset.model,
          max_tokens: preset.maxTokens,
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal },
      )) as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const e = event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string };
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
        };
        if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta' && e.delta.text != null) {
            yield { type: 'text_delta', text: e.delta.text };
          } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking != null) {
            yield { type: 'thinking_delta', text: e.delta.thinking };
          }
        } else if (e.type === 'message_delta' && e.usage) {
          yield {
            type: 'usage',
            input: e.usage.input_tokens ?? 0,
            output: e.usage.output_tokens ?? 0,
            cacheRead: e.usage.cache_read_input_tokens,
          };
        }
      }
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
