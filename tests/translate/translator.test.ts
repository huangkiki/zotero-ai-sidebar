import { describe, expect, it } from 'vitest';
import {
  cleanTranslationOutput,
  deterministicMetadataTranslation,
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

  it('accepts compact arXiv metadata that has no translatable sentence body', () => {
    expect(
      translationNeedsRetry(
        'arXiv:2603.19312v1 [cs.LG] 13 Mar 2026',
        'arXiv:2603.19312v1 [cs.LG] 13 Mar 2026',
      ),
    ).toBe(false);
  });

  it('keeps guarding ordinary English titles that are repeated unchanged', () => {
    expect(
      translationNeedsRetry(
        'LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels',
        'LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels',
      ),
    ).toBe(true);
  });

  it('normalizes arXiv metadata dates without calling the model', () => {
    expect(
      deterministicMetadataTranslation(
        'arXiv:2603.19312v1 [cs.LG] 13 Mar 2026',
      ),
    ).toBe('arXiv:2603.19312v1 [cs.LG] 2026年3月13日');
    expect(
      deterministicMetadataTranslation(
        'arXiv:2603.19312v1 [cs.LG] 2026年3月13日',
      ),
    ).toBe('arXiv:2603.19312v1 [cs.LG] 2026年3月13日');
  });

  it('removes common translation labels from model output', () => {
    expect(cleanTranslationOutput('译文：你好')).toBe('你好');
    expect(cleanTranslationOutput('Translation: 你好')).toBe('你好');
  });
});
