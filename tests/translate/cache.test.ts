import { describe, it, expect } from 'vitest';
import {
  cacheKey,
  deleteCachedTranslationsForSources,
  getFullTextCachedTranslation,
  getLooseCachedTranslation,
  loadCache,
  saveCache,
  setCachedTranslation,
  getCachedTranslation,
  type TranslateCacheState,
} from '../../src/translate/cache';

const makePrefs = () => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: string) => { store.set(k, v); },
  };
};

describe('translate cache', () => {
  it('produces a stable 16-char key for same inputs', () => {
    const k1 = cacheKey({ sentence: 'Hello.', target: 'zh', endpoint: 'https://api.example.com', model: 'gpt-5.4', thinking: 'medium', ctxLevel: 'none' });
    const k2 = cacheKey({ sentence: 'Hello.', target: 'zh', endpoint: 'https://api.example.com', model: 'gpt-5.4', thinking: 'medium', ctxLevel: 'none' });
    expect(k1).toEqual(k2);
    expect(k1).toHaveLength(16);
  });

  it('produces different keys when any param changes', () => {
    const base = { sentence: 'Hello.', target: 'zh', endpoint: 'e', model: 'm', thinking: 't', ctxLevel: 'l' };
    const k1 = cacheKey(base);
    const k2 = cacheKey({ ...base, model: 'm2' });
    expect(k1).not.toEqual(k2);
  });

  it('round-trips through prefs', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', { text: '你好。', model: 'gpt-5.4', createdAt: 1000 });
    const got = getCachedTranslation(prefs, 'k1');
    expect(got?.text).toBe('你好。');
  });

  it('deletes cached translations for one paper source set', () => {
    const prefs = makePrefs();
    const paragraph = 'This paper paragraph should be retranslated.';
    const exactFullTextKey = cacheKey({
      sentence: paragraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'full-text',
    });
    const exactPointKey = cacheKey({
      sentence: paragraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });
    setCachedTranslation(prefs, exactFullTextKey, {
      text: '旧全文译文。',
      model: 'gpt-5.4',
      createdAt: 1000,
    });
    setCachedTranslation(prefs, exactPointKey, {
      text: '旧点译译文。',
      model: 'gpt-5.4',
      createdAt: 1001,
    });
    setCachedTranslation(prefs, 'source-match-other-model', {
      text: '其他模型旧译文。',
      model: 'gpt-5.5',
      createdAt: 1002,
      sourceText: paragraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'medium',
      ctxLevel: 'full-text',
    });
    setCachedTranslation(prefs, 'unrelated', {
      text: '保留。',
      model: 'gpt-5.4',
      createdAt: 1003,
      sourceText: 'An unrelated paragraph.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const deleted = deleteCachedTranslationsForSources(prefs, {
      sources: [paragraph],
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
    });
    const entries = loadCache(prefs).entries;

    expect(deleted).toBe(3);
    expect(entries[exactFullTextKey]).toBeUndefined();
    expect(entries[exactPointKey]).toBeUndefined();
    expect(entries['source-match-other-model']).toBeUndefined();
    expect(entries.unrelated?.text).toBe('保留。');
  });

  it('finds old full-text cache entries using paragraph context', () => {
    const prefs = makePrefs();
    const paragraph = 'The model translates paragraphs in a full text batch.';
    const key = cacheKey({
      sentence: paragraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'full-text',
    });
    setCachedTranslation(prefs, key, {
      text: '模型会在全文批处理中翻译段落。',
      model: 'gpt-5.4',
      createdAt: 1000,
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: 'translates paragraphs',
      paragraphContext: paragraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got?.text).toBe('模型会在全文批处理中翻译段落。');
  });

  it('finds new full-text cache entries whose source contains the point text', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', {
      text: '模型会在全文批处理中翻译段落。',
      model: 'gpt-5.4',
      createdAt: 1000,
      sourceText: 'The model translates paragraphs in a full text batch.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: 'The model translates paragraphs in a full text',
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'paragraph',
    });

    expect(got?.text).toBe('模型会在全文批处理中翻译段落。');
  });

  it('does not match a full-text source when the clicked text starts in the middle', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', {
      text: '这是上一段加当前段的译文。',
      model: 'gpt-5.4',
      createdAt: 1000,
      sourceText:
        'Previous paragraph tail. The clicked paragraph starts here and continues.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: 'The clicked paragraph starts here and continues.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got).toBeUndefined();
  });

  it('does not loosely match a full-text source when the clicked text starts in the middle', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', {
      text: '这是上一段加当前段的译文。',
      model: 'gpt-5.4',
      createdAt: 1000,
      sourceText:
        'Previous paragraph tail. The clicked paragraph starts here and continues.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getLooseCachedTranslation(prefs, {
      sentence: 'The clicked paragraph starts here and continues.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got).toBeUndefined();
  });

  it('finds full-text chunks contained inside a larger point paragraph', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', {
      text: '第一块译文。',
      model: 'gpt-5.4',
      createdAt: 1000,
      sourceText: 'The first chunk is translated during full text mode.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });
    setCachedTranslation(prefs, 'k2', {
      text: '第二块译文。',
      model: 'gpt-5.4',
      createdAt: 2000,
      sourceText: 'The second chunk is translated during full text mode.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: [
        'The first chunk is translated during full text mode.',
        'The second chunk is translated during full text mode.',
      ].join(' '),
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'paragraph',
    });

    expect(got?.text).toBe('第一块译文。\n\n第二块译文。');
  });

  it('does not combine partial overlaps from adjacent full-text chunks', () => {
    const prefs = makePrefs();
    const clickedParagraph = [
      'Joint Embedding Predictive Architectures offer a compelling framework for learning world models in compact latent spaces.',
      'Existing methods remain fragile and rely on complex multi-term losses, exponential moving averages, pretrained encoders, or auxiliary supervision.',
      'In this work, we introduce LeWorldModel, the first JEPA that trains stably end-to-end from raw pixels using only two loss terms.',
      'Surprise evaluation confirms that the model reliably detects physically implausible events.',
    ].join(' ');
    setCachedTranslation(prefs, 'k1', {
      text: '第一块译文。',
      model: 'gpt-5.5',
      createdAt: 1000,
      sourceText: [
        'LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels.',
        clickedParagraph.slice(0, 360),
      ].join(' '),
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });
    setCachedTranslation(prefs, 'k2', {
      text: '第二块译文。',
      model: 'gpt-5.5',
      createdAt: 2000,
      sourceText: [
        clickedParagraph.slice(260),
        'Figure 1: LeWorldModel Training Pipeline.',
      ].join(' '),
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: clickedParagraph,
      fullTextContext: [
        'LeWorldModel: Stable End-to-End Joint-Embedding Predictive Architecture from Pixels.',
        clickedParagraph,
        'Figure 1: LeWorldModel Training Pipeline.',
      ].join(' '),
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.5',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got).toBeUndefined();
  });

  it('reconstructs legacy chunk keys from a long point paragraph', () => {
    const prefs = makePrefs();
    const first = `${'A'.repeat(800)}.`;
    const second = `${'B'.repeat(800)}.`;
    const longParagraph = `${first} ${second}`;
    const chunks = [first, second];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const key = cacheKey({
        sentence: chunk,
        target: 'zh',
        endpoint: 'https://api.example.com',
        model: 'gpt-5.4',
        thinking: 'low',
        ctxLevel: 'full-text',
      });
      setCachedTranslation(prefs, key, {
        text: `旧缓存译文 ${index + 1}`,
        model: 'gpt-5.4',
        createdAt: 1000 + index,
      });
    }

    const got = getFullTextCachedTranslation(prefs, {
      sentence: 'B'.repeat(80),
      paragraphContext: longParagraph,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got?.text).toBe('旧缓存译文 1\n\n旧缓存译文 2');
  });

  it('reconstructs legacy chunk keys from full text when page context differs', () => {
    const prefs = makePrefs();
    const first = `${'A'.repeat(800)}.`;
    const second = `${'B'.repeat(800)}.`;
    const third = `${'C'.repeat(800)}.`;
    const fullText = `${first} ${second} ${third}`;
    const key = cacheKey({
      sentence: second,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'full-text',
    });
    setCachedTranslation(prefs, key, {
      text: '旧缓存第二块译文',
      model: 'gpt-5.4',
      createdAt: 1000,
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: second,
      paragraphContext: 'page context that does not match full text chunking',
      fullTextContext: fullText,
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got?.text).toBe('旧缓存第二块译文');
  });

  it('matches PDF text despite ligatures, hyphenation, and punctuation differences', () => {
    const prefs = makePrefs();
    setCachedTranslation(prefs, 'k1', {
      text: '高效翻译依赖稳定缓存。',
      model: 'gpt-5.4',
      createdAt: 1000,
      sourceText: 'Efficient translation depends on stable caches.',
      target: 'zh',
      endpoint: 'https://api.example.com',
      thinking: 'low',
      ctxLevel: 'full-text',
    });

    const got = getFullTextCachedTranslation(prefs, {
      sentence: 'Efﬁcient trans- lation depends on stable caches',
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'none',
    });

    expect(got?.text).toBe('高效翻译依赖稳定缓存。');
  });

  it('caps cache to MAX entries (oldest evicted)', () => {
    const state: TranslateCacheState = { entries: {} };
    for (let i = 0; i < 510; i++) {
      state.entries[`k${i}`] = { text: `t${i}`, model: 'm', createdAt: i };
    }
    const prefs = makePrefs();
    saveCache(prefs, state);
    const loaded = loadCache(prefs);
    expect(Object.keys(loaded.entries).length).toBeLessThanOrEqual(500);
    expect(loaded.entries['k509']).toBeDefined();
    expect(loaded.entries['k0']).toBeUndefined();
  });
});
