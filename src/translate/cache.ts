export const CACHE_PREFS_KEY = "extensions.zotero-ai-sidebar.translateCache";
export const MAX_CACHE_ENTRIES = 500;
const FULL_TEXT_CACHE_MAX_SOURCE_CHARS = 900;
const FULL_TEXT_START_ANCHOR_CHARS = 12;
const FULL_TEXT_DIRECT_MATCH_MAX_EXTRA_CHARS = 40;
const FULL_TEXT_DIRECT_MATCH_MAX_EXTRA_RATIO = 0.15;

export interface CacheEntry {
  text: string;
  model: string;
  createdAt: number;
  sourceText?: string;
  target?: string;
  endpoint?: string;
  thinking?: string;
  ctxLevel?: string;
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

interface ParagraphCacheLookupInput {
  sentence: string;
  target: string;
  endpoint?: string;
  model?: string;
  thinking?: string;
  ctxLevel?: string;
  paragraphContext?: string;
  fullTextContext?: string;
}

interface DeleteCachedTranslationSourcesInput {
  sources: string[];
  target: string;
  endpoint: string;
  model: string;
  thinking: string;
  ctxLevels?: string[];
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
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function cacheKey(input: CacheKeyInput): string {
  const payload = [
    normalizeSentence(input.sentence),
    input.target,
    input.endpoint,
    input.model,
    input.thinking,
    input.ctxLevel,
  ].join("|");
  return fnv1aHex64(payload).slice(0, 16);
}

export function loadCache(prefs: PrefsStore): TranslateCacheState {
  const raw = prefs.get(CACHE_PREFS_KEY);
  if (!raw) return { entries: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { entries: {} };
    const entries = (parsed as { entries?: Record<string, unknown> }).entries;
    if (!entries || typeof entries !== "object") return { entries: {} };
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Partial<CacheEntry>;
      if (
        typeof e.text === "string" &&
        typeof e.model === "string" &&
        typeof e.createdAt === "number"
      ) {
        out[k] = {
          text: e.text,
          model: e.model,
          createdAt: e.createdAt,
          ...(typeof e.sourceText === "string"
            ? { sourceText: e.sourceText }
            : {}),
          ...(typeof e.target === "string" ? { target: e.target } : {}),
          ...(typeof e.endpoint === "string" ? { endpoint: e.endpoint } : {}),
          ...(typeof e.thinking === "string" ? { thinking: e.thinking } : {}),
          ...(typeof e.ctxLevel === "string" ? { ctxLevel: e.ctxLevel } : {}),
        };
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

export function deleteCachedTranslationsForSources(
  prefs: PrefsStore,
  input: DeleteCachedTranslationSourcesInput,
): number {
  const sources = uniqueNonEmpty(input.sources);
  if (!sources.length) return 0;

  const ctxLevels = input.ctxLevels?.length
    ? input.ctxLevels
    : ["full-text", "none", "paragraph", "page"];
  const sourceSet = new Set(sources.map(normalizeSentence));
  const state = loadCache(prefs);
  let deleted = 0;

  for (const source of sources) {
    for (const ctxLevel of ctxLevels) {
      const key = cacheKey({
        sentence: source,
        target: input.target,
        endpoint: input.endpoint,
        model: input.model,
        thinking: input.thinking,
        ctxLevel,
      });
      if (state.entries[key]) {
        delete state.entries[key];
        deleted++;
      }
    }
  }

  for (const [key, entry] of Object.entries(state.entries)) {
    const sourceText = entry.sourceText;
    if (!sourceText || !sourceSet.has(normalizeSentence(sourceText))) continue;
    delete state.entries[key];
    deleted++;
  }

  if (deleted > 0) saveCache(prefs, state);
  return deleted;
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

export function getCachedTranslation(
  prefs: PrefsStore,
  key: string,
): CacheEntry | undefined {
  return loadCache(prefs).entries[key];
}

export function getLooseCachedTranslation(
  prefs: PrefsStore,
  input: CacheKeyInput,
): CacheEntry | undefined {
  const state = loadCache(prefs);
  const exact = state.entries[cacheKey(input)];
  if (exact) return exact;

  const sourceLoose = normalizeForLooseMatch(input.sentence);
  if (sourceLoose.length < 20) return undefined;

  const matches: CacheEntry[] = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.target !== input.target) continue;
    if ((entry.endpoint ?? "") !== (input.endpoint ?? "")) continue;
    if (entry.model !== input.model) continue;
    if (entry.thinking !== input.thinking) continue;
    const entrySource = entry.sourceText ?? "";
    const entryLoose = normalizeForLooseMatch(entrySource);
    if (entryLoose.length < 20) continue;
    if (isSafeLooseCacheMatch(entryLoose, sourceLoose)) {
      matches.push(entry);
    }
  }
  if (!matches.length) return undefined;
  matches.sort((a, b) => {
    const aSameCtx = a.ctxLevel === input.ctxLevel ? 1 : 0;
    const bSameCtx = b.ctxLevel === input.ctxLevel ? 1 : 0;
    if (aSameCtx !== bSameCtx) return bSameCtx - aSameCtx;
    return b.createdAt - a.createdAt;
  });
  return matches[0];
}

export function getFullTextCachedTranslation(
  prefs: PrefsStore,
  input: CacheKeyInput & {
    paragraphContext?: string;
    fullTextContext?: string;
  },
): CacheEntry | undefined {
  const state = loadCache(prefs);
  const candidates = uniqueNonEmpty([input.sentence, input.paragraphContext]);
  for (const sentence of candidates) {
    const exact =
      state.entries[cacheKey({ ...input, sentence, ctxLevel: "full-text" })];
    if (exact) return exact;
  }
  const legacyChunkMatches = findLegacyFullTextChunkMatches(
    state,
    input,
    candidates,
    input.fullTextContext,
  );
  if (legacyChunkMatches.length === 1) return legacyChunkMatches[0]!.entry;
  if (legacyChunkMatches.length > 1)
    return combineFullTextMatches(legacyChunkMatches);

  const needles = candidates
    .map((candidate) => ({
      raw: candidate,
      loose: normalizeForLooseMatch(candidate),
    }))
    .filter((candidate) => candidate.loose.length >= 20);
  if (!needles.length) return undefined;

  const matches: Array<{
    entry: CacheEntry;
    sourceLoose: string;
    position: number;
  }> = [];
  for (const entry of Object.values(state.entries)) {
    if (entry.ctxLevel !== "full-text") continue;
    if (entry.target !== input.target) continue;
    if ((entry.endpoint ?? "") !== (input.endpoint ?? "")) continue;
    if (entry.model !== input.model) continue;
    if (entry.thinking !== input.thinking) continue;
    const sourceLoose = normalizeForLooseMatch(entry.sourceText ?? "");
    if (sourceLoose.length < 20) continue;
    const position = bestLooseMatchPosition(sourceLoose, needles);
    if (position < 0) continue;
    matches.push({
      entry,
      sourceLoose,
      position,
    });
  }
  if (!matches.length) return undefined;

  matches.sort((a, b) => {
    const byPosition = a.position - b.position;
    if (byPosition !== 0) return byPosition;
    return b.sourceLoose.length - a.sourceLoose.length;
  });
  const deduped = dedupeOverlappingMatches(matches);
  if (!hasStartAnchoredMatch(deduped)) return undefined;
  if (deduped.length === 1) return deduped[0]!.entry;
  return combineFullTextMatches(deduped, input);
}

export function getParagraphCachedTranslation(
  prefs: PrefsStore,
  input: ParagraphCacheLookupInput,
): CacheEntry | undefined {
  const keyedInput = completeCacheKeyInput(input);
  if (keyedInput) {
    const fullTextKey = cacheKey({ ...keyedInput, ctxLevel: "full-text" });
    const fullTextCached =
      getCachedTranslation(prefs, fullTextKey) ??
      getFullTextCachedTranslation(prefs, {
        ...keyedInput,
        paragraphContext: input.paragraphContext,
        fullTextContext: input.fullTextContext,
      });
    if (fullTextCached) return fullTextCached;
  }

  const broadFullText = findSourceMatchedCachedTranslation(prefs, input, {
    fullTextOnly: true,
  });
  if (broadFullText) return broadFullText;

  if (keyedInput) {
    const currentCached =
      getCachedTranslation(prefs, cacheKey(keyedInput)) ??
      getLooseCachedTranslation(prefs, keyedInput);
    if (currentCached) return currentCached;
  }

  return findSourceMatchedCachedTranslation(prefs, input, {
    fullTextOnly: false,
  });
}

function completeCacheKeyInput(
  input: ParagraphCacheLookupInput,
): CacheKeyInput | null {
  if (!input.endpoint || !input.model || !input.thinking || !input.ctxLevel) {
    return null;
  }
  return {
    sentence: input.sentence,
    target: input.target,
    endpoint: input.endpoint,
    model: input.model,
    thinking: input.thinking,
    ctxLevel: input.ctxLevel,
  };
}

function findSourceMatchedCachedTranslation(
  prefs: PrefsStore,
  input: ParagraphCacheLookupInput,
  options: { fullTextOnly: boolean },
): CacheEntry | undefined {
  const state = loadCache(prefs);
  const needles = uniqueNonEmpty([input.sentence, input.paragraphContext])
    .map((candidate) => ({
      raw: candidate,
      loose: normalizeForLooseMatch(candidate),
    }))
    .filter((candidate) => candidate.loose.length >= 20);
  if (!needles.length) return undefined;

  const matches: Array<{
    entry: CacheEntry;
    sourceLoose: string;
    position: number;
    exact: boolean;
  }> = [];
  for (const entry of Object.values(state.entries)) {
    if (options.fullTextOnly && entry.ctxLevel !== "full-text") continue;
    if (entry.target && entry.target !== input.target) continue;
    const sourceText = entry.sourceText ?? "";
    const sourceLoose = normalizeForLooseMatch(sourceText);
    if (sourceLoose.length < 20) continue;
    const position = bestLooseMatchPosition(sourceLoose, needles);
    if (position < 0) continue;
    matches.push({
      entry,
      sourceLoose,
      position,
      exact: needles.some((needle) => needle.loose === sourceLoose),
    });
  }
  if (!matches.length) return undefined;

  const groups = groupSourceMatches(matches);
  const candidates: Array<{
    entry: CacheEntry;
    score: number;
    createdAt: number;
  }> = [];
  for (const group of groups) {
    const deduped = dedupeOverlappingMatches(
      group.sort((a, b) => {
        const byPosition = a.position - b.position;
        if (byPosition !== 0) return byPosition;
        return b.sourceLoose.length - a.sourceLoose.length;
      }),
    );
    if (!hasStartAnchoredMatch(deduped)) continue;
    const entry =
      deduped.length > 1 ? combineFullTextMatches(deduped) : deduped[0]!.entry;
    const createdAt = Math.max(
      ...deduped.map((match) => match.entry.createdAt),
    );
    candidates.push({
      entry,
      createdAt,
      score: sourceMatchScore(deduped, input),
    });
  }
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    return b.createdAt - a.createdAt;
  });
  return candidates[0]!.entry;
}

function groupSourceMatches<T extends { entry: CacheEntry }>(
  matches: T[],
): T[][] {
  const groups = new Map<string, T[]>();
  for (const match of matches) {
    const entry = match.entry;
    const key = [
      entry.target ?? "",
      entry.endpoint ?? "",
      entry.model,
      entry.thinking ?? "",
      entry.ctxLevel ?? "",
    ].join("|");
    const group = groups.get(key);
    if (group) group.push(match);
    else groups.set(key, [match]);
  }
  return Array.from(groups.values());
}

function sourceMatchScore(
  matches: Array<{ entry: CacheEntry; exact: boolean }>,
  input: ParagraphCacheLookupInput,
): number {
  const first = matches[0]!.entry;
  let score = 0;
  if (first.ctxLevel === "full-text") score += 100;
  if (matches.some((match) => match.exact)) score += 30;
  if (input.endpoint && first.endpoint === input.endpoint) score += 10;
  if (input.model && first.model === input.model) score += 10;
  if (input.thinking && first.thinking === input.thinking) score += 5;
  if (input.ctxLevel && first.ctxLevel === input.ctxLevel) score += 3;
  score += Math.min(matches.length, 5);
  return score;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value),
    ),
  );
}

function normalizeForLooseMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])[-\u2010-\u2015]\s+([A-Za-z])/g, "$1$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isSafeLooseCacheMatch(
  entryLoose: string,
  sourceLoose: string,
): boolean {
  if (entryLoose === sourceLoose) return true;
  if (entryLoose.includes(sourceLoose)) {
    return isSafePrefixSuperset(entryLoose, sourceLoose);
  }
  if (sourceLoose.includes(entryLoose)) {
    return isSafePrefixSuperset(sourceLoose, entryLoose);
  }
  return false;
}

function findLegacyFullTextChunkMatches(
  state: TranslateCacheState,
  input: CacheKeyInput,
  candidates: string[],
  fullTextContext?: string,
): Array<{ entry: CacheEntry; sourceLoose: string; position: number }> {
  const needles = candidates
    .map((candidate) => ({
      raw: candidate,
      loose: normalizeForLooseMatch(candidate),
    }))
    .filter((candidate) => candidate.loose.length >= 20);
  const contexts = [
    ...candidates.map((candidate) => ({
      text: candidate,
      requireOverlap: false,
    })),
    ...(fullTextContext
      ? [{ text: fullTextContext, requireOverlap: true }]
      : []),
  ];
  for (const context of contexts) {
    const chunks = splitFullTextCacheChunks(context.text);
    if (chunks.length <= 1) continue;
    const matches: Array<{
      entry: CacheEntry;
      sourceLoose: string;
      position: number;
      matchPosition: number;
    }> = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const sourceLoose = normalizeForLooseMatch(chunk);
      const matchPosition = bestLooseMatchPosition(sourceLoose, needles);
      if (context.requireOverlap && matchPosition < 0) {
        continue;
      }
      const key = cacheKey({
        ...input,
        sentence: chunk,
        ctxLevel: "full-text",
      });
      const entry = state.entries[key];
      if (!entry) continue;
      matches.push({
        entry,
        sourceLoose,
        position: index,
        matchPosition,
      });
    }
    if (matches.length) {
      if (
        context.requireOverlap &&
        !matches.some((match) => match.matchPosition === 0)
      ) {
        continue;
      }
      return matches;
    }
  }
  return [];
}

function splitFullTextCacheChunks(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const raw = normalized
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((part) => part.length >= 20 && /[A-Za-z\u4e00-\u9fff]/.test(part));
  const out: string[] = [];
  for (const paragraph of raw.length
    ? raw
    : [text.replace(/[ \t\f\v]+/g, " ").trim()]) {
    out.push(...splitLongFullTextCacheChunk(paragraph));
  }
  return out;
}

function splitLongFullTextCacheChunk(paragraph: string): string[] {
  if (paragraph.length <= FULL_TEXT_CACHE_MAX_SOURCE_CHARS) return [paragraph];
  const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [
    paragraph,
  ];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const next = current ? `${current} ${trimmed}` : trimmed;
    if (next.length <= FULL_TEXT_CACHE_MAX_SOURCE_CHARS) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = trimmed;
  }
  if (current) chunks.push(current);
  return chunks;
}

function combineFullTextMatches(
  matches: Array<{ entry: CacheEntry }>,
  input?: CacheKeyInput,
): CacheEntry {
  const first = matches[0]!.entry;
  return {
    text: matches.map((match) => match.entry.text).join("\n\n"),
    model: first.model,
    createdAt: Math.max(...matches.map((match) => match.entry.createdAt)),
    sourceText: matches
      .map((match) => match.entry.sourceText ?? "")
      .filter(Boolean)
      .join("\n\n"),
    target: input?.target ?? first.target,
    endpoint: input?.endpoint ?? first.endpoint,
    thinking: input?.thinking ?? first.thinking,
    ctxLevel: "full-text",
  };
}

function bestLooseMatchPosition(
  sourceLoose: string,
  needles: Array<{ raw: string; loose: string }>,
): number {
  let best = -1;
  for (const needle of needles) {
    const reverse = needle.loose.indexOf(sourceLoose);
    if (reverse >= 0) {
      best = best < 0 ? reverse : Math.min(best, reverse);
      continue;
    }
    const direct = sourceLoose.indexOf(needle.loose);
    if (direct === 0 && isSafePrefixSuperset(sourceLoose, needle.loose)) {
      best = best < 0 ? direct : Math.min(best, direct);
    }
  }
  return best;
}

function isSafePrefixSuperset(
  sourceLoose: string,
  needleLoose: string,
): boolean {
  if (!hasSameLooseStart(sourceLoose, needleLoose)) return false;
  const extra = sourceLoose.length - needleLoose.length;
  if (extra <= 0) return true;
  return (
    extra <=
    Math.max(
      FULL_TEXT_DIRECT_MATCH_MAX_EXTRA_CHARS,
      Math.floor(needleLoose.length * FULL_TEXT_DIRECT_MATCH_MAX_EXTRA_RATIO),
    )
  );
}

function hasSameLooseStart(a: string, b: string): boolean {
  const length = Math.min(FULL_TEXT_START_ANCHOR_CHARS, a.length, b.length);
  return length > 0 && a.slice(0, length) === b.slice(0, length);
}

function hasStartAnchoredMatch(matches: Array<{ position: number }>): boolean {
  return matches.some((match) => match.position === 0);
}

function dedupeOverlappingMatches<
  T extends { sourceLoose: string; position: number },
>(matches: T[]): T[] {
  const kept: T[] = [];
  for (const match of matches) {
    const matchEnd = match.position + match.sourceLoose.length;
    const overlap = kept.some((existing) => {
      const existingEnd = existing.position + existing.sourceLoose.length;
      return match.position < existingEnd && matchEnd > existing.position;
    });
    if (!overlap) kept.push(match);
  }
  return kept;
}

// Non-atomic load-modify-save. Safe here because writes are user-driven
// (one click → one translate → one cache write), so concurrent writers
// don't exist in the runtime model. Do not call from background timers.
export function setCachedTranslation(
  prefs: PrefsStore,
  key: string,
  entry: CacheEntry,
): void {
  const state = loadCache(prefs);
  state.entries[key] = entry;
  saveCache(prefs, state);
}
