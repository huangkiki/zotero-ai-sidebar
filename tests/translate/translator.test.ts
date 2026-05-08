import { describe, expect, it } from 'vitest';
import {
  cleanTranslationOutput,
  translationNeedsRetry,
} from '../../src/translate/translator';


describe('translation retry guard', () => {
  it('retries English paraphrases for English source sentences', () => {
    expect(
      translationNeedsRetry(
        'We describe a new model based on heterogeneous tasks.',
        'This is a new model based on heterogeneous tasks.',
      ),
    ).toBe(true);
  });

  it('accepts Simplified Chinese translations with retained terms', () => {
    expect(
      translationNeedsRetry(
        'We describe π0.5, a new model based on π0.',
        '我们介绍 π0.5，这是一个基于 π0 的新模型。',
      ),
    ).toBe(false);
  });

  it('removes common translation labels from model output', () => {
    expect(cleanTranslationOutput('译文：你好')).toBe('你好');
    expect(cleanTranslationOutput('Translation: 你好')).toBe('你好');
  });
});
