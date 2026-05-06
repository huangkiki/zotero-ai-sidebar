import type { RetrievedPassage } from "./types";

const MIN_PREFIX_CHARS = 28;
const MAX_PREFIX_CHARS = 160;

export function resolveSelectedTextFromPdfText(
  selectedText: string,
  pdfText: string,
  nearbyPassages: RetrievedPassage[] = [],
): string {
  const selected = normalizeSelectionText(selectedText);
  if (selected.length < MIN_PREFIX_CHARS) return selectedText;

  const sources = [
    ...nearbyPassages.map((passage) => passage.text),
    pdfText,
  ].map(normalizeSelectionText);

  for (const source of sources) {
    const exactIndex = source.toLowerCase().indexOf(selected.toLowerCase());
    if (exactIndex >= 0) {
      return source.slice(exactIndex, exactIndex + selected.length).trim();
    }
  }

  for (const source of sources) {
    const match = findLongestPrefixMatch(source, selected);
    if (!match) continue;
    const candidate = sentenceCandidate(source, match.index, match.prefixLength);
    if (isUsefulRepairCandidate(candidate, selected)) return candidate;
  }

  return selectedText;
}

function findLongestPrefixMatch(
  source: string,
  selected: string,
): { index: number; prefixLength: number } | null {
  const sourceLower = source.toLowerCase();
  const selectedLower = selected.toLowerCase();
  const maxLength = Math.min(MAX_PREFIX_CHARS, selectedLower.length);
  for (let length = maxLength; length >= MIN_PREFIX_CHARS; length--) {
    const prefix = selectedLower.slice(0, length);
    const index = sourceLower.indexOf(prefix);
    if (index >= 0) return { index, prefixLength: length };
  }
  return null;
}

function sentenceCandidate(
  source: string,
  matchIndex: number,
  prefixLength: number,
): string {
  const start = sentenceStartBefore(source, matchIndex);
  const end = sentenceEndAfter(source, matchIndex + prefixLength);
  return source.slice(start, end).trim();
}

function sentenceStartBefore(text: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!/[.!?]/.test(text[cursor])) continue;
    let start = cursor + 1;
    while (start < text.length && /\s/.test(text[start])) start++;
    return start;
  }
  return 0;
}

function sentenceEndAfter(text: string, index: number): number {
  for (let cursor = index; cursor < text.length; cursor++) {
    if (!/[.!?]/.test(text[cursor])) continue;
    const next = text[cursor + 1] ?? "";
    if (!next || /\s/.test(next)) return cursor + 1;
  }
  return text.length;
}

function isUsefulRepairCandidate(candidate: string, selected: string): boolean {
  if (candidate.length < MIN_PREFIX_CHARS) return false;
  if (candidate.length > selected.length * 2 + 80) return false;
  return tokenOverlapRatio(candidate, selected) >= 0.35;
}

function tokenOverlapRatio(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function tokenSet(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(Boolean),
  );
}

function normalizeSelectionText(text: string): string {
  return text
    .replace(/([A-Za-z]{3,})-\s*\r?\n\s*([a-z]{3,})/g, "$1$2")
    .replace(/([A-Za-z]{3,})-\s{2,}([a-z]{3,})/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
