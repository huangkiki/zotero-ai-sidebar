// Walks a DOM Selection and produces clean Markdown-flavored text suitable
// for clipboard or note insertion. The key job: when the selection passes
// through KaTeX-rendered math (or any element marked with `data-latex`),
// emit the LaTeX source from that attribute, NOT the visually-positioned
// glyph soup that selection.toString() would produce.
//
// KaTeX HTML output relies on absolute positioning + custom fonts to lay
// out subscripts, fractions, etc. The textContent of those spans is
// reordered relative to visual reading order, and \mathbb-style glyphs
// are font-rendered ASCII letters that don't survive a copy. Hence the
// data-latex round-trip.

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
]);

export function serializeSelectionAsMarkdown(
  selection: Selection | null,
): string {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const parts: string[] = [];
  const seenMath = new Set<HTMLElement>();
  for (let i = 0; i < selection.rangeCount; i++) {
    const part = serializeRange(selection.getRangeAt(i), seenMath);
    if (part) parts.push(part);
  }
  return collapseBlankLines(parts.join("\n\n").trim());
}

function serializeRange(range: Range, seenMath: Set<HTMLElement>): string {
  // Selection entirely inside a single math wrapper → emit the whole
  // LaTeX source. Partial-math selection is meaningless because KaTeX's
  // span order ≠ visual order; copying half a fraction would be garbage.
  const startMath = closestMath(range.startContainer);
  const endMath = closestMath(range.endContainer);
  if (startMath && startMath === endMath) {
    return mathToSourceOnce(startMath, seenMath);
  }

  return collapseBlankLines(
    serializeSelectedNode(range.commonAncestorContainer, range, seenMath).trim(),
  );
}

function serializeSelectedNode(
  node: Node,
  range: Range,
  seenMath: Set<HTMLElement>,
): string {
  if (!rangeIntersectsNode(range, node)) return "";

  if (node.nodeType === 3 /* TEXT_NODE */) {
    return selectedText(node as Text, range);
  }

  if (node.nodeType !== 1 /* ELEMENT_NODE */) {
    let acc = "";
    for (const child of Array.from(node.childNodes) as Node[]) {
      acc += serializeSelectedNode(child, range, seenMath);
    }
    return acc;
  }

  const el = node as HTMLElement;
  if (el.dataset?.latex !== undefined) {
    return mathToSourceOnce(el, seenMath);
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "br") return "\n";

  let acc = "";
  for (const child of Array.from(el.childNodes) as Node[]) {
    acc += serializeSelectedNode(child, range, seenMath);
  }

  if (BLOCK_TAGS.has(tag)) {
    if (tag === "li") return acc.trim() ? `- ${acc.trim()}\n` : "";
    return acc.trim() ? `${acc}\n\n` : "";
  }
  return acc;
}

function selectedText(node: Text, range: Range): string {
  const text = node.textContent || "";
  let start = 0;
  let end = text.length;
  if (node === range.startContainer) start = range.startOffset;
  if (node === range.endContainer) end = range.endOffset;
  return text.slice(start, end);
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function closestMath(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as HTMLElement;
      if (el.dataset?.latex !== undefined) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function mathToSource(el: HTMLElement): string {
  const latex = el.dataset.latex ?? "";
  const display = el.dataset.display === "true";
  // Display math needs blank lines on BOTH sides so the downstream block
  // parser treats it as its own paragraph. With only single \n the math
  // line gets joined with adjacent prose into one paragraph buffer; after
  // inline math rendering hoists <pre>, the trailing text ends up in a
  // <p> with a leading space, and ProseMirror's HTML→slice parser tends
  // to drop that paragraph (and everything after it).
  return display ? `\n\n$$${latex}$$\n\n` : `$${latex}$`;
}

function mathToSourceOnce(
  el: HTMLElement,
  seenMath: Set<HTMLElement>,
): string {
  if (seenMath.has(el)) return "";
  seenMath.add(el);
  return mathToSource(el);
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}
