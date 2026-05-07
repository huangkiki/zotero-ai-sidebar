import { OpenAIProvider } from '../providers/openai';
import type { Message, StreamChunk } from '../providers/types';
import type { ModelPreset, ReasoningEffort, TranslateThinking } from '../settings/types';

const SYSTEM_PROMPT = [
  '你是一个专业学术翻译。',
  '把用户给出的英文句子翻译成简体中文，要求：',
  '1) 只输出译文本身，不要复述原文，不要加引号、序号、解释。',
  '2) 保留专业术语首次出现的英文括注（仅限关键术语，不要每个名词都标注）。',
  '3) 译文流畅，符合中文学术写作习惯。',
].join('\n');

export interface TranslateRequest {
  sentence: string;
  paragraphContext?: string;
  preset: ModelPreset;
  model: string;
  thinking: TranslateThinking;
  signal: AbortSignal;
}

export interface TranslateChunk {
  type: 'text' | 'error' | 'done';
  text?: string;
  message?: string;
}

const THINKING_TO_EFFORT: Record<TranslateThinking, ReasoningEffort> = {
  none: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

function buildUserMessage(req: TranslateRequest): string {
  if (!req.paragraphContext) return req.sentence;
  return [
    '上下文段落（仅用于消歧，不要翻译）：',
    req.paragraphContext,
    '',
    '请翻译这一句：',
    req.sentence,
  ].join('\n');
}

export async function* translateSentence(req: TranslateRequest): AsyncIterable<TranslateChunk> {
  const provider = new OpenAIProvider();
  const overriddenPreset: ModelPreset = {
    ...req.preset,
    model: req.model || req.preset.model,
    extras: {
      ...req.preset.extras,
      reasoningEffort: THINKING_TO_EFFORT[req.thinking],
      reasoningSummary: 'none',
    },
  };

  const messages: Message[] = [{ role: 'user', content: buildUserMessage(req) }];

  try {
    for await (const chunk of provider.stream(messages, SYSTEM_PROMPT, overriddenPreset, req.signal)) {
      const mapped = mapChunk(chunk);
      if (mapped) yield mapped;
      if (mapped?.type === 'error') return;
    }
    yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function mapChunk(chunk: StreamChunk): TranslateChunk | null {
  switch (chunk.type) {
    case 'text_delta':
      return { type: 'text', text: chunk.text };
    case 'error':
      return { type: 'error', message: chunk.message };
    default:
      return null;
  }
}
