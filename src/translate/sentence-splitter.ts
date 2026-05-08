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

// U.S.A.-style acronyms: when the period is part of a token of >=2
// dot-separated alphabetic segments each <=2 chars, keep the token joined.
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
      if (isAcronymPeriod(text, i) && !startsLikelyNextSentence(text, i + 1)) continue;
    }

    const slice = text.slice(cursor, i + 1).trim();
    if (slice) {
      const start = skipLeadingWhitespace(text, cursor, i + 1);
      out.push({ text: slice, start, end: start + slice.length });
    }
    cursor = i + 1;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const start = skipLeadingWhitespace(text, cursor, text.length);
    out.push({ text: tail, start, end: start + tail.length });
  }
  return out;
}

function startsLikelyNextSentence(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (isWhitespace(ch)) continue;
    return /[A-Z\u4e00-\u9fff]/.test(ch);
  }
  return false;
}

function skipLeadingWhitespace(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && isWhitespace(text[i]!)) i++;
  return i;
}

export function sentenceAt(text: string, offset: number): SentenceSpan | null {
  if (offset < 0 || offset > text.length) return null;
  const spans = splitSentences(text);
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return null;
}
