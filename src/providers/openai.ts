import OpenAI from 'openai';
import type {
  AgentTool,
  Message,
  Provider,
  ProviderStreamOptions,
  StreamChunk,
  ToolExecutionResult,
} from './types';
import type {
  ModelPreset,
  ReasoningEffort,
  ReasoningSummary,
} from '../settings/types';

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

type ResponseEvent = {
  type?: string;
  delta?: string;
  message?: string;
  item?: ResponseOutputItemLike;
  response?: {
    error?: { message?: string } | null;
    usage?: ResponseUsage;
  };
};

type ResponseOutputItemLike =
  | ResponseFunctionCallLike
  | ResponseMessageLike
  | ResponseReasoningLike;

export interface ResponseFunctionCallLike {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponseMessageLike {
  type: 'message';
  role?: 'assistant';
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponseReasoningLike {
  type: 'reasoning';
  summary?: Array<{ text?: string }>;
}

interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export class OpenAIProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: preset.apiKey,
      ...(preset.baseUrl ? { baseURL: preset.baseUrl } : {}),
      dangerouslyAllowBrowser: true,
    });

    if (options.tools?.length) {
      yield* this.streamWithTools(client, messages, systemPrompt, preset, signal, options);
      return;
    }

    let stream: AsyncIterable<unknown>;
    try {
      stream = (await client.responses.create(
        {
          model: preset.model,
          instructions: systemPrompt,
          input: toOpenAIInput(messages) as never,
          max_output_tokens: preset.maxTokens,
          reasoning: reasoningOptions(preset),
          stream: true,
          store: false,
        },
        { signal },
      )) as unknown as AsyncIterable<unknown>;
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream) {
        const chunk = responseEventToChunk(event as ResponseEvent);
        if (chunk) yield chunk;
      }
    } catch (err) {
      yield { type: 'error', message: errMsg(err) };
    }
  }

  private async *streamWithTools(
    client: OpenAI,
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options: ProviderStreamOptions,
  ): AsyncIterable<StreamChunk> {
    const tools = options.tools ?? [];
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const input: unknown[] = toOpenAIInput(messages);
    const maxIterations = options.maxToolIterations ?? 6;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let stream: AsyncIterable<unknown>;
      try {
        stream = await client.responses.create(
          {
            model: preset.model,
            instructions: systemPrompt,
            input,
            max_output_tokens: preset.maxTokens,
            reasoning: reasoningOptions(preset),
            tools: tools.map(openAIToolSpec),
            tool_choice: 'auto',
            parallel_tool_calls: false,
            stream: true,
            store: false,
          } as never,
          { signal },
        ) as unknown as AsyncIterable<unknown>;
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      const output: ResponseOutputItemLike[] = [];
      const calls: ResponseFunctionCallLike[] = [];
      let usage: ResponseUsage | undefined;
      let failed = false;

      try {
        for await (const event of stream) {
          const e = event as ResponseEvent;
          switch (e.type) {
            case 'response.output_text.delta':
              if (e.delta) yield { type: 'text_delta', text: e.delta };
              break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
              if (e.delta) yield { type: 'thinking_delta', text: e.delta };
              break;
            case 'response.output_item.done':
              if (e.item) {
                output.push(e.item);
                if (isFunctionCall(e.item)) calls.push(e.item);
              }
              break;
            case 'response.completed':
              usage = e.response?.usage;
              break;
            case 'response.failed':
              yield {
                type: 'error',
                message: e.response?.error?.message || 'OpenAI response failed',
              };
              failed = true;
              break;
            case 'error':
              yield { type: 'error', message: e.message || 'OpenAI stream error' };
              failed = true;
              break;
            default:
              break;
          }
          if (failed) break;
        }
      } catch (err) {
        yield { type: 'error', message: errMsg(err) };
        return;
      }

      if (failed) return;

      if (calls.length === 0) {
        if (usage) yield usageChunk(usage);
        return;
      }

      input.push(...calls.map(functionCallReplayItem));

      for (const call of calls) {
        yield {
          type: 'tool_call',
          name: call.name,
          status: 'started',
          summary: `调用 Zotero 工具: ${call.name}`,
        };
        const result = await executeToolCall(
          call,
          toolMap,
          signal,
          options.permissionMode ?? 'default',
        );
        yield {
          type: 'tool_call',
          name: call.name,
          status: result.status,
          summary: result.result.summary,
          context: result.result.context,
        };
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: result.result.output,
        } satisfies FunctionCallOutputItem);
      }
    }

    yield {
      type: 'error',
      message: 'Tool loop stopped because the model exceeded the local tool iteration limit.',
    };
  }
}

export function functionCallReplayItem(
  call: ResponseFunctionCallLike,
): ResponseFunctionCallLike {
  return {
    type: 'function_call',
    call_id: call.call_id,
    name: call.name,
    arguments: call.arguments,
  };
}

async function executeToolCall(
  call: ResponseFunctionCallLike,
  toolMap: Map<string, AgentTool>,
  signal: AbortSignal,
  permissionMode: 'default' | 'yolo',
): Promise<{ status: 'completed' | 'error'; result: ToolExecutionResult }> {
  if (signal.aborted) {
    return { status: 'error', result: { output: 'Tool call aborted.', summary: '工具调用已停止' } };
  }

  const tool = toolMap.get(call.name);
  if (!tool) {
    return {
      status: 'error',
      result: {
        output: `Unknown local tool: ${call.name}`,
        summary: `未知工具 ${call.name}`,
      },
    };
  }

  if (tool.requiresApproval && permissionMode !== 'yolo') {
    return {
      status: 'error',
      result: {
        output: `Local tool ${call.name} requires approval. Enable YOLO mode to run it without approval.`,
        summary: `需要审批: ${call.name}`,
      },
    };
  }

  let args: unknown;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return {
      status: 'error',
      result: {
        output: `Invalid JSON arguments for local tool: ${call.name}`,
        summary: `工具参数 JSON 无效: ${call.name}`,
      },
    };
  }

  try {
    return { status: 'completed', result: await tool.execute(args) };
  } catch (err) {
    return {
      status: 'error',
      result: {
        output: errMsg(err),
        summary: `工具执行失败: ${call.name}`,
      },
    };
  }
}

function openAIToolSpec(tool: AgentTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function toOpenAIInput(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (!message.images?.length) {
      return { role: message.role, content: message.content };
    }

    const content: Array<Record<string, string>> = [];
    if (message.content) {
      content.push({
        type: 'input_text',
        text: message.content,
      });
    }
    for (const image of message.images) {
      content.push({
        type: 'input_image',
        image_url: image.dataUrl,
      });
    }
    return { role: message.role, content };
  });
}

function isFunctionCall(item: ResponseOutputItemLike): item is ResponseFunctionCallLike {
  return item.type === 'function_call' &&
    typeof item.call_id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.arguments === 'string';
}

function extractOutputText(output: ResponseOutputItemLike[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
      if (part.type === 'refusal' && part.refusal) chunks.push(part.refusal);
    }
  }
  return chunks.join('');
}

function extractReasoning(output: ResponseOutputItemLike[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== 'reasoning') continue;
    for (const part of item.summary ?? []) {
      if (part.text) chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function reasoningOptions(preset: ModelPreset): {
  effort: ReasoningEffort;
  summary?: Exclude<ReasoningSummary, 'none'>;
} {
  const summary = preset.extras?.reasoningSummary ?? 'concise';
  return {
    effort: preset.extras?.reasoningEffort ?? 'xhigh',
    ...(summary === 'none' ? {} : { summary }),
  };
}

function responseEventToChunk(event: ResponseEvent): StreamChunk | null {
  switch (event.type) {
    case 'response.output_text.delta':
      return event.delta ? { type: 'text_delta', text: event.delta } : null;
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return event.delta ? { type: 'thinking_delta', text: event.delta } : null;
    case 'response.completed': {
      const usage = event.response?.usage;
      return usage ? usageChunk(usage) : null;
    }
    case 'response.failed':
      return {
        type: 'error',
        message: event.response?.error?.message || 'OpenAI response failed',
      };
    case 'error':
      return { type: 'error', message: event.message || 'OpenAI stream error' };
    default:
      return null;
  }
}

function usageChunk(usage: ResponseUsage): StreamChunk {
  return {
    type: 'usage',
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
