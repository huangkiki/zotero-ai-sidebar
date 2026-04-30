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
      context: { selectedText: 'Recent selected figure caption.' },
    };
    const assistantMessage: Message = { role: 'assistant', content: '解释结果' };
    const currentMessage: Message = { role: 'user', content: '继续解释' };

    const messages = toApiMessages([oldMessage, assistantMessage, currentMessage], {
      message: currentMessage,
    });

    expect(messages[0].content).toContain('[Selected PDF text]');
    expect(messages[0].content).toContain('Recent selected figure caption.');
    expect(messages[2].content).toBe('继续解释');
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
    expect(ledger).toContain('selected_text_chars=20');
    expect(ledger).toContain('annotations=1');
    expect(ledger).toContain('pdf_ranges=10-30');
    expect(ledger).not.toContain('secret selected text');
    expect(ledger).not.toContain('secret annotation text');
    expect(ledger).not.toContain('secret passage text');
  });
});
