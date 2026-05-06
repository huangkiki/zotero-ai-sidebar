import { describe, expect, it } from 'vitest';
import {
  contextSummaryLine,
  formatContextLedger,
  formatUserMessageForApi,
  retainedContextStats,
  toApiMessages,
} from '../../src/context/message-format';
import { DEFAULT_CONTEXT_POLICY } from '../../src/context/policy';
import type { Message } from '../../src/providers/types';

describe('formatUserMessageForApi', () => {
  it('places selected PDF text before the user question', () => {
    const message: Message = {
      role: 'user',
      content: '解释这段',
      context: { selectedText: 'Important selected text.' },
    };

    expect(formatUserMessageForApi(message)).toBe(
      [
        '[Selected PDF text]',
        'Important selected text.',
        '',
        '[Selected text handling instruction]',
        '用户问题若要求翻译、改写、润色、提取或逐句处理当前 PDF 选区，必须处理完整选区文本。\n这类任务只处理 [Selected PDF text]；不要把 [Retrieved PDF passages]、附近上下文或历史选区混入译文/改写结果。\n除非用户明确要求总结/压缩，不要用省略号（如 …、……、...）替代选区中的未翻译或未处理内容。\n如果选区本身包含省略号，可以保留原文含义，但不要新增省略来跳过内容。',
        '',
        '[User question]',
        '解释这段',
      ].join('\n'),
    );
  });

  it('includes retrieved passages and context plan', () => {
    const message: Message = {
      role: 'user',
      content: '实验结果是什么？',
      context: {
        planMode: 'search_pdf',
        planReason: '需要局部证据',
        plannerSource: 'model',
        retrievedPassages: [
          { text: 'The experiment improves accuracy.', start: 10, end: 43, score: 18 },
        ],
      },
    };

    const formatted = formatUserMessageForApi(message);

    expect(formatted).toContain('[Retrieved PDF passages]');
    expect(formatted).toContain('The experiment improves accuracy.');
    expect(formatted).toContain('mode: search_pdf');
    expect(formatted).toContain('[User question]');
  });

  it('includes Zotero annotations for the current turn', () => {
    const message: Message = {
      role: 'user',
      content: '总结我的标注',
      context: {
        planMode: 'annotations',
        annotations: [
          {
            type: 'highlight',
            text: 'Important highlighted text.',
            comment: 'Connect to related work.',
            pageLabel: '4',
            color: '#ffd400',
          },
        ],
      },
    };

    const formatted = formatUserMessageForApi(message);

    expect(formatted).toContain('[Zotero annotations]');
    expect(formatted).toContain('Important highlighted text.');
    expect(formatted).toContain('Comment: Connect to related work.');
  });

  it('adds hidden annotation instruction without changing the visible question', () => {
    const message: Message = {
      role: 'user',
      content: '这句话为什么重要？',
      context: {
        selectedText: 'Important selected text.',
        annotationSuggestion: true,
        annotationColorGuide: '#2ea8e5 蓝色：任务定义。',
      },
    };

    const formatted = formatUserMessageForApi(message);

    expect(formatted).toContain('[Annotation suggestion instruction]');
    expect(formatted).toContain('[Selected text handling instruction]');
    expect(formatted).toContain('建议注释');
    expect(formatted).toContain('建议颜色：#hex');
    expect(formatted).toContain('#2ea8e5 蓝色');
    expect(formatted.endsWith('[User question]\n这句话为什么重要？')).toBe(true);
  });
});

describe('toApiMessages', () => {
  it('injects full text only for the current user message', () => {
    const oldMessage: Message = { role: 'user', content: 'old' };
    const currentMessage: Message = {
      role: 'user',
      content: '总结',
      context: { planMode: 'full_pdf', fullTextChars: 12 },
    };

    const messages = toApiMessages([oldMessage, currentMessage], {
      message: currentMessage,
      fullText: 'PDF full text',
    });

    expect(messages[0].content).toBe('old');
    expect(messages[1].content).toContain('[Paper full text]');
    expect(messages[1].content).toContain('PDF full text');
  });

  it('does not resend old PDF context from previous user turns', () => {
    const oldMessage: Message = {
      role: 'user',
      content: 'old question',
      context: {
        selectedText: 'Do not send this old selected text again.',
        retrievedPassages: [
          { text: 'Do not send this old passage again.', start: 0, end: 36, score: 1 },
        ],
      },
    };
    const currentMessage: Message = { role: 'user', content: 'new question' };

    const messages = toApiMessages([oldMessage, currentMessage], {
      message: currentMessage,
    }, {
      ...DEFAULT_CONTEXT_POLICY,
      retainedContextTurnCount: 4,
      retainedContextCharBudget: 0,
    });

    expect(messages[0].content).toBe('old question');
    expect(messages[0].content).not.toContain('Do not send this old');
    expect(messages[1].content).toBe('new question');
  });

  it('retains recent small context so continuation turns do not need a PDF search', () => {
    const oldMessage: Message = {
      role: 'user',
      content: '解释这段',
      context: {
        selectedText: 'Recent selected figure caption.',
        annotationSuggestion: true,
      },
    };
    const assistantMessage: Message = { role: 'assistant', content: '解释结果' };
    const currentMessage: Message = { role: 'user', content: '继续解释' };

    const messages = toApiMessages([oldMessage, assistantMessage, currentMessage], {
      message: currentMessage,
    });

    expect(messages[0].content).toContain('[Selected PDF text]');
    expect(messages[0].content).toContain('Recent selected figure caption.');
    expect(messages[0].content).not.toContain('[Selected text handling instruction]');
    expect(messages[0].content).not.toContain('[Annotation suggestion instruction]');
    expect(messages[2].content).toBe('继续解释');
  });

  it('does not retain previous selected context when current turn has a fresh selection', () => {
    const oldMessage: Message = {
      role: 'user',
      content: 'old translation',
      context: { selectedText: 'Old selected text should not leak.' },
    };
    const assistantMessage: Message = { role: 'assistant', content: 'old answer' };
    const currentMessage: Message = {
      role: 'user',
      content: '翻译',
      context: { selectedText: 'Fresh selected text.' },
    };

    const messages = toApiMessages([oldMessage, assistantMessage, currentMessage], {
      message: currentMessage,
    });

    expect(messages[0].content).toBe('old translation');
    expect(messages[2].content).toContain('Fresh selected text.');
    expect(messages[2].content).not.toContain('Old selected text');
  });

  it('reports retained recent context for visible tool traces', () => {
    const oldMessage: Message = {
      role: 'user',
      content: 'explain',
      context: { selectedText: 'Visible retained context.' },
    };
    const assistantMessage: Message = { role: 'assistant', content: 'answer' };
    const currentMessage: Message = { role: 'user', content: 'continue' };

    expect(
      retainedContextStats(
        [oldMessage, assistantMessage, currentMessage],
        currentMessage,
      ),
    ).toEqual({ count: 1, chars: 25 });
  });
});

describe('contextSummaryLine', () => {
  it('summarizes retrieved context for the UI chip', () => {
    const message: Message = {
      role: 'user',
      content: 'q',
      context: {
        candidatePassageCount: 2,
        passageSelectorSource: 'model',
        retrievedPassages: [
          { text: 'abc', start: 0, end: 3, score: 1 },
          { text: 'defg', start: 4, end: 8, score: 1 },
        ],
      },
    };

    expect(contextSummaryLine(message)).toBe('模型选择 PDF 片段 2/2 段 / 7 字');
  });
});

describe('formatContextLedger', () => {
  it('keeps previous context metadata without leaking old PDF text', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '总结',
        context: {
          planMode: 'full_pdf',
          sourceKind: 'zotero_item',
          sourceID: '1117',
          sourceTitle: 'Rethinking Range View Representation for LiDAR Segmentation',
          fullTextChars: 12000,
          selectedText: 'secret selected text',
          annotations: [
            {
              type: 'highlight',
              text: 'secret annotation text',
            },
          ],
          retrievedPassages: [
            { text: 'secret passage text', start: 10, end: 30, score: 5 },
          ],
        },
      },
    ];

    const ledger = formatContextLedger(messages);

    expect(ledger).toContain('full_pdf_chars=12000');
    expect(ledger).toContain('source_kind=zotero_item');
    expect(ledger).toContain('source_id="1117"');
    expect(ledger).toContain(
      'source_title="Rethinking Range View Representation for LiDAR Segmentation"',
    );
    expect(ledger).toContain('selected_text_chars=20');
    expect(ledger).toContain('annotations=1');
    expect(ledger).toContain('pdf_ranges=10-30');
    expect(ledger).toContain('previous_context_tool=chat_get_previous_context');
    expect(ledger).not.toContain('secret selected text');
    expect(ledger).not.toContain('secret annotation text');
    expect(ledger).not.toContain('secret passage text');
  });

  it('keeps tool summaries in the ledger so the model can see prior ranges', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: '总结第三章',
        context: {
          planMode: 'pdf_range',
          rangeStart: 11800,
          rangeEnd: 15000,
          toolCalls: [
            {
              name: 'zotero_read_pdf_range',
              status: 'completed',
              summary: '读取 PDF 范围 11800-20800',
            },
            {
              name: 'zotero_read_pdf_range',
              status: 'completed',
              summary: '读取 PDF 范围 20800-29800',
            },
          ],
        },
      },
    ];

    const ledger = formatContextLedger(messages);

    expect(ledger).toContain(
      'zotero_read_pdf_range:completed (读取 PDF 范围 11800-20800)',
    );
    expect(ledger).toContain(
      'zotero_read_pdf_range:completed (读取 PDF 范围 20800-29800)',
    );
  });
});
