import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../../src/providers/openai';
import type { ModelPreset } from '../../src/settings/types';
import type { StreamChunk } from '../../src/providers/types';

vi.mock('openai', () => {
  const fakeStream = async function* () {
    yield { choices: [{ delta: { content: 'Hi' } }] };
    yield { choices: [{ delta: { content: ' there' } }] };
    yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 2 } };
  };
  class FakeOpenAI {
    chat = { completions: { create: async () => fakeStream() } };
  }
  return { default: FakeOpenAI };
});

const preset: ModelPreset = {
  id: 'o',
  label: 'GPT',
  provider: 'openai',
  apiKey: 'sk',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.2',
  maxTokens: 1000,
};

describe('OpenAIProvider', () => {
  it('emits text deltas then usage', async () => {
    const p = new OpenAIProvider();
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
      { type: 'text_delta', text: 'Hi' },
      { type: 'text_delta', text: ' there' },
      { type: 'usage', input: 7, output: 2 },
    ]);
  });
});
