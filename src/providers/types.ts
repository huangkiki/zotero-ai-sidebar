import type { AgentPermissionMode, ModelPreset } from '../settings/types';
import type { MessageContext } from '../context/types';

export type MessageRole = 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
  thinking?: string;
  images?: MessageImage[];
  context?: MessageContext;
}

export interface MessageImage {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
}

export interface ToolExecutionResult {
  output: string;
  summary?: string;
  context?: MessageContext;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: { [key: string]: unknown };
  requiresApproval?: boolean;
  execute(args: unknown): Promise<ToolExecutionResult>;
}

export interface ProviderStreamOptions {
  tools?: AgentTool[];
  maxToolIterations?: number;
  permissionMode?: AgentPermissionMode;
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; name: string; status: 'started' | 'completed' | 'error'; summary?: string; context?: MessageContext }
  | { type: 'usage'; input: number; output: number; cacheRead?: number }
  | { type: 'error'; message: string };

export interface Provider {
  stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
    options?: ProviderStreamOptions,
  ): AsyncIterable<StreamChunk>;
}

export type ProviderFactory = (preset: ModelPreset) => Provider;
