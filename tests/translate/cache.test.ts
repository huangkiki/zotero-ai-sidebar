import { describe, it, expect } from 'vitest';
import {
  cacheKey,
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
