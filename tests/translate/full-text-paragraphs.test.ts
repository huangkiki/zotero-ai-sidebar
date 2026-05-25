import { describe, expect, it } from 'vitest';
import { splitFullTextParagraphs } from '../../src/translate/full-text';

describe('splitFullTextParagraphs', () => {
  it('skips the References section during full-text translation', () => {
    const paragraphs = splitFullTextParagraphs([
      'Abstract',
      '',
      'This is the abstract paragraph with enough content to translate.',
      '',
      '1 Introduction',
      '',
      'This is the main body paragraph that should be translated normally.',
      '',
      'References',
      '',
      '[1] Someone. A paper title that should not be sent for translation.',
    ].join('\n'));

    expect(paragraphs).toEqual([
      'This is the abstract paragraph with enough content to translate.',
      'This is the main body paragraph that should be translated normally.',
    ]);
  });

  it('recognizes numbered and Chinese reference headings', () => {
    const numbered = splitFullTextParagraphs([
      'Main text paragraph that should stay in the translation queue.',
      '',
      '6. References',
      '',
      '[1] skipped reference',
    ].join('\n'));
    const chinese = splitFullTextParagraphs([
      '正文段落应该保留并进入全文翻译流程，而且不应该被参考文献过滤逻辑移除。',
      '',
      '参考文献',
      '',
      '[1] 不应翻译的参考条目',
    ].join('\n'));

    expect(numbered).toEqual([
      'Main text paragraph that should stay in the translation queue.',
    ]);
    expect(chinese).toEqual([
      '正文段落应该保留并进入全文翻译流程，而且不应该被参考文献过滤逻辑移除。',
    ]);
  });

  it('does not skip ordinary paragraphs that merely mention references', () => {
    const paragraphs = splitFullTextParagraphs([
      'The method references prior work but this is still body text.',
      '',
      'The next paragraph should also remain available for translation.',
    ].join('\n'));

    expect(paragraphs).toEqual([
      'The method references prior work but this is still body text.',
      'The next paragraph should also remain available for translation.',
    ]);
  });
});
