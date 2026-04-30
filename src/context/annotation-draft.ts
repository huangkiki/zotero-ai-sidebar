const SUGGESTION_HEADER = /^[ \t]*建议注释[：:][ \t]*(.*)$/m;
const BULLET_LINE = /^[ \t]*[-•·*][ \t]+(.+)$/;

export interface ParsedAnnotationSuggestion {
  body: string;
  comment: string | null;
}

export function parseAnnotationSuggestion(content: string): ParsedAnnotationSuggestion {
  const text = content ?? '';
  const lastIndex = findLastHeaderIndex(text);
  if (lastIndex < 0) return { body: text, comment: null };

  const beforeHeader = text.slice(0, lastIndex);
  const afterHeader = text.slice(lastIndex);
  const match = afterHeader.match(SUGGESTION_HEADER);
  if (!match) return { body: text, comment: null };

  const headerInline = match[1].trim();
  const blockBody = afterHeader.slice(match[0].length).replace(/^\r?\n/, '');
  const comment = extractComment(headerInline, blockBody);
  return { body: trimTrailingBlankLines(beforeHeader), comment };
}

function findLastHeaderIndex(text: string): number {
  const re = /^[ \t]*建议注释[：:][ \t]*/gm;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) != null) last = match.index;
  return last;
}

function extractComment(headerInline: string, blockBody: string): string | null {
  const bullets = collectBullets(blockBody);
  if (bullets.length > 0) return bullets.map((line) => `- ${line}`).join('\n');

  const inline = [headerInline, blockBody].map((s) => s.trim()).filter(Boolean).join('\n').trim();
  return inline || null;
}

function collectBullets(blockBody: string): string[] {
  const lines = blockBody.split(/\r?\n/);
  const bullets: string[] = [];
  for (const raw of lines) {
    const m = raw.match(BULLET_LINE);
    if (m) bullets.push(m[1].trim());
  }
  return bullets;
}

function trimTrailingBlankLines(text: string): string {
  return text.replace(/\s+$/u, '');
}
