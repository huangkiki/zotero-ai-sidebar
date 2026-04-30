import OpenAI from 'openai';
import type { Provider, Message, StreamChunk } from './types';
import type { ModelPreset } from '../settings/types';

export class OpenAIProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: preset.apiKey,
      baseURL: preset.baseUrl,
      dangerouslyAllowBrowser: true,
    });

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.chat.completions.create(
        {
          model: preset.model,
          max_tokens: preset.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal },
      )) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const e = event as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = e.choices?.[0]?.delta?.content;
        if (text) yield { type: 'text_delta', text };
        if (e.usage) {
          yield {
            type: 'usage',
            input: e.usage.prompt_tokens ?? 0,
            output: e.usage.completion_tokens ?? 0,
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
