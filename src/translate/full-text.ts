const FULL_TRANSLATE_MAX_PARAGRAPH_CHARS = 900;

export function splitFullTextParagraphs(text: string): string[] {
  const normalized = stripReferenceSection(text.replace(/\r\n?/g, "\n"));
  const raw = normalized
    .split(/\n\s*\n+/)
    .map((part) => part.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((part) => part.length >= 20 && /[A-Za-z\u4e00-\u9fff]/.test(part));
  const out: string[] = [];
  for (const paragraph of raw) {
    out.push(...splitLongParagraph(paragraph));
  }
  return out;
}

function stripReferenceSection(text: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => isReferenceHeading(line));
  if (index < 0) return text;
  return lines.slice(0, index).join("\n").trimEnd();
}

function isReferenceHeading(line: string): boolean {
  const trimmed = line
    .replace(/^[#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed || trimmed.length > 80) return false;
  const withoutNumber = trimmed.replace(
    /^(?:section\s*)?\d+(?:\.\d+)*\.?\s+/i,
    "",
  );
  return (
    /^(?:references|bibliography|works cited|literature cited|cited references|references and notes)$/i.test(
      withoutNumber,
    ) ||
    /^(?:参考文献|参考资料|引用文献)$/.test(withoutNumber)
  );
}

function splitLongParagraph(paragraph: string): string[] {
  if (paragraph.length <= FULL_TRANSLATE_MAX_PARAGRAPH_CHARS) {
    return [paragraph];
  }
  const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [paragraph];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
    if (next.length <= FULL_TRANSLATE_MAX_PARAGRAPH_CHARS) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = sentence.trim();
  }
  if (current) chunks.push(current);
  return chunks;
}
