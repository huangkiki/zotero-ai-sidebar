import { beforeEach, describe, it, expect, vi } from 'vitest';
import { OpenAIProvider, toOpenAIInput } from '../../src/providers/openai';
import type { ModelPreset } from '../../src/settings/types';
import type { StreamChunk } from '../../src/providers/types';

const requestLog = vi.hoisted(() => ({ requests: [] as Array<{ input?: unknown; tools?: unknown[] }> }));

vi.mock('openai', () => {
  const fakeStream = async function* () {
    yield { type: 'response.output_text.delta', delta: 'Hi' };
    yield { type: 'response.output_text.delta', delta: ' there' };
    yield {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 7,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    };
  };
  class FakeOpenAI {
    toolCallCount = 0;
    responses = {
      create: async (params: { stream?: boolean; tools?: unknown[]; input?: unknown }) => {
        requestLog.requests.push(params);
        if (params.tools?.length) {
          this.toolCallCount++;
          return this.toolCallCount === 1
            ? (async function* () {
                yield {
                  type: 'response.output_item.done',
                  item: {
                    type: 'reasoning',
                    id: 'rs_test_reasoning_item',
                    summary: [{ type: 'summary_text', text: 'need a tool' }],
                  },
                };
                yield {
                  type: 'response.output_item.done',
                  item: {
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'zotero_get_full_pdf',
                    arguments: '{}',
                  },
                };
                yield { type: 'response.completed', response: {} };
              })()
            : (async function* () {
                yield {
                  type: 'response.output_text.delta',
                  delta: 'Summary from tool output',
                };
                yield {
                  type: 'response.output_item.done',
                  item: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Summary from tool output' }],
                  },
                };
                yield {
                  type: 'response.completed',
                  response: { usage: { input_tokens: 10, output_tokens: 4 } },
                };
              })();
        }
        if (params.stream) return fakeStream();
        return fakeStream();
      },
    };
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
  beforeEach(() => {
    requestLog.requests = [];
  });

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
      { type: 'usage', input: 7, output: 2, cacheRead: 0 },
    ]);
  });

  it('executes local tools and feeds outputs back to the model', async () => {
    const p = new OpenAIProvider();
    const got: StreamChunk[] = [];

    for await (const c of p.stream(
      [{ role: 'user', content: '总结当前论文' }],
      'be helpful',
      preset,
      new AbortController().signal,
      {
        tools: [
          {
            name: 'zotero_get_full_pdf',
            description: 'Read the current PDF.',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({
              output: '[Paper full text]\ncontent',
              summary: '读取 PDF 全文',
              context: { planMode: 'full_pdf', fullTextChars: 7 },
            }),
          },
        ],
        maxToolIterations: 2,
      },
    )) {
      got.push(c);
    }

    expect(got).toEqual([
      {
        type: 'tool_call',
        name: 'zotero_get_full_pdf',
        status: 'started',
        summary: '调用 Zotero 工具: zotero_get_full_pdf',
      },
      {
        type: 'tool_call',
        name: 'zotero_get_full_pdf',
        status: 'completed',
        summary: '读取 PDF 全文',
        context: { planMode: 'full_pdf', fullTextChars: 7 },
      },
      { type: 'text_delta', text: 'Summary from tool output' },
      { type: 'usage', input: 10, output: 4, cacheRead: 0 },
    ]);
    expect(requestLog.requests).toHaveLength(2);
    expect(requestLog.requests[1].input).toEqual([
      { role: 'user', content: '总结当前论文' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'zotero_get_full_pdf',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '[Paper full text]\ncontent',
      },
    ]);
  });

  it('blocks approval-required tools unless YOLO is enabled', async () => {
    const p = new OpenAIProvider();
    const got: StreamChunk[] = [];

    for await (const c of p.stream(
      [{ role: 'user', content: 'write note' }],
      'be helpful',
      preset,
      new AbortController().signal,
      {
        tools: [
          {
            name: 'zotero_get_full_pdf',
            description: 'Pretend write tool.',
            parameters: { type: 'object', properties: {} },
            requiresApproval: true,
            execute: async () => ({ output: 'should not run' }),
          },
        ],
        maxToolIterations: 1,
        permissionMode: 'default',
      },
    )) {
      got.push(c);
    }

    expect(got).toContainEqual({
      type: 'tool_call',
      name: 'zotero_get_full_pdf',
      status: 'error',
      summary: '需要审批: zotero_get_full_pdf',
      context: undefined,
    });
  });

  it('converts screenshot attachments into Responses image inputs', () => {
    expect(toOpenAIInput([
      {
        role: 'user',
        content: '分析这张图',
        images: [
          {
            id: 'img-1',
            marker: '[Image #1]',
            name: 'shot.png',
            mediaType: 'image/png',
            dataUrl: 'data:image/png;base64,abc',
            size: 3,
          },
        ],
      },
    ])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: '分析这张图' },
          { type: 'input_text', text: '<image name=[Image #1]>' },
          { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'high' },
          { type: 'input_text', text: '</image>' },
        ],
      },
    ]);
  });
});
