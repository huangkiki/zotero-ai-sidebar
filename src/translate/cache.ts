export const CACHE_PREFS_KEY = 'extensions.zotero-ai-sidebar.translateCache';
export const MAX_CACHE_ENTRIES = 500;

export interface CacheEntry {
  text: string;
  model: string;
  createdAt: number;
}

export interface TranslateCacheState {
  entries: Record<string, CacheEntry>;
}

interface PrefsStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface CacheKeyInput {
  sentence: string;
  target: string;
  endpoint: string;
  model: string;
  thinking: string;
  ctxLevel: string;
}

// Synchronous FNV-1a-style 64-bit hex digest. Cache keys need stability
// and low collision rate, not crypto strength — and we run in environments
// where WebCrypto's sync API is unavailable.
function fnv1aHex64(input: string): string {
  let h1 = 0xcbf29ce4 >>> 0;
  let h2 = 0x84222325 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 0x9e37), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function cacheKey(input: CacheKeyInput): string {
  const payload = [
    normalizeSentence(input.sentence),
    input.target,
    input.endpoint,
    input.model,
    input.thinking,
    input.ctxLevel,
  ].join('|');
  return fnv1aHex64(payload).slice(0, 16);
}

export function loadCache(prefs: PrefsStore): TranslateCacheState {
  const raw = prefs.get(CACHE_PREFS_KEY);
  if (!raw) return { entries: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { entries: {} };
    const entries = (parsed as { entries?: Record<string, unknown> }).entries;
    if (!entries || typeof entries !== 'object') return { entries: {} };
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<CacheEntry>;
      if (typeof e.text === 'string' && typeof e.model === 'string' && typeof e.createdAt === 'number') {
        out[k] = { text: e.text, model: e.model, createdAt: e.createdAt };
      }
    }
    return { entries: out };
  } catch {
    return { entries: {} };
  }
}

export function saveCache(prefs: PrefsStore, state: TranslateCacheState): void {
  const trimmed = trimCache(state);
  prefs.set(CACHE_PREFS_KEY, JSON.stringify(trimmed));
}

function trimCache(state: TranslateCacheState): TranslateCacheState {
  const entries = Object.entries(state.entries);
  if (entries.length <= MAX_CACHE_ENTRIES) return state;
  entries.sort(([, a], [, b]) => b.createdAt - a.createdAt);
  const kept = entries.slice(0, MAX_CACHE_ENTRIES);
  const out: Record<string, CacheEntry> = {};
  for (const [k, v] of kept) out[k] = v;
  return { entries: out };
}

export function getCachedTranslation(prefs: PrefsStore, key: string): CacheEntry | undefined {
  return loadCache(prefs).entries[key];
}

// Non-atomic load-modify-save. Safe here because writes are user-driven
// (one click → one translate → one cache write), so concurrent writers
// don't exist in the runtime model. Do not call from background timers.
export function setCachedTranslation(prefs: PrefsStore, key: string, entry: CacheEntry): void {
  const state = loadCache(prefs);
  state.entries[key] = entry;
  saveCache(prefs, state);
}
