// Parses the assistant's MESSAGE OUTPUT for an inline annotation
// suggestion that the sidebar can promote into a Zotero PDF annotation
// (without going through the agent tool loop's `requiresApproval` path).
//
// IMPORTANT: this is OUTPUT parsing, not intent routing. The model decides
// to emit a "建议注释:" marker on its own and the user clicks "save" to
// commit it. We never hidden-auto-fire annotations from the parsed text —
// that would violate CLAUDE.md "No hidden Zotero writes".
//
// Convention the model follows:
//   ...assistant body...
//
//   建议注释：<inline content>
//   - bullet 1
//   - bullet 2
//
// The header marker is fixed Chinese (`建议注释`) because the assistant
// system prompt is Chinese-first; if you change the marker you must also
// update the prompt where it instructs the model to emit it.
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

// LAST header wins. WHY: streaming responses can include a draft
// suggestion mid-output and a refined one near the end. We always promote
// the most recent occurrence so revisions overwrite drafts.
function findLastHeaderIndex(text: string): number {
  const re = /^[ \t]*建议注释[：:][ \t]*/gm;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) != null) last = match.index;
  return last;
}

// Bullets win over inline. WHY: the model often offers multiple framings
// ("- focus on the limitation", "- focus on the contribution"); preserving
// them as a `- ` list lets the user see the alternatives in the saved
// annotation. Falls back to inline text only when no bullets are present.
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
