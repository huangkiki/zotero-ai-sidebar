import type { Message } from '../providers/types';
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from './policy';
import type { ItemAnnotation, RetrievedPassage } from './types';

export function toApiMessages(
  messages: Message[],
  currentContext?: { message: Message; fullText?: string },
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): Message[] {
  const currentIndex = currentContext
    ? messages.indexOf(currentContext.message)
    : messages.length - 1;
  const retainedContextIndexes = retainedRecentContextIndexes(
    messages,
    currentIndex,
    policy,
  );

  return messages.map((message) => ({
    role: message.role,
    content: message.role === 'user' &&
      (currentContext?.message === message || retainedContextIndexes.has(messages.indexOf(message)))
      ? formatUserMessageForApi(
          message,
          currentContext?.message === message ? currentContext.fullText : undefined,
        )
      : message.content,
    ...(message.images?.length ? { images: message.images } : {}),
  }));
}

export function retainedContextStats(
  messages: Message[],
  currentMessage: Message,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): { count: number; chars: number } {
  const currentIndex = messages.indexOf(currentMessage);
  if (currentIndex < 0) return { count: 0, chars: 0 };
  const indexes = retainedRecentContextIndexes(messages, currentIndex, policy);
  let chars = 0;
  indexes.forEach((index) => {
    chars += contextSourceChars(messages[index]);
  });
  return { count: indexes.size, chars };
}

export function formatUserMessageForApi(message: Message, fullText?: string): string {
  const contextBlocks = formatContextBlocks(message, fullText);
  if (!contextBlocks.length) return message.content;
  return [...contextBlocks, '[User question]', message.content].join('\n');
}

export function formatRetrievedPassages(passages: RetrievedPassage[]): string {
  return passages
    .map(
      (passage, index) =>
        `[${index + 1}] chars ${passage.start}-${passage.end}, score ${passage.score}\n${passage.text}`,
    )
    .join('\n\n');
}

export function contextSummaryLine(message: Message): string {
  const context = message.context;
  if (!context) return '';
  if (context.selectedText) {
    return `已随本轮发送 PDF 选区 ${context.selectedText.length} 字`;
  }
  if (context.annotations?.length) {
    return `已随本轮发送 Zotero 标注 ${context.annotations.length} 条`;
  }
  if (context.retrievedPassages?.length) {
    const chars = context.retrievedPassages.reduce(
      (sum, passage) => sum + passage.text.length,
      0,
    );
    if (context.planMode === 'pdf_range') {
      return `模型请求 PDF 字符范围 ${context.retrievedPassages.length} 段 / ${chars} 字`;
    }
    const candidateSuffix = context.candidatePassageCount
      ? `/${context.candidatePassageCount}`
      : '';
    const source = context.passageSelectorSource === 'fallback' ? '本地兜底选择' : '模型选择';
    return `${source} PDF 片段 ${context.retrievedPassages.length}${candidateSuffix} 段 / ${chars} 字`;
  }
  if (context.candidatePassageCount) {
    return `模型查看 PDF 候选 ${context.candidatePassageCount} 段，最终未发送片段`;
  }
  if (context.fullTextChars) {
    return `已随本轮发送 PDF 全文 ${context.fullTextChars} 字`;
  }
  if (context.toolCalls?.length) {
    const completed = context.toolCalls.filter((tool) => tool.status === 'completed').length;
    const errors = context.toolCalls.filter((tool) => tool.status === 'error').length;
    return `模型调用 Zotero 工具 ${context.toolCalls.length} 次 / 完成 ${completed} / 错误 ${errors}`;
  }
  if (context.planMode === 'metadata_only') {
    return '本轮仅发送题录/摘要信息';
  }
  if (context.planMode === 'annotations') {
    return '本轮请求 Zotero 标注，但未找到可发送内容';
  }
  if (context.planMode === 'none') {
    if (context.retainedContextCount) {
      return `本轮未请求新论文正文；保留最近上下文 ${context.retainedContextCount} 段 / ${context.retainedContextChars ?? 0} 字`;
    }
    return '本轮未发送论文正文';
  }
  return '';
}

export function formatContextMarkdown(message: Message): string[] {
  const context = message.context;
  if (!context) return [];

  const lines: string[] = [];
  const summary = contextSummaryLine(message);
  if (summary) lines.push('### 上下文', '', summary, '');
  if (context.planReason) {
    lines.push(`- 规划: ${context.planMode ?? 'unknown'} (${context.plannerSource ?? 'unknown'})`);
    lines.push(`- 原因: ${context.planReason}`);
    if (context.query) lines.push(`- 检索问题: ${context.query}`);
    if (
      typeof context.rangeStart === 'number' &&
      typeof context.rangeEnd === 'number'
    ) {
      lines.push(`- PDF 范围: ${context.rangeStart}-${context.rangeEnd}`);
    }
    if (context.candidatePassageCount) {
      lines.push(`- 候选片段: ${context.candidatePassageCount}`);
    }
    if (context.selectedPassageNumbers?.length) {
      lines.push(`- 选中片段: ${context.selectedPassageNumbers.join(', ')}`);
    }
    if (context.passageSelectionReason) {
      lines.push(
        `- 片段选择: ${context.passageSelectorSource ?? 'unknown'}; ${context.passageSelectionReason}`,
      );
    }
    lines.push('');
  }
  if (context.toolCalls?.length) {
    lines.push(`- 工具调用: ${formatToolTraceInline(context.toolCalls)}`, '');
  }
  if (context.selectedText) {
    lines.push('### PDF 选区', '', context.selectedText, '');
  }
  if (context.retrievedPassages?.length) {
    lines.push('### PDF 检索片段', '', formatRetrievedPassages(context.retrievedPassages), '');
  }
  return lines;
}

export function formatContextLedger(messages: Message[]): string {
  const lines: string[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user' || !message.context) return;
    const context = message.context;
    const parts = [`turn ${index + 1}`, `mode=${context.planMode ?? 'unknown'}`];
    if (context.selectedText) parts.push(`selected_text_chars=${context.selectedText.length}`);
    if (context.fullTextChars) parts.push(`full_pdf_chars=${context.fullTextChars}`);
    if (context.retrievedPassages?.length) {
      const chars = context.retrievedPassages.reduce(
        (sum, passage) => sum + passage.text.length,
        0,
      );
      const ranges = context.retrievedPassages
        .map((passage) => `${passage.start}-${passage.end}`)
        .join(',');
      parts.push(`pdf_passages=${context.retrievedPassages.length}`);
      parts.push(`pdf_passage_chars=${chars}`);
      parts.push(`pdf_ranges=${ranges}`);
    }
    if (context.candidatePassageCount) {
      parts.push(`candidate_passages=${context.candidatePassageCount}`);
    }
    if (context.selectedPassageNumbers?.length) {
      parts.push(`selected_candidates=${context.selectedPassageNumbers.join(',')}`);
    }
    if (context.query) parts.push(`query=${JSON.stringify(context.query)}`);
    if (
      typeof context.rangeStart === 'number' &&
      typeof context.rangeEnd === 'number'
    ) {
      parts.push(`requested_range=${context.rangeStart}-${context.rangeEnd}`);
    }
    if (context.annotations?.length) parts.push(`annotations=${context.annotations.length}`);
    if (context.retainedContextCount) {
      parts.push(`retained_contexts=${context.retainedContextCount}`);
      parts.push(`retained_context_chars=${context.retainedContextChars ?? 0}`);
    }
    if (context.toolCalls?.length) {
      parts.push(`tool_calls=${context.toolCalls.map((tool) => `${tool.name}:${tool.status}`).join(',')}`);
    }
    lines.push(`- ${parts.join('; ')}`);
  });
  return lines.length ? lines.join('\n') : 'none';
}

function formatToolTraceInline(
  tools: Array<{ name: string; status: string; summary?: string }>,
): string {
  return tools
    .map((tool) => `${tool.name}:${tool.status}${tool.summary ? ` (${tool.summary})` : ''}`)
    .join('; ');
}

function formatContextBlocks(message: Message, fullText?: string): string[] {
  const context = message.context;
  if (!context && !fullText) return [];

  const blocks: string[] = [];
  if (context?.selectedText) {
    blocks.push('[Selected PDF text]', context.selectedText, '');
  }
  if (context?.annotations?.length) {
    blocks.push('[Zotero annotations]', formatAnnotations(context.annotations), '');
  }
  if (context?.retrievedPassages?.length) {
    blocks.push(
      '[Retrieved PDF passages]',
      formatRetrievedPassages(context.retrievedPassages),
      '',
    );
  }
  if (fullText) {
    blocks.push('[Paper full text]', fullText, '');
  }
  if (context?.planMode && !context.selectedText) {
    blocks.push(
      '[Context plan]',
      [
        `mode: ${context.planMode}`,
        context.plannerSource ? `source: ${context.plannerSource}` : '',
        context.planReason ? `reason: ${context.planReason}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      '',
    );
  }
  return blocks;
}

export function formatAnnotations(annotations: ItemAnnotation[]): string {
  return annotations
    .map((annotation, index) => {
      const parts = [
        `[${index + 1}] ${annotation.type}`,
        annotation.pageLabel ? `page ${annotation.pageLabel}` : '',
        annotation.color ? annotation.color : '',
      ].filter(Boolean);
      const body = [
        parts.join(' · '),
        annotation.text,
        annotation.comment ? `Comment: ${annotation.comment}` : '',
      ].filter(Boolean);
      return body.join('\n');
    })
    .join('\n\n');
}

function retainedRecentContextIndexes(
  messages: Message[],
  currentIndex: number,
  policy: ContextPolicy,
): Set<number> {
  const retained = new Set<number>();
  const signatures = new Set<string>();
  let remainingChars = policy.retainedContextCharBudget;
  const minIndex = Math.max(0, currentIndex - policy.retainedContextTurnCount);

  for (let index = currentIndex - 1; index >= minIndex; index--) {
    const message = messages[index];
    if (message?.role !== 'user' || !message.context) continue;
    const chars = contextSourceChars(message);
    if (chars <= 0 || chars > remainingChars) continue;
    const signature = contextSignature(message);
    if (signature && signatures.has(signature)) continue;
    retained.add(index);
    if (signature) signatures.add(signature);
    remainingChars -= chars;
  }
  return retained;
}

function contextSourceChars(message: Message): number {
  const context = message.context;
  if (!context) return 0;
  const annotationChars = context.annotations?.reduce(
    (sum, annotation) =>
      sum + annotation.text.length + (annotation.comment?.length ?? 0),
    0,
  ) ?? 0;
  const passageChars = context.retrievedPassages?.reduce(
    (sum, passage) => sum + passage.text.length,
    0,
  ) ?? 0;
  return (context.selectedText?.length ?? 0) + annotationChars + passageChars;
}

function contextSignature(message: Message): string {
  const context = message.context;
  if (!context) return '';
  if (context.selectedText) return `selected:${context.selectedText}`;
  if (context.retrievedPassages?.length) {
    return `passages:${context.retrievedPassages
      .map((passage) => `${passage.start}-${passage.end}`)
      .join(',')}`;
  }
  if (context.annotations?.length) {
    return `annotations:${context.annotations
      .map((annotation) => `${annotation.pageLabel ?? ''}:${annotation.text}`)
      .join('|')}`;
  }
  return '';
}
