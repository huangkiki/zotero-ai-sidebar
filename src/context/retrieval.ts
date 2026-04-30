import type { RetrievedPassage } from './types';
import type { ContextPolicy } from './policy';
import { DEFAULT_CONTEXT_POLICY } from './policy';

export function searchPdfPassages(
  pdfText: string,
  query: string,
  topK = DEFAULT_CONTEXT_POLICY.searchCandidateCount,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): RetrievedPassage[] {
  const normalizedText = normalizeWhitespace(pdfText);
  if (!normalizedText) return [];

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const passages = splitIntoPassages(normalizedText, policy);
  const scored = passages
    .map((passage) => ({
      ...passage,
      score: scorePassage(passage.text, terms, query),
    }))
    .filter((passage) => passage.score > 0);

  return scored
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, clampTopK(topK, policy));
}

export function extractPdfRange(
  pdfText: string,
  rangeStart: number,
  rangeEnd: number,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): RetrievedPassage | null {
  const normalizedText = normalizeWhitespace(pdfText);
  if (!normalizedText) return null;
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) return null;
  if (rangeStart < 0 || rangeEnd <= rangeStart) return null;
  if (rangeStart >= normalizedText.length) return null;

  const start = rangeStart;
  const cappedEnd = Math.min(rangeEnd, start + policy.maxRangeChars, normalizedText.length);
  const text = normalizedText.slice(start, cappedEnd).trim();
  if (!text) return null;
  return { text, score: 1, start, end: cappedEnd };
}

export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of tokenizeQuery(query)) {
    if (token.kind === 'latin') {
      if (token.text.length > 1) terms.add(token.text.toLowerCase());
      continue;
    }

    if (token.text.length <= 4) terms.add(token.text);
    for (let index = 0; index < token.text.length - 1; index++) {
      terms.add(token.text.slice(index, index + 2));
    }
  }
  return [...terms];
}

function splitIntoPassages(
  text: string,
  policy: ContextPolicy,
): RetrievedPassage[] {
  const paragraphs = splitParagraphs(text);
  const source = paragraphs.length >= 3
    ? splitLongParts(paragraphs, policy)
    : chunkText(text, policy);

  const passages: RetrievedPassage[] = [];
  let cursor = 0;
  for (const part of source) {
    const start = text.indexOf(part, cursor);
    const safeStart = start >= 0 ? start : cursor;
    passages.push({
      text: part,
      score: 0,
      start: safeStart,
      end: safeStart + part.length,
    });
    cursor = safeStart + part.length;
  }
  return passages;
}

function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (line) {
      current.push(line);
      continue;
    }

    if (current.length) {
      paragraphs.push(current.join('\n'));
      current = [];
    }
  }

  if (current.length) paragraphs.push(current.join('\n'));
  return paragraphs;
}

function splitLongParts(parts: string[], policy: ContextPolicy): string[] {
  return parts.flatMap((part) =>
    part.length > policy.maxPassageChars ? chunkText(part, policy) : [part],
  );
}

function chunkText(text: string, policy: ContextPolicy): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + policy.maxPassageChars);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === text.length) break;
    start = Math.max(end - policy.passageOverlapChars, start + 1);
  }
  return chunks;
}

function scorePassage(text: string, terms: string[], query: string): number {
  const lowered = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += countOccurrences(lowered, term.toLowerCase()) * Math.max(1, Math.min(term.length, 8));
  }

  const phrase = query.trim().toLowerCase();
  if (phrase.length >= 4 && lowered.includes(phrase)) {
    score += Math.min(phrase.length, 40);
  }
  return score;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count++;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

function normalizeWhitespace(text: string): string {
  const normalizedLines = splitLines(text).map(trimLineEndSpaces);
  const output: string[] = [];
  let pendingBlank = false;

  for (const line of normalizedLines) {
    if (line.trim()) {
      if (pendingBlank && output.length) output.push('');
      output.push(line);
      pendingBlank = false;
    } else if (output.length) {
      pendingBlank = true;
    }
  }

  return output.join('\n').trim();
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') {
      const line = text.slice(start, index);
      lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = index + 1;
    }
  }
  const line = text.slice(start);
  lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
  return lines;
}

function trimLineEndSpaces(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1];
    if (char !== ' ' && char !== '\t') break;
    end--;
  }
  return text.slice(0, end);
}

interface QueryToken {
  kind: 'latin' | 'cjk';
  text: string;
}

function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let latin = '';
  let cjk = '';

  const flushLatin = () => {
    if (latin) tokens.push({ kind: 'latin', text: latin });
    latin = '';
  };
  const flushCjk = () => {
    if (cjk) tokens.push({ kind: 'cjk', text: cjk });
    cjk = '';
  };

  for (const char of query) {
    if (isAsciiAlphaNumeric(char) || (char === '-' && latin)) {
      flushCjk();
      latin += char;
      continue;
    }
    if (isCjkUnifiedIdeograph(char)) {
      flushLatin();
      cjk += char;
      continue;
    }
    flushLatin();
    flushCjk();
  }

  flushLatin();
  flushCjk();
  return tokens;
}

function isAsciiAlphaNumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function isCjkUnifiedIdeograph(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

function clampTopK(topK: number, policy: ContextPolicy): number {
  if (!Number.isFinite(topK)) return policy.searchCandidateCount;
  return Math.max(1, Math.min(Math.floor(topK), policy.maxSearchTopK));
}
