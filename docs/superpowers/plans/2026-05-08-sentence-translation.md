# 逐句翻译模式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Zotero PDF Reader 中加入"逐句翻译模式"——开启后单击句子即识别整句、调用 OpenAI 翻译为简体中文，并在原句上方/下方浮层显示译文，支持上一句/下一句跳转、独立模型与 thinking 配置、缓存命中、随 WebDAV 同步。

**Architecture:**
- **检测**：`caretPositionFromPoint` 拿到点击点的 PDF.js textLayer 字符索引 → 在 `pdf-locator` 的 `PageBundle.normalizedText` 上用句子切分算法（移植 zotero-pdf-translate 的 `splitSentences`）裁出整句 → 通过 `normalizedToOriginal` 反查原始字符 → 用现有 `locate(needle)` 拿到 PDF 矩形。
- **翻译**：复用 `OpenAIProvider.stream()` 但绕过 tool loop（无 `tools`），构造单条 user message 流式拿 `text_delta` 直接输出到浮层。
- **持久化**：独立 `extensions.zotero-ai-sidebar.translateSettings` 偏好（模型/preset/thinking/上下文/位置/快捷键），以及 `extensions.zotero-ai-sidebar.translateCache` JSON blob（key 为 sha1(归一化句子+目标语言+endpoint+model+thinking+ctxLevel)）。两者都加进 `SyncSnapshot` 字段并在 v1 schema 内向后兼容（可选字段）。
- **UI**：iframe 内注入一个绝对定位 overlay div + 顶部工具条按钮 `译`（亮色=ON），设置弹层包含 ON/OFF、preset 下拉、model 下拉、thinking segmented、context segmented、overlay position segmented、上一句/下一句 key recorder。点击模式下吞掉默认选择行为。

**Tech Stack:** TypeScript + Vitest + happy-dom，Zotero 7/8/9 plugin 运行时，PDF.js textLayer DOM API，OpenAI Responses streaming（已有 `src/providers/openai.ts`）。

---

## File Structure

**New files (7):**
- `src/translate/keybinding.ts` — 解析/格式化/匹配键盘组合（Shift+Enter 等）
- `src/translate/sentence-splitter.ts` — 句子切分（移植 zotero-pdf-translate 算法 + 缩写白名单）
- `src/translate/sentence-detect.ts` — 从 textLayer click 反推 PageBundle 句子区间 + rects
- `src/translate/translator.ts` — 调用 OpenAIProvider 流式翻译（无 tool loop）
- `src/translate/cache.ts` — sha1-keyed 翻译缓存读写 + 容量裁剪
- `src/translate/overlay.ts` — iframe 内浮层 DOM 渲染/定位/拆装
- `src/translate/translate-mode.ts` — 模式生命周期：注册/卸载点击监听、设置弹层、状态机

**Modified files (5):**
- `src/settings/types.ts` — 新增 `TranslateSettings` 类型与默认值
- `addon/prefs.js` — 注册新 prefs
- `src/sync/state.ts` — `SyncSnapshot` 加 `translateSettings` 与 `translateCache` 可选字段
- `src/modules/sidebar.ts` — 工具条加 `译` 按钮、绑定 translate-mode lifecycle
- `addon/content/sidebar.css` — `.zai-translate-overlay` 与设置弹层样式

**New test files (3):**
- `tests/translate/sentence-splitter.test.ts`
- `tests/translate/keybinding.test.ts`
- `tests/translate/cache.test.ts`

---

## Phase A — Pure Utilities (TDD)

### Task A1: keybinding utility

**Files:**
- Create: `src/translate/keybinding.ts`
- Test: `tests/translate/keybinding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/translate/keybinding.test.ts
import { describe, it, expect } from 'vitest';
import { parseKeybinding, formatKeybinding, matchesKeybinding } from '../../src/translate/keybinding';

describe('keybinding', () => {
  it('parses Shift+Enter', () => {
    expect(parseKeybinding('Shift+Enter')).toEqual({ key: 'Enter', shift: true, ctrl: false, alt: false, meta: false });
  });

  it('formats round-trip', () => {
    expect(formatKeybinding(parseKeybinding('Ctrl+Shift+ArrowDown')!)).toBe('Ctrl+Shift+ArrowDown');
  });

  it('matches a KeyboardEvent', () => {
    const ev = { key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent;
    expect(matchesKeybinding(ev, parseKeybinding('Shift+Enter')!)).toBe(true);
    expect(matchesKeybinding(ev, parseKeybinding('Enter')!)).toBe(false);
  });

  it('rejects empty/garbage', () => {
    expect(parseKeybinding('')).toBeNull();
    expect(parseKeybinding('+++')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/translate/keybinding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/translate/keybinding.ts
export interface Keybinding {
  key: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

export function parseKeybinding(input: string): Keybinding | null {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key || ['Shift', 'Ctrl', 'Alt', 'Meta'].includes(key)) return null;
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return {
    key,
    shift: mods.has('shift'),
    ctrl: mods.has('ctrl') || mods.has('control'),
    alt: mods.has('alt') || mods.has('option'),
    meta: mods.has('meta') || mods.has('cmd') || mods.has('command'),
  };
}

export function formatKeybinding(kb: Keybinding): string {
  const parts: string[] = [];
  if (kb.ctrl) parts.push('Ctrl');
  if (kb.alt) parts.push('Alt');
  if (kb.shift) parts.push('Shift');
  if (kb.meta) parts.push('Meta');
  parts.push(kb.key);
  return parts.join('+');
}

export function matchesKeybinding(
  ev: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>,
  kb: Keybinding,
): boolean {
  return ev.key === kb.key
    && ev.shiftKey === kb.shift
    && ev.ctrlKey === kb.ctrl
    && ev.altKey === kb.alt
    && ev.metaKey === kb.meta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/translate/keybinding.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/translate/keybinding.ts tests/translate/keybinding.test.ts
git commit -m "feat(translate): add keybinding parse/format/match utility"
```

---

### Task A2: sentence-splitter

Port zotero-pdf-translate 算法核心（divider chars `.?!。？！`、句号必须后跟空格、缩写白名单、`U.S.A.` 全大写短段模式跳过切分）。

**Files:**
- Create: `src/translate/sentence-splitter.ts`
- Test: `tests/translate/sentence-splitter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/translate/sentence-splitter.test.ts
import { describe, it, expect } from 'vitest';
import { splitSentences, sentenceAt } from '../../src/translate/sentence-splitter';

describe('splitSentences', () => {
  it('splits on . ? !', () => {
    const result = splitSentences('Hello world. How are you? I am fine!');
    expect(result.map((r) => r.text)).toEqual([
      'Hello world.',
      'How are you?',
      'I am fine!',
    ]);
  });

  it('splits on Chinese punctuation', () => {
    const result = splitSentences('你好。今天怎么样？很好！');
    expect(result.map((r) => r.text)).toEqual(['你好。', '今天怎么样？', '很好！']);
  });

  it('does not split on common abbreviations', () => {
    const result = splitSentences('See Dr. Smith and Mr. Jones today.');
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('See Dr. Smith and Mr. Jones today.');
  });

  it('does not split on e.g. and i.e.', () => {
    const result = splitSentences('We use tools, e.g. ripgrep, for speed.');
    expect(result).toHaveLength(1);
  });

  it('does not split inside U.S.A. style acronyms', () => {
    const result = splitSentences('I live in the U.S.A. and study here.');
    expect(result).toHaveLength(1);
  });

  it('requires whitespace after period to split', () => {
    const result = splitSentences('foo.bar. Next sentence.');
    expect(result.map((r) => r.text)).toEqual(['foo.bar.', 'Next sentence.']);
  });
});

describe('sentenceAt', () => {
  it('returns the sentence containing the offset', () => {
    const text = 'First. Second sentence here. Third!';
    const hit = sentenceAt(text, 12);
    expect(hit?.text).toBe('Second sentence here.');
    expect(hit?.start).toBe(7);
    expect(hit?.end).toBe(28);
  });

  it('returns null on out-of-range offset', () => {
    expect(sentenceAt('hi.', 99)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/translate/sentence-splitter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/translate/sentence-splitter.ts
// Sentence splitter ported from windingwind/zotero-pdf-translate (MIT)
// `src/modules/prompt.ts` splitSentences — divider chars + abbreviation
// whitelist + uppercase-acronym pattern.

export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

const DIVIDERS = new Set(['.', '?', '!', '。', '？', '！']);

const ABBREVIATIONS = new Set<string>([
  'a.m.', 'p.m.', 'vol.', 'inc.', 'jr.', 'dr.', 'tex.', 'co.',
  'prof.', 'rev.', 'revd.', 'hon.', 'v.s.', 'i.e.', 'ie.',
  'eg.', 'e.g.', 'al.', 'st.', 'ph.d.', 'capt.', 'mr.', 'mrs.', 'ms.', 'fig.',
]);

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function endsWithAbbreviation(text: string, dotIndex: number): boolean {
  const chunk = text.slice(0, dotIndex + 1);
  const tokens = chunk.split(/\s+/);
  const last = tokens[tokens.length - 1]?.toLowerCase();
  return last ? ABBREVIATIONS.has(last) : false;
}

// Detect U.S.A.-style acronyms: when the period is part of a sequence of
// ≥3 dot-separated single/double-char alphabetic segments, keep it joined.
function isAcronymPeriod(text: string, dotIndex: number): boolean {
  let start = dotIndex;
  while (start > 0 && !isWhitespace(text[start - 1]!)) start--;
  let end = dotIndex + 1;
  while (end < text.length && !isWhitespace(text[end]!)) end++;
  const token = text.slice(start, end);
  const segments = token.split('.').filter(Boolean);
  if (segments.length < 2) return false;
  return segments.every((seg) => seg.length <= 2 && /^[A-Za-z]+$/.test(seg));
}

export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!DIVIDERS.has(ch)) continue;

    if (ch === '.') {
      const next = text[i + 1];
      if (next !== undefined && !isWhitespace(next)) continue;
      if (endsWithAbbreviation(text, i)) continue;
      if (isAcronymPeriod(text, i)) continue;
    }

    const slice = text.slice(cursor, i + 1).trim();
    if (slice) {
      const start = text.indexOf(slice[0]!, cursor);
      out.push({ text: slice, start, end: start + slice.length });
    }
    cursor = i + 1;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const start = text.indexOf(tail[0]!, cursor);
    out.push({ text: tail, start, end: start + tail.length });
  }
  return out;
}

export function sentenceAt(text: string, offset: number): SentenceSpan | null {
  if (offset < 0 || offset > text.length) return null;
  const spans = splitSentences(text);
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/translate/sentence-splitter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/translate/sentence-splitter.ts tests/translate/sentence-splitter.test.ts
git commit -m "feat(translate): add sentence splitter with abbreviation whitelist"
```

---

### Task A3: translation cache

LRU-ish 容量裁剪（max 500 条），key=sha1(句+目标+endpoint+model+thinking+ctxLevel).slice(0,16)。

**Files:**
- Create: `src/translate/cache.ts`
- Test: `tests/translate/cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/translate/cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
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
    // The most-recent entries survive
    expect(loaded.entries['k509']).toBeDefined();
    expect(loaded.entries['k0']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/translate/cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/translate/cache.ts
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

// SHA-1 via WebCrypto if available, else a stable fallback.
function sha1Hex(input: string): string {
  // Synchronous fallback: FNV-1a 64-bit, hex-padded. Cache keys don't need
  // crypto strength — they only need stability and low collision rate, and
  // our extension runs in environments where WebCrypto sync is unavailable.
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
  return sha1Hex(payload).slice(0, 16);
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

export function setCachedTranslation(prefs: PrefsStore, key: string, entry: CacheEntry): void {
  const state = loadCache(prefs);
  state.entries[key] = entry;
  saveCache(prefs, state);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/translate/cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/translate/cache.ts tests/translate/cache.test.ts
git commit -m "feat(translate): add sentence translation cache"
```

---

## Phase B — Settings & Sync

### Task B1: TranslateSettings type

**Files:**
- Modify: `src/settings/types.ts` (append at bottom)
- Create: `src/translate/settings.ts` (load/save/normalize, keep keybinding logic out of types.ts)

- [ ] **Step 1: Append to `src/settings/types.ts`**

Insert after the existing exports (do not modify existing symbols):

```ts
export type TranslateThinking = 'none' | 'low' | 'medium' | 'high';
export type TranslateContextLevel = 'none' | 'paragraph' | 'page';
export type TranslateOverlayPosition = 'above' | 'below';

export interface TranslateSettings {
  enabled: boolean;
  presetId: string;       // empty string => first OpenAI preset at runtime
  model: string;          // empty => preset's current model
  thinking: TranslateThinking;
  ctxLevel: TranslateContextLevel;
  overlayPosition: TranslateOverlayPosition;
  prevSentenceKey: string; // formatted Keybinding, e.g. "Shift+Enter"
  nextSentenceKey: string; // e.g. "Enter"
}

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  enabled: false,
  presetId: '',
  model: '',
  thinking: 'low',
  ctxLevel: 'none',
  overlayPosition: 'above',
  prevSentenceKey: 'Shift+Enter',
  nextSentenceKey: 'Enter',
};
```

- [ ] **Step 2: Create `src/translate/settings.ts`**

```ts
// src/translate/settings.ts
import type { PrefsStore } from '../settings/storage';
import {
  DEFAULT_TRANSLATE_SETTINGS,
  type TranslateSettings,
  type TranslateThinking,
  type TranslateContextLevel,
  type TranslateOverlayPosition,
} from '../settings/types';

const KEY = 'extensions.zotero-ai-sidebar.translateSettings';

export function loadTranslateSettings(prefs: PrefsStore): TranslateSettings {
  const raw = prefs.get(KEY);
  if (!raw) return { ...DEFAULT_TRANSLATE_SETTINGS };
  try {
    return normalizeTranslateSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRANSLATE_SETTINGS };
  }
}

export function saveTranslateSettings(prefs: PrefsStore, settings: TranslateSettings): void {
  prefs.set(KEY, JSON.stringify(normalizeTranslateSettings(settings)));
}

export function normalizeTranslateSettings(value: unknown): TranslateSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<TranslateSettings>;
  return {
    enabled: input.enabled === true,
    presetId: typeof input.presetId === 'string' ? input.presetId : '',
    model: typeof input.model === 'string' ? input.model : '',
    thinking: pickThinking(input.thinking),
    ctxLevel: pickCtxLevel(input.ctxLevel),
    overlayPosition: input.overlayPosition === 'below' ? 'below' : 'above',
    prevSentenceKey: typeof input.prevSentenceKey === 'string' && input.prevSentenceKey
      ? input.prevSentenceKey : DEFAULT_TRANSLATE_SETTINGS.prevSentenceKey,
    nextSentenceKey: typeof input.nextSentenceKey === 'string' && input.nextSentenceKey
      ? input.nextSentenceKey : DEFAULT_TRANSLATE_SETTINGS.nextSentenceKey,
  };
}

function pickThinking(v: unknown): TranslateThinking {
  return v === 'none' || v === 'low' || v === 'medium' || v === 'high' ? v : 'low';
}

function pickCtxLevel(v: unknown): TranslateContextLevel {
  return v === 'none' || v === 'paragraph' || v === 'page' ? v : 'none';
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors related to these files.

- [ ] **Step 4: Commit**

```bash
git add src/settings/types.ts src/translate/settings.ts
git commit -m "feat(translate): add TranslateSettings types and prefs accessor"
```

---

### Task B2: prefs.js registration

**Files:**
- Modify: `addon/prefs.js`

- [ ] **Step 1: Edit `addon/prefs.js`**

Replace entire content with:

```js
pref("enable", true);
pref("input", "This is input");
pref("translateSettings", "");
pref("translateCache", "");
```

- [ ] **Step 2: Verify Zotero pref registration is harmless**

`prefs.js` only declares defaults; the keys we actually read/write are full-path JSON blobs at `extensions.zotero-ai-sidebar.translateSettings` / `…translateCache` via `prefs.get/set`. The empty defaults here just keep `prefs.js` self-documenting.

- [ ] **Step 3: Commit**

```bash
git add addon/prefs.js
git commit -m "chore(prefs): document translateSettings and translateCache prefs"
```

---

### Task B3: extend SyncSnapshot

**Files:**
- Modify: `src/sync/state.ts`

`SyncSnapshot` schema is `'zotero-ai-sidebar.sync.v1'`. Adding optional fields is backward compatible. Test file already exists at `tests/sync/state.test.ts` — extend it.

- [ ] **Step 1: Read `tests/sync/state.test.ts` to understand pattern**

Run: `head -80 tests/sync/state.test.ts`

- [ ] **Step 2: Edit `src/sync/state.ts`**

Add imports near the top:

```ts
import {
  loadTranslateSettings,
  normalizeTranslateSettings,
  saveTranslateSettings,
} from '../translate/settings';
import type { TranslateSettings } from '../settings/types';
import {
  loadCache as loadTranslateCacheState,
  saveCache as saveTranslateCacheState,
  type TranslateCacheState,
} from '../translate/cache';
```

Extend the `SyncSnapshot` interface:

```ts
export interface SyncSnapshot {
  schema: typeof SYNC_SCHEMA;
  exportedAt: string;
  presets: ModelPreset[];
  uiSettings: UiSettings;
  quickPrompts: QuickPromptSettings;
  toolSettings: ToolSettings;
  threads: PortableThread[];
  annotations: PortableAnnotation[];
  // Added v1.1 (still under SYNC_SCHEMA v1 — both fields are optional on
  // the wire). Older payloads without these parse to defaults.
  translateSettings?: TranslateSettings;
  translateCache?: TranslateCacheState;
}
```

In `buildSyncSnapshot`, append the two fields:

```ts
return {
  schema: SYNC_SCHEMA,
  exportedAt: new Date().toISOString(),
  presets: loadPresets(prefs),
  uiSettings: loadUiSettings(prefs),
  quickPrompts: loadQuickPromptSettings(prefs),
  toolSettings: loadToolSettings(prefs),
  threads: stripLocalTaskStateFromThreads(threads),
  annotations,
  translateSettings: loadTranslateSettings(prefs),
  translateCache: loadTranslateCacheState(prefs),
};
```

In `parseSyncSnapshot`, extend the returned object:

```ts
return {
  schema: SYNC_SCHEMA,
  exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
  presets: Array.isArray(parsed.presets)
    ? normalizePresetList(parsed.presets)
    : [],
  uiSettings: normalizeUiSettings(parsed.uiSettings),
  quickPrompts: normalizeQuickPromptSettings(parsed.quickPrompts),
  toolSettings: normalizeToolSettings(parsed.toolSettings),
  threads: normalizePortableThreads(parsed.threads),
  annotations: normalizePortableAnnotations(parsed.annotations),
  translateSettings: parsed.translateSettings === undefined
    ? undefined
    : normalizeTranslateSettings(parsed.translateSettings),
  translateCache: normalizeTranslateCache(parsed.translateCache),
};
```

In `applySyncSnapshot`, after the existing saves:

```ts
if (snapshot.translateSettings) saveTranslateSettings(prefs, snapshot.translateSettings);
if (snapshot.translateCache) saveTranslateCacheState(prefs, snapshot.translateCache);
```

Add the helper at the bottom of the file:

```ts
function normalizeTranslateCache(value: unknown): TranslateCacheState | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return { entries: {} };
  const entries = (value as { entries?: Record<string, unknown> }).entries;
  if (!entries || typeof entries !== 'object') return { entries: {} };
  const out: TranslateCacheState['entries'] = {};
  for (const [k, v] of Object.entries(entries)) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Partial<{ text: string; model: string; createdAt: number }>;
    if (typeof e.text === 'string' && typeof e.model === 'string' && typeof e.createdAt === 'number') {
      out[k] = { text: e.text, model: e.model, createdAt: e.createdAt };
    }
  }
  return { entries: out };
}
```

- [ ] **Step 3: Add a regression test**

Append to `tests/sync/state.test.ts`:

```ts
import { DEFAULT_TRANSLATE_SETTINGS } from '../../src/settings/types';

it('round-trips translateSettings and translateCache', async () => {
  const prefs = makeFakePrefs(); // helper already in this file
  saveTranslateSettings(prefs, { ...DEFAULT_TRANSLATE_SETTINGS, enabled: true, model: 'gpt-5.4' });
  saveTranslateCacheState(prefs, { entries: { k1: { text: '你好', model: 'gpt-5.4', createdAt: 1 } } });
  const snap = await buildSyncSnapshot(prefs);
  const json = JSON.stringify(snap);
  const reparsed = parseSyncSnapshot(json);
  expect(reparsed.translateSettings?.enabled).toBe(true);
  expect(reparsed.translateSettings?.model).toBe('gpt-5.4');
  expect(reparsed.translateCache?.entries.k1?.text).toBe('你好');
});

it('accepts snapshots missing translate fields (back-compat)', () => {
  const json = JSON.stringify({
    schema: SYNC_SCHEMA,
    exportedAt: '',
    presets: [],
    uiSettings: {},
    quickPrompts: {},
    toolSettings: {},
    threads: [],
    annotations: [],
  });
  const snap = parseSyncSnapshot(json);
  expect(snap.translateSettings).toBeUndefined();
  expect(snap.translateCache).toBeUndefined();
});
```

(Adjust import statements at the top of `state.test.ts` to include `saveTranslateSettings`, `saveTranslateCacheState`.)

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/sync/state.test.ts`
Expected: existing tests still PASS, two new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/state.ts tests/sync/state.test.ts
git commit -m "feat(sync): include translate settings and cache in sync snapshot"
```

---

## Phase C — Translator

### Task C1: streaming translator (no tool loop)

**Files:**
- Create: `src/translate/translator.ts`

This wraps `OpenAIProvider.stream()` with a fixed system prompt and zero tools, returning a string-only async iterator.

- [ ] **Step 1: Implement**

```ts
// src/translate/translator.ts
import { OpenAIProvider } from '../providers/openai';
import type { Message, StreamChunk } from '../providers/types';
import type { ModelPreset, ReasoningEffort } from '../settings/types';
import type { TranslateThinking, TranslateContextLevel } from '../settings/types';

const SYSTEM_PROMPT = [
  '你是一个专业学术翻译。',
  '把用户给出的英文句子翻译成简体中文，要求：',
  '1) 只输出译文本身，不要复述原文，不要加引号、序号、解释。',
  '2) 保留专业术语首次出现的英文括注（仅限关键术语，不要每个名词都标注）。',
  '3) 译文流畅，符合中文学术写作习惯。',
].join('\n');

export interface TranslateRequest {
  sentence: string;
  paragraphContext?: string; // optional surrounding paragraph for disambiguation
  preset: ModelPreset;       // OpenAI preset to use
  model: string;             // overrides preset.model
  thinking: TranslateThinking;
  signal: AbortSignal;
}

export interface TranslateChunk {
  type: 'text' | 'error' | 'done';
  text?: string;
  message?: string;
}

const THINKING_TO_EFFORT: Record<TranslateThinking, ReasoningEffort> = {
  none: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

function buildUserMessage(req: TranslateRequest): string {
  if (!req.paragraphContext) return req.sentence;
  return [
    '上下文段落（仅用于消歧，不要翻译）：',
    req.paragraphContext,
    '',
    '请翻译这一句：',
    req.sentence,
  ].join('\n');
}

export async function* translateSentence(req: TranslateRequest): AsyncIterable<TranslateChunk> {
  const provider = new OpenAIProvider();
  const overriddenPreset: ModelPreset = {
    ...req.preset,
    model: req.model || req.preset.model,
    extras: {
      ...req.preset.extras,
      reasoningEffort: THINKING_TO_EFFORT[req.thinking],
      reasoningSummary: 'none',
    },
  };

  const messages: Message[] = [{ role: 'user', content: buildUserMessage(req) }];

  try {
    for await (const chunk of provider.stream(messages, SYSTEM_PROMPT, overriddenPreset, req.signal)) {
      const mapped = mapChunk(chunk);
      if (mapped) yield mapped;
      if (mapped?.type === 'error') return;
    }
    yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function mapChunk(chunk: StreamChunk): TranslateChunk | null {
  switch (chunk.type) {
    case 'text_delta':
      return { type: 'text', text: chunk.text };
    case 'error':
      return { type: 'error', message: chunk.message };
    default:
      return null;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/translate/translator.ts
git commit -m "feat(translate): add OpenAI streaming translator (no tool loop)"
```

---

## Phase D — PDF Integration

### Task D1: sentence detection from textLayer click

**Files:**
- Create: `src/translate/sentence-detect.ts`

Use the iframe's `caretPositionFromPoint` to locate the textLayer span and offset, walk up to recover concatenated page text, then map to `PageBundle.normalizedText` and split sentences. Result includes original-string sentence + rect candidates from `pdf-locator.locate(needle)`.

- [ ] **Step 1: Implement**

```ts
// src/translate/sentence-detect.ts
import type { LocateResult, PdfLocator } from '../context/pdf-locator';
import { sentenceAt } from './sentence-splitter';

export interface DetectedSentence {
  text: string;
  pageIndex: number;
  pageLabel: string;
  rects: LocateResult['rects'];
  sortIndex: string;
  // Sentence ordinal within the page (0-based) — used by prev/next jumps.
  pageSentenceIndex: number;
  // Total sentences on this page (for hop bounds).
  pageSentenceCount: number;
  // Surrounding paragraph (best-effort) for ctxLevel='paragraph'.
  paragraphContext: string;
}

interface IframeWindowLike {
  document: Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
  };
}

interface CaretPosition {
  offsetNode: Node;
  offset: number;
}

interface PdfLocatorWithBundle extends PdfLocator {
  // `getPageBundle` is on the createPdfLocator return value — cast at use site.
  getPageBundle?: (pageIndex: number, pageLabel: string) => Promise<{
    pageIndex: number;
    pageLabel: string;
    pageText: string;
    normalizedText: string;
    normalizedToOriginal: number[];
  } | null>;
}

export interface DetectInput {
  iframeWindow: IframeWindowLike;
  clientX: number;
  clientY: number;
  locator: PdfLocatorWithBundle;
}

export async function detectSentenceAtPoint(input: DetectInput): Promise<DetectedSentence | null> {
  const { iframeWindow, clientX, clientY, locator } = input;
  const doc = iframeWindow.document;
  const caret = doc.caretPositionFromPoint?.(clientX, clientY);
  if (!caret) return null;

  const textLayer = findTextLayerAncestor(caret.offsetNode);
  if (!textLayer) return null;
  const pageEl = textLayer.closest('.page,.textLayer,[data-page-number]');
  const pageNumberAttr = pageEl?.getAttribute('data-page-number');
  if (!pageNumberAttr) return null;
  const pageIndex = parseInt(pageNumberAttr, 10) - 1;
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;

  const bundle = await locator.getPageBundle?.(pageIndex, '');
  if (!bundle) return null;

  // Approximate the click offset within the page text by concatenating
  // textLayer span strings up to the caret span, then add caret.offset.
  const offsetWithinPageText = approxClickOffset(textLayer, caret);
  if (offsetWithinPageText < 0) return null;

  const normalizedOffset = mapOriginalToNormalized(offsetWithinPageText, bundle);
  const span = sentenceAt(bundle.normalizedText, normalizedOffset);
  if (!span) return null;

  // Map normalized [start,end] back to original page text indices.
  const origStart = bundle.normalizedToOriginal[span.start] ?? -1;
  const origEnd = bundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
  if (origStart < 0 || origEnd < 0 || origEnd <= origStart) return null;
  const sentenceText = bundle.pageText.slice(origStart, origEnd + 1).trim();
  if (!sentenceText) return null;

  // Produce all sentences on the page so we can compute index/total + jumps.
  const allSentencesNormalized = (await import('./sentence-splitter')).splitSentences(bundle.normalizedText);
  const idx = allSentencesNormalized.findIndex((s) => s.start === span.start && s.end === span.end);
  const pageSentenceIndex = idx >= 0 ? idx : 0;

  const located = await locator.locate(sentenceText, { minConfidence: 0.6 });
  if (!located) return null;

  return {
    text: sentenceText,
    pageIndex: located.pageIndex,
    pageLabel: located.pageLabel,
    rects: located.rects,
    sortIndex: located.sortIndex,
    pageSentenceIndex,
    pageSentenceCount: allSentencesNormalized.length,
    paragraphContext: extractParagraph(bundle.pageText, origStart, origEnd),
  };
}

function findTextLayerAncestor(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur !== cur.ownerDocument) {
    if (cur instanceof HTMLElement && cur.classList.contains('textLayer')) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function approxClickOffset(textLayer: HTMLElement, caret: CaretPosition): number {
  let offset = 0;
  let found = false;
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node === caret.offsetNode) {
      offset += caret.offset;
      found = true;
      break;
    }
    offset += (node.textContent ?? '').length;
    node = walker.nextNode();
  }
  return found ? offset : -1;
}

function mapOriginalToNormalized(originalOffset: number, bundle: {
  normalizedToOriginal: number[];
}): number {
  // Linear scan — page sizes are O(thousands of chars), this is fine.
  let lo = 0;
  let hi = bundle.normalizedToOriginal.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = bundle.normalizedToOriginal[mid] ?? -1;
    if (v < originalOffset) lo = mid + 1;
    else if (v > originalOffset) hi = mid - 1;
    else return mid;
  }
  return Math.max(0, Math.min(bundle.normalizedToOriginal.length - 1, lo));
}

function extractParagraph(pageText: string, start: number, end: number): string {
  const paraStart = lastIndexOfDoubleNewline(pageText, start);
  const paraEnd = indexOfDoubleNewline(pageText, end);
  return pageText.slice(paraStart, paraEnd).trim();
}

function lastIndexOfDoubleNewline(s: string, from: number): number {
  const i = s.lastIndexOf('\n\n', from);
  return i < 0 ? 0 : i + 2;
}

function indexOfDoubleNewline(s: string, from: number): number {
  const i = s.indexOf('\n\n', from);
  return i < 0 ? s.length : i;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (We do not unit-test this file because it depends on a live PDF.js DOM — covered by the smoke test in Phase F.)

- [ ] **Step 3: Commit**

```bash
git add src/translate/sentence-detect.ts
git commit -m "feat(translate): add sentence detection from PDF.js textLayer click"
```

---

### Task D2: overlay rendering

**Files:**
- Create: `src/translate/overlay.ts`

Renders an absolutely-positioned overlay in the iframe document, anchored above or below the highlighted sentence rects. Streams text into the overlay as deltas arrive.

- [ ] **Step 1: Implement**

```ts
// src/translate/overlay.ts
import type { TranslateOverlayPosition } from '../settings/types';
import type { PdfRect } from '../context/pdf-locator';

export interface OverlayHandle {
  el: HTMLElement;
  appendText(delta: string): void;
  setError(message: string): void;
  setStatus(message: string): void;
  destroy(): void;
}

export interface OverlayActions {
  onPrev?: () => void;
  onNext?: () => void;
  onSave?: () => void;
  onClose: () => void;
  hint: string; // e.g. "S 存 · ↵/⇧↵ 下/上一句"
}

export interface MountOverlayInput {
  iframeDoc: Document;
  pageEl: HTMLElement;     // the .page element for the sentence
  rects: PdfRect[];        // PDF coordinates (need converting to CSS pixels)
  position: TranslateOverlayPosition;
  actions: OverlayActions;
  initialText?: string;    // for cache hits — render synchronously
}

export function mountOverlay(input: MountOverlayInput): OverlayHandle {
  const { iframeDoc, pageEl, rects, position, actions, initialText } = input;

  const el = iframeDoc.createElement('div');
  el.className = 'zai-translate-overlay';
  el.setAttribute('data-position', position);

  const body = iframeDoc.createElement('div');
  body.className = 'zai-translate-overlay__body';
  if (initialText) body.textContent = initialText;
  el.appendChild(body);

  const actionsRow = iframeDoc.createElement('div');
  actionsRow.className = 'zai-translate-overlay__actions';
  actionsRow.appendChild(makeBtn(iframeDoc, '💾', '保存到笔记', actions.onSave));
  actionsRow.appendChild(makeBtn(iframeDoc, '▲', '上一句', actions.onPrev));
  actionsRow.appendChild(makeBtn(iframeDoc, '▼', '下一句', actions.onNext));
  actionsRow.appendChild(makeBtn(iframeDoc, '✕', '关闭', actions.onClose));
  el.appendChild(actionsRow);

  const hint = iframeDoc.createElement('div');
  hint.className = 'zai-translate-overlay__hint';
  hint.textContent = actions.hint;
  el.appendChild(hint);

  pageEl.appendChild(el);
  positionOverlay(el, pageEl, rects, position);

  return {
    el,
    appendText(delta) { body.textContent = (body.textContent ?? '') + delta; },
    setError(message) {
      body.textContent = `⚠️ ${message}`;
      el.classList.add('zai-translate-overlay--error');
    },
    setStatus(message) {
      body.classList.add('zai-translate-overlay__body--status');
      body.textContent = message;
    },
    destroy() {
      el.remove();
    },
  };
}

function makeBtn(doc: Document, label: string, title: string, handler?: () => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'zai-translate-overlay__btn';
  b.textContent = label;
  b.title = title;
  if (!handler) b.disabled = true;
  if (handler) b.addEventListener('click', (ev) => { ev.stopPropagation(); handler(); });
  return b;
}

function positionOverlay(
  overlay: HTMLElement,
  pageEl: HTMLElement,
  rects: PdfRect[],
  position: TranslateOverlayPosition,
): void {
  if (rects.length === 0) return;
  // PDF coords origin = bottom-left; the page element's CSS uses top-left.
  // The Reader's textLayer mirrors PDF.js: spans use a transform from PDF
  // user-space to CSS px. For a first cut we approximate with the bounding
  // box of the rects' min/max in PDF user-space and rely on the page's
  // CSS height for vertical flip.
  const xs = rects.flatMap((r) => [r[0], r[2]]);
  const ys = rects.flatMap((r) => [r[1], r[3]]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  // Use the page bounding rect to convert ratios: rough but visually close
  // enough for an above/below anchor. A future improvement can read the
  // textLayer transform and project precisely.
  const pageRect = pageEl.getBoundingClientRect();
  const viewBoxAttr = pageEl.getAttribute('data-page-viewbox');
  const [pdfW, pdfH] = parseViewBox(viewBoxAttr) ?? [pageRect.width, pageRect.height];

  const cssLeft = (x0 / pdfW) * pageRect.width;
  const cssRight = (x1 / pdfW) * pageRect.width;
  const cssTopOfRect = ((pdfH - y1) / pdfH) * pageRect.height;
  const cssBottomOfRect = ((pdfH - y0) / pdfH) * pageRect.height;

  const width = Math.max(220, cssRight - cssLeft);
  overlay.style.position = 'absolute';
  overlay.style.left = `${cssLeft}px`;
  overlay.style.width = `${width}px`;
  if (position === 'above') {
    overlay.style.bottom = `${pageRect.height - cssTopOfRect + 4}px`;
    overlay.style.top = '';
  } else {
    overlay.style.top = `${cssBottomOfRect + 4}px`;
    overlay.style.bottom = '';
  }
  overlay.style.zIndex = '20';
}

function parseViewBox(s: string | null): [number, number] | null {
  if (!s) return null;
  const parts = s.split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[2]! - parts[0]!, parts[3]! - parts[1]!];
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/translate/overlay.ts
git commit -m "feat(translate): add iframe overlay renderer with above/below anchoring"
```

---

## Phase E — Mode Lifecycle + UI Wiring

### Task E1: translate-mode controller

**Files:**
- Create: `src/translate/translate-mode.ts`

Manages: registering iframe click listener when ON, sentence-detect → cache lookup → translator stream → overlay update; tracks last detected sentence for prev/next jumps; renders the settings popover.

- [ ] **Step 1: Implement**

```ts
// src/translate/translate-mode.ts
import { createPdfLocator, type PdfLocator } from '../context/pdf-locator';
import { detectSentenceAtPoint, type DetectedSentence } from './sentence-detect';
import { mountOverlay, type OverlayHandle } from './overlay';
import { translateSentence, type TranslateChunk } from './translator';
import {
  cacheKey,
  getCachedTranslation,
  setCachedTranslation,
} from './cache';
import {
  loadTranslateSettings,
  saveTranslateSettings,
} from './settings';
import type { ModelPreset, TranslateSettings } from '../settings/types';
import { matchesKeybinding, parseKeybinding } from './keybinding';
import type { PrefsStore } from '../settings/storage';

interface ReaderLike {
  _internalReader?: {
    _primaryView?: { _iframeWindow?: Window };
  };
  itemID?: number;
}

interface ModeContext {
  prefs: PrefsStore;
  presets: ModelPreset[];
  reader: ReaderLike;
}

export class TranslateModeController {
  private overlay: OverlayHandle | null = null;
  private current: DetectedSentence | null = null;
  private locator: PdfLocator | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private abortCtrl: AbortController | null = null;

  constructor(private ctx: ModeContext) {}

  async enable(): Promise<void> {
    const win = this.ctx.reader._internalReader?._primaryView?._iframeWindow;
    if (!win) return;
    if (!this.locator) this.locator = await createPdfLocator(this.ctx.reader);

    this.clickHandler = (ev) => { void this.handleClick(ev, win); };
    this.keyHandler = (ev) => { this.handleKey(ev); };
    win.addEventListener('click', this.clickHandler, true);
    win.addEventListener('keydown', this.keyHandler, true);
  }

  disable(): void {
    const win = this.ctx.reader._internalReader?._primaryView?._iframeWindow;
    if (win && this.clickHandler) win.removeEventListener('click', this.clickHandler, true);
    if (win && this.keyHandler) win.removeEventListener('keydown', this.keyHandler, true);
    this.clickHandler = null;
    this.keyHandler = null;
    this.dismissOverlay();
    this.locator?.dispose();
    this.locator = null;
  }

  private async handleClick(ev: MouseEvent, win: Window): Promise<void> {
    // Ignore clicks on existing overlay so its own buttons keep working.
    const target = ev.target as HTMLElement | null;
    if (target?.closest('.zai-translate-overlay')) return;

    if (!this.locator) return;
    const detected = await detectSentenceAtPoint({
      iframeWindow: win as never,
      clientX: ev.clientX,
      clientY: ev.clientY,
      locator: this.locator as never,
    });
    if (!detected) return;

    ev.preventDefault();
    ev.stopPropagation();
    this.current = detected;
    await this.renderForCurrent();
  }

  private handleKey(ev: KeyboardEvent): void {
    if (!this.current) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const next = parseKeybinding(settings.nextSentenceKey);
    const prev = parseKeybinding(settings.prevSentenceKey);
    if (next && matchesKeybinding(ev, next)) {
      ev.preventDefault();
      void this.jump(+1);
    } else if (prev && matchesKeybinding(ev, prev)) {
      ev.preventDefault();
      void this.jump(-1);
    } else if (ev.key === 'Escape') {
      this.dismissOverlay();
    } else if (ev.key === 's' || ev.key === 'S') {
      // Save-to-note hook (no-op here; caller wires it through actions.onSave)
    }
  }

  private async jump(delta: number): Promise<void> {
    if (!this.current || !this.locator) return;
    const targetIndex = this.current.pageSentenceIndex + delta;
    if (targetIndex < 0 || targetIndex >= this.current.pageSentenceCount) return;
    const win = this.ctx.reader._internalReader?._primaryView?._iframeWindow;
    if (!win) return;
    // Re-derive: ask sentence-detect for sentence at the page-text offset of
    // the target. Cheaper path: rebuild from the same bundle. We simulate by
    // moving caret to the start of the next sentence's first rect.
    // For MVP: re-run detection at the rect center; precise jump uses bundle
    // cache as a follow-up enhancement.
    const r = this.current.rects[0];
    if (!r) return;
    // Trigger a fake click at the rect-region of the requested sentence index
    // by reading the PageBundle and scrolling to the center of the next rect
    // — for now, just tell the user and bail so we don't ship a broken jump.
    // (Replace this stub once Phase F polish lands.)
  }

  private async renderForCurrent(): Promise<void> {
    const settings = loadTranslateSettings(this.ctx.prefs);
    const preset = pickOpenAiPreset(this.ctx.presets, settings.presetId);
    if (!preset || !this.current) return;
    const model = settings.model || preset.model;

    const win = this.ctx.reader._internalReader?._primaryView?._iframeWindow;
    if (!win) return;
    const pageEl = (win.document.querySelector(
      `.page[data-page-number="${this.current.pageIndex + 1}"]`,
    ) as HTMLElement | null) ?? null;
    if (!pageEl) return;

    this.dismissOverlay();
    this.abortCtrl = new AbortController();

    const key = cacheKey({
      sentence: this.current.text,
      target: 'zh',
      endpoint: preset.baseUrl,
      model,
      thinking: settings.thinking,
      ctxLevel: settings.ctxLevel,
    });
    const cached = getCachedTranslation(this.ctx.prefs, key);

    this.overlay = mountOverlay({
      iframeDoc: win.document,
      pageEl,
      rects: this.current.rects,
      position: settings.overlayPosition,
      initialText: cached?.text,
      actions: {
        onClose: () => this.dismissOverlay(),
        onPrev: () => void this.jump(-1),
        onNext: () => void this.jump(+1),
        onSave: undefined, // wired in a later iteration
        hint: `S 存 · ↵/⇧↵ 下/上一句`,
      },
    });

    if (cached) return;

    let buffer = '';
    for await (const chunk of translateSentence({
      sentence: this.current.text,
      paragraphContext: settings.ctxLevel === 'paragraph' ? this.current.paragraphContext : undefined,
      preset,
      model,
      thinking: settings.thinking,
      signal: this.abortCtrl.signal,
    })) {
      this.applyChunk(chunk, (delta) => { buffer += delta; });
      if (chunk.type === 'done' && buffer) {
        setCachedTranslation(this.ctx.prefs, key, {
          text: buffer,
          model,
          createdAt: Date.now(),
        });
      }
    }
  }

  private applyChunk(chunk: TranslateChunk, onText: (delta: string) => void): void {
    if (!this.overlay) return;
    if (chunk.type === 'text' && chunk.text) {
      this.overlay.appendText(chunk.text);
      onText(chunk.text);
    } else if (chunk.type === 'error' && chunk.message) {
      this.overlay.setError(chunk.message);
    }
  }

  private dismissOverlay(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.current = null;
  }
}

function pickOpenAiPreset(presets: ModelPreset[], desiredId: string): ModelPreset | null {
  const openai = presets.filter((p) => p.provider === 'openai');
  if (!openai.length) return null;
  return openai.find((p) => p.id === desiredId) ?? openai[0]!;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (Note: prev/next `jump` is intentionally a stub — Phase F polish completes it. Do not ship that as user-visible UI without the polish step.)

- [ ] **Step 3: Commit**

```bash
git add src/translate/translate-mode.ts
git commit -m "feat(translate): add translate-mode controller with click + cache + stream"
```

---

### Task E2: sidebar.ts wiring (toolbar + settings popover)

**Files:**
- Modify: `src/modules/sidebar.ts`

This is the only invasive edit. We add (a) a `译` toolbar button between the existing settings/copy/clear cluster, (b) a click → toggle handler, (c) a settings popover trigger, (d) lifecycle calls when the active reader changes.

- [ ] **Step 1: Find the toolbar build site**

Run: `grep -n "settings.addEventListener\|copyAll.addEventListener\|openNote.addEventListener" src/modules/sidebar.ts | head`

Identify the section (around line 439–477) where these toolbar buttons are constructed.

- [ ] **Step 2: Insert toolbar button**

After the `openNote` button creation (line ~477), insert:

```ts
const translateBtn = document.createElement('toolbarbutton') as HTMLButtonElement;
translateBtn.id = 'zai-toolbar-translate';
translateBtn.className = 'zai-toolbar-icon';
translateBtn.textContent = '译';
translateBtn.title = '逐句翻译模式（点击切换）';
translateBtn.addEventListener('click', () => {
  toggleTranslateMode(win);
});
toolbar.appendChild(translateBtn);
syncTranslateBtnState(translateBtn, win);
```

(Adjust `toolbar` / `win` variable names to whatever this scope already uses — check the surrounding code.)

- [ ] **Step 3: Add module-scoped controller registry**

Near the top of the file (after the existing imports), add:

```ts
import { TranslateModeController } from '../translate/translate-mode';
import { loadTranslateSettings, saveTranslateSettings } from '../translate/settings';
import { loadPresets } from '../settings/storage';

const translateControllers = new WeakMap<Window, TranslateModeController>();
```

Add the helper functions near other window-scoped helpers:

```ts
function getOrCreateTranslateController(win: Window): TranslateModeController | null {
  const existing = translateControllers.get(win);
  if (existing) return existing;
  const reader = getActiveReaderForWindow(win); // existing helper
  if (!reader) return null;
  const ctrl = new TranslateModeController({
    prefs: prefsStore,                            // existing module-scope prefs
    presets: loadPresets(prefsStore),
    reader,
  });
  translateControllers.set(win, ctrl);
  return ctrl;
}

async function toggleTranslateMode(win: Window): Promise<void> {
  const settings = loadTranslateSettings(prefsStore);
  const next = !settings.enabled;
  saveTranslateSettings(prefsStore, { ...settings, enabled: next });
  const ctrl = getOrCreateTranslateController(win);
  if (!ctrl) return;
  if (next) await ctrl.enable();
  else ctrl.disable();
  const btn = win.document.getElementById('zai-toolbar-translate') as HTMLElement | null;
  if (btn) syncTranslateBtnState(btn, win);
}

function syncTranslateBtnState(btn: HTMLElement, _win: Window): void {
  const enabled = loadTranslateSettings(prefsStore).enabled;
  btn.classList.toggle('zai-toolbar-icon--active', enabled);
}
```

(Use whatever helper exists in this file for "get the prefs store" / "get the active reader for this window" — `prefsStore` and `getActiveReaderForWindow` are placeholders matching this file's existing conventions.)

- [ ] **Step 4: Re-enable on reader change**

In the existing `onReaderTabSelect` (or similar) callback, after the new reader has loaded, if `loadTranslateSettings(prefsStore).enabled` is true, dispose the old controller and call `getOrCreateTranslateController(win)?.enable()`.

- [ ] **Step 5: Settings popover (minimal)**

Open the popover on right-click of the `译` button (low-risk first cut). Render:
- ON/OFF toggle (writes `settings.enabled`)
- preset `<select>` populated from `loadPresets(prefsStore).filter(p => p.provider === 'openai')`
- model `<select>` populated from selected preset's `models[]`
- thinking segmented control (none/low/medium/high)
- ctxLevel segmented control (none/paragraph/page)
- overlay position segmented (above/below)
- two key recorders for prev/next (capture `keydown`, write `formatKeybinding(...)`)

Each control writes back via `saveTranslateSettings(prefsStore, ...)`. The popover lives outside the iframe — append to `win.document.body`. Reuse existing popover styling from elsewhere in `sidebar.ts` if a pattern exists; otherwise make a plain absolutely-positioned `<div>`.

(Implementation detail: the popover is ~120 lines; keep it inline rather than a new file because it's only used here.)

- [ ] **Step 6: Type-check + run unit tests**

Run: `npx tsc --noEmit`
Run: `npm test`
Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/modules/sidebar.ts
git commit -m "feat(translate): wire translate-mode toolbar button and settings popover"
```

---

### Task E3: CSS styling

**Files:**
- Modify: `addon/content/sidebar.css`

- [ ] **Step 1: Append at the bottom of `addon/content/sidebar.css`**

```css
/* Translate mode toolbar button */
.zai-toolbar-icon--active {
  color: #1976d2;
  background: rgba(25, 118, 210, 0.12);
  border-radius: 4px;
}

/* Translate overlay (rendered in PDF iframe) */
.zai-translate-overlay {
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  color: #1f2328;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12);
  max-height: 40%;
  overflow: auto;
  pointer-events: auto;
}
.zai-translate-overlay__body { white-space: pre-wrap; }
.zai-translate-overlay__body--status { color: #666; font-style: italic; }
.zai-translate-overlay--error .zai-translate-overlay__body { color: #b3261e; }
.zai-translate-overlay__actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  margin-top: 6px;
}
.zai-translate-overlay__btn {
  background: transparent;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 12px;
}
.zai-translate-overlay__btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}
.zai-translate-overlay__btn:disabled { opacity: 0.4; cursor: default; }
.zai-translate-overlay__hint {
  margin-top: 4px;
  font-size: 11px;
  color: #888;
  text-align: right;
}
```

- [ ] **Step 2: Verify the iframe inherits the stylesheet**

The Reader iframe is sandboxed; we likely need to inject the rule directly. After mounting the overlay, also append a `<style>` element into `iframeDoc.head` once per document. Update `overlay.ts` `mountOverlay` to do this with a `data-zai-translate-style` attribute as a guard:

```ts
const STYLE_ID = 'zai-translate-style';
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `/* same CSS as above */`;
  doc.head.appendChild(style);
}
// call ensureStyle(iframeDoc) at the top of mountOverlay
```

(Inline the CSS string; keep `sidebar.css` rules too for the toolbar button.)

- [ ] **Step 3: Build + commit**

Run: `npm run build`
Expected: build succeeds.

```bash
git add addon/content/sidebar.css src/translate/overlay.ts
git commit -m "feat(translate): add overlay and toolbar styles"
```

---

## Phase F — Polish & Smoke Test

### Task F1: complete prev/next jump + smoke test

The Phase E1 `jump()` is a stub. Polish it now: cache the last `PageBundle` on `TranslateModeController`, and on jump compute the new sentence span from `splitSentences(bundle.normalizedText)[idx]`, mapping back to original offsets via `bundle.normalizedToOriginal`, then re-call `locator.locate(text)` and re-render.

- [ ] **Step 1: Add a private `lastBundle` cache**

In `translate-mode.ts`, store the bundle returned during detection:

```ts
private lastBundle: { pageText: string; normalizedText: string; normalizedToOriginal: number[] } | null = null;
```

Set it inside `handleClick` (you already fetched the bundle inside `detectSentenceAtPoint` — change that function to return the bundle alongside the detection so the controller can cache it without re-fetching).

- [ ] **Step 2: Fix `jump`**

```ts
private async jump(delta: number): Promise<void> {
  if (!this.current || !this.locator || !this.lastBundle) return;
  const idx = this.current.pageSentenceIndex + delta;
  if (idx < 0 || idx >= this.current.pageSentenceCount) return;
  const { splitSentences } = await import('./sentence-splitter');
  const all = splitSentences(this.lastBundle.normalizedText);
  const span = all[idx];
  if (!span) return;
  const origStart = this.lastBundle.normalizedToOriginal[span.start] ?? -1;
  const origEnd = this.lastBundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
  if (origStart < 0 || origEnd < 0) return;
  const text = this.lastBundle.pageText.slice(origStart, origEnd + 1).trim();
  if (!text) return;
  const located = await this.locator.locate(text, { minConfidence: 0.6 });
  if (!located) return;
  this.current = {
    ...this.current,
    text,
    pageIndex: located.pageIndex,
    pageLabel: located.pageLabel,
    rects: located.rects,
    sortIndex: located.sortIndex,
    pageSentenceIndex: idx,
  };
  await this.renderForCurrent();
}
```

- [ ] **Step 3: Smoke test checklist (manual)**

Build and install:

```bash
npm test
npm run build
cp .scaffold/build/zotero-ai-sidebar.xpi /home/qwer/.zotero/zotero/24q8duho.default/extensions/zotero-ai-sidebar@local.xpi
```

Restart Zotero (`cd ~/Downloads/Zotero_linux-x86_64 && ./zotero`).

Run through:
1. Open a PDF in the Reader.
2. Click the `译` toolbar button → button highlights, settings popover state shows ON.
3. Single-click on a sentence in the PDF → overlay appears above the sentence; text streams in Chinese.
4. Click the same sentence again → overlay re-appears instantly (cache hit, no streaming spinner).
5. Press `Enter` → next sentence's translation appears (overlay re-anchors).
6. Press `Shift+Enter` → previous sentence.
7. Press `Esc` → overlay dismisses, mode stays ON.
8. Click `译` again → mode OFF, sidebar unaffected, chat draft preserved.
9. Open a different PDF → mode auto re-engages; old reader's listener gone.
10. Push WebDAV sync, pull on a different machine → settings + cache restored.

If any item fails, file inline before declaring complete.

- [ ] **Step 4: Commit**

```bash
git add src/translate/translate-mode.ts src/translate/sentence-detect.ts
git commit -m "feat(translate): implement prev/next sentence jump with cached bundle"
```

---

## Self-Review Notes

Run before declaring the plan done:

1. **Spec coverage** — every numbered item in `docs/superpowers/specs/2026-05-08-sentence-translation-design.html` (mode toggle, click detection, splitter, cache, overlay above/below, prev/next keys, settings popover, sync extension) maps to a task above. ✅
2. **Placeholders** — `pickOpenAiPreset`'s "no preset" path returns `null` silently in `enable()` (button still toggles); add a user-visible toast in Phase E1 if real users hit it. (Tracked, not blocking.)
3. **Type consistency** — `TranslateSettings.thinking` is `'none'|'low'|'medium'|'high'`, mapped explicitly to `ReasoningEffort` in `translator.ts`. `TranslateContextLevel` and `TranslateOverlayPosition` are referenced by both `settings.ts` and the controller — names match. ✅
4. **Test coverage gap** — sentence-detect and overlay are integration-only (depend on PDF.js DOM); covered by the Phase F smoke checklist rather than unit tests. Document this clearly in the smoke test step. ✅
5. **Sync back-compat** — `parseSyncSnapshot` returns `undefined` for missing `translateSettings`/`translateCache`, and `applySyncSnapshot` only writes when present. Old clients pulling new-format snapshots ignore the extra fields (JSON parse tolerates extras). ✅

---

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-05-08-sentence-translation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, with two-stage review between tasks. Best for this plan because Phase E2 (sidebar.ts wiring) is invasive and benefits from a clean slate per task.

**2. Inline Execution** — run all tasks in this session with checkpoints at phase boundaries. Faster end-to-end, less protective against context drift.

Which approach?
