import { describe, it, expect } from 'vitest';
import {
  cacheKey,
  getFullTextCachedTranslation,
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
      sentence: 'model translates paragraphs in a full text',
      target: 'zh',
      endpoint: 'https://api.example.com',
      model: 'gpt-5.4',
      thinking: 'low',
      ctxLevel: 'paragraph',
    });

    expect(got?.text).toBe('模型会在全文批处理中翻译段落。');
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
      sentence: 'B'.repeat(80),
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
