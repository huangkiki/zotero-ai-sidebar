import { describe, expect, it } from 'vitest';
import {
  extractPdfRange,
  queryTerms,
  searchPdfPassages,
} from '../../src/context/retrieval';

describe('searchPdfPassages', () => {
  it('returns the passage that best matches English query terms', () => {
    const text = [
      'The introduction motivates sequence models.',
      '',
      'The method uses sparse attention and a routing loss for long documents.',
      '',
      'The conclusion discusses limitations.',
    ].join('\n');

    const passages = searchPdfPassages(text, 'routing loss', 2);

    expect(passages[0].text).toContain('routing loss');
    expect(passages[0].score).toBeGreaterThan(0);
  });

  it('supports Chinese query phrases', () => {
    const text = [
      '本文介绍相关工作。',
      '',
      '实验结果显示，该方法在小样本设置下效果更稳定。',
      '',
      '最后总结局限性。',
    ].join('\n');

    const passages = searchPdfPassages(text, '实验结果', 1);

    expect(passages).toHaveLength(1);
    expect(passages[0].text).toContain('实验结果');
  });

  it('returns no candidates instead of guessing when no term matches', () => {
    const passages = searchPdfPassages('alpha\n\nbeta\n\ngamma', 'unmatched', 1);

    expect(passages).toEqual([]);
  });

  it('splits very long paragraphs before returning candidates', () => {
    const longParagraph = `target ${'a'.repeat(3000)}`;
    const passages = searchPdfPassages(
      ['intro', longParagraph, 'tail'].join('\n\n'),
      'target',
      3,
    );

    expect(passages[0].text.length).toBeLessThanOrEqual(1200);
  });
});

describe('queryTerms', () => {
  it('uses lexical tokens without semantic keyword rules', () => {
    expect(queryTerms('What is the 方法流程?')).toEqual(
      expect.arrayContaining(['what', 'is', 'the', '方法', '法流', '流程']),
    );
    expect(queryTerms('method-v2')).toEqual(['method-v2']);
  });
});

describe('extractPdfRange', () => {
  it('extracts only the exact range requested by the model plan', () => {
    const text = 'alpha beta gamma delta';
    const start = text.indexOf('beta');
    const end = text.indexOf('delta');
    const range = extractPdfRange(text, start, end);

    expect(range?.text).toBe('beta gamma');
    expect(range?.start).toBe(start);
    expect(range?.end).toBe(end);
  });

  it('returns null for invalid ranges instead of guessing a section', () => {
    expect(extractPdfRange('alpha beta', -1, 5)).toBeNull();
    expect(extractPdfRange('alpha beta', 8, 2)).toBeNull();
  });
});
