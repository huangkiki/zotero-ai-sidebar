import Anthropic from '@anthropic-ai/sdk';
import type { Provider, Message, ProviderStreamOptions, StreamChunk } from './types';
import type { ModelPreset } from '../settings/types';

export class AnthropicProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    _options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
    const client = new Anthropic({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
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
          messages: toAnthropicMessages(messages),
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

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };

export function toAnthropicMessages(
  messages: Message[],
): Array<{ role: Message['role']; content: string | AnthropicContentBlock[] }> {
  return messages.map((message) => {
    if (!message.images?.length) {
      return { role: message.role, content: message.content };
    }

    const content: AnthropicContentBlock[] = [];
    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }
    message.images.forEach((image, index) => {
      const label = image.marker ?? `[Image #${index + 1}]`;
      content.push({ type: 'text', text: `<image name=${label}>` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: anthropicImageMediaType(image.mediaType),
          data: dataUrlPayload(image.dataUrl),
        },
      });
      content.push({ type: 'text', text: '</image>' });
    });
    return { role: message.role, content };
  });
}

function anthropicImageMediaType(
  mediaType: string,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch (mediaType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mediaType;
    default:
      return 'image/png';
  }
}

function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
