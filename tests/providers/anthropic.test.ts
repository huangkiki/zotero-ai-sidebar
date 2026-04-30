import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/providers/anthropic';
import type { ModelPreset } from '../../src/settings/types';
import type { StreamChunk } from '../../src/providers/types';

vi.mock('@anthropic-ai/sdk', () => {
  const fakeStream = async function* () {
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } };
    yield {
      type: 'message_delta',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
    };
  };
  class FakeAnthropic {
    messages = { stream: async () => fakeStream() };
  }
  return { default: FakeAnthropic };
});

const preset: ModelPreset = {
  id: 'a',
  label: 'Opus',
  provider: 'anthropic',
  apiKey: 'sk',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-7-20251101',
  maxTokens: 1000,
};

describe('AnthropicProvider', () => {
  it('emits text_delta then usage from a streamed response', async () => {
    const p = new AnthropicProvider();
    const got: StreamChunk[] = [];
    for await (const c of p.stream(
      [{ role: 'user', content: 'hi' }],
      'be helpful',
      preset,
      new AbortController().signal,
    )) {
      got.push(c);
    }
    expect(got).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'usage', input: 10, output: 2, cacheRead: 5 },
    ]);
  });
});
