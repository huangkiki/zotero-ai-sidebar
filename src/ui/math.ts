// LaTeX math integration for the chat renderer.
//
// CONTEXT: the sidebar uses a hand-rolled streaming Markdown renderer
// (`renderMarkdownInto` / `appendInlineMarkdown` in src/modules/sidebar.ts)
// with a hard "no innerHTML" invariant. Real math typesetting unavoidably
// emits HTML, so KaTeX-rendered subtrees are the ONE deliberate hole in
// that invariant — see `renderMathInto` below for why that is bounded.
//
// SCOPE: this module owns (a) detecting math regions in a string and
// (b) rendering a closed region. The detector is the user-contribution
// point; everything else here is plumbing.

import katex from "katex";

export type MathRegion = {
  /** Index of the first char of the opening delimiter. */
  start: number;
  /** Index immediately after the closing delimiter. */
  end: number;
  /** LaTeX source between the delimiters, with no surrounding $ / \[ / \( etc. */
  latex: string;
  /** true → display math (block typeset). false → inline math. */
  display: boolean;
};

// =====================================================================
// USER CONTRIBUTION POINT — fill in this function.
// =====================================================================
//
// Contract:
//   Scan `text` from `cursor` and return the EARLIEST math region whose
//   opening AND closing delimiter are BOTH already present in `text`.
//
// Streaming-safety contract (CRITICAL):
//   Return null if NO closed region exists from `cursor` onwards.
//   The caller will emit the rest as plain text and re-scan on the next
//   streaming chunk. NEVER return a region whose closing delimiter is
//   missing — that would half-render display math mid-stream and the
//   next chunk would have to unwind it.
//
// Delimiters to consider (your call which to honor):
//   \[ ... \]   display   — unambiguous, recommend honoring.
//   \( ... \)   inline    — unambiguous, recommend honoring.
//   $$ ... $$   display   — recommend honoring.
//   $ ... $     inline    — HIGHEST RISK, can collide with prose like
//                           "$5 and $10". Suggested guards:
//                             - opening $ must be followed by non-space
//                             - closing $ must be preceded by non-space
//                             - body must not contain a newline
//                             - prev char before opening $ must not be a digit
//                               (avoids "earned $5 yesterday")
//                           Or: don't honor single-$ at all and require
//                           authors to use \( ... \).
//
// Examples your implementation must satisfy:
//   findNextMathRegion("a $$x = 1$$ b", 0)
//     → { start: 2, end: 11, latex: "x = 1", display: true }
//
//   findNextMathRegion("a \\[ x \\] b", 0)
//     → { start: 2, end: 9, latex: " x ", display: true }
//
//   findNextMathRegion("a \\( y \\) b", 0)
//     → { start: 2, end: 9, latex: " y ", display: false }
//
//   findNextMathRegion("open: \\[ x", 0)
//     → null   // no closing \] yet — will be retried next stream chunk
//
//   findNextMathRegion("got $5 and $10", 0)
//     → null   // strict $...$ guards reject this
//
//   findNextMathRegion("first \\(a\\) second \\(b\\)", 0)
//     → { start: 6, ... }  // earliest closed region only; caller loops
//
// Tests: tests/ui/math.test.ts already encodes the cases above. Run
// `npm test -- math` to iterate.
export function findNextMathRegion(
  text: string,
  cursor: number,
): MathRegion | null {
  // Strategy: find the FIRST opener at or after cursor. If it closes, return
  // that region. If it doesn't close, return null — even if a later region
  // would close — because the unclosed opener might still be mid-stream and
  // a "later" closed region could actually be nested inside it once the
  // chunk completes. Conservative > greedy for streaming safety.
  for (let i = cursor; i < text.length; i++) {
    const opener = peekOpener(text, i);
    if (!opener) continue;
    const close = findClose(text, i + opener.openLen, opener.kind);
    if (close < 0) return null;
    return {
      start: i,
      end: close + opener.closeLen,
      latex: text.slice(i + opener.openLen, close),
      display: opener.display,
    };
  }
  return null;
}

type OpenerKind =
  | "displayBracket" // \[ ... \]
  | "inlineParen" // \( ... \)
  | "displayDollar" // $$ ... $$
  | "inlineDollar"; // $ ... $

function peekOpener(
  text: string,
  i: number,
): { kind: OpenerKind; openLen: number; closeLen: number; display: boolean } | null {
  if (text.startsWith("\\[", i)) {
    return { kind: "displayBracket", openLen: 2, closeLen: 2, display: true };
  }
  if (text.startsWith("\\(", i)) {
    return { kind: "inlineParen", openLen: 2, closeLen: 2, display: false };
  }
  // Order matters: $$ must be checked before $ so we don't open a single-$
  // region whose "body" starts with another $.
  if (text.startsWith("$$", i)) {
    return { kind: "displayDollar", openLen: 2, closeLen: 2, display: true };
  }
  if (text[i] === "$") {
    // Single-$ guards (Contract A) — keep prose like "earned $5 and $10"
    // out of math mode.
    //   - char before $ must not be a digit (rejects "earned $5")
    //   - char after  $ must not be whitespace, end-of-string, or another $
    if (i > 0 && isDigit(text[i - 1]!)) return null;
    const next = text[i + 1];
    if (!next || isSpace(next) || next === "$") return null;
    return { kind: "inlineDollar", openLen: 1, closeLen: 1, display: false };
  }
  return null;
}

function findClose(text: string, from: number, kind: OpenerKind): number {
  if (kind === "displayBracket") return text.indexOf("\\]", from);
  if (kind === "inlineParen") return text.indexOf("\\)", from);
  if (kind === "displayDollar") return text.indexOf("$$", from);
  // inlineDollar: scan forward, reject newlines, require non-space prefix.
  for (let j = from; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\n") return -1;
    if (ch === "$" && j > from && !isSpace(text[j - 1]!)) return j;
  }
  return -1;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Output backend for math rendering.
 *
 * - `"html"`   : KaTeX HTML+CSS layout. Best visual fidelity. REQUIRES
 *                katex.min.css to be loaded in the document. Used in the
 *                chat sidebar, where we inject the <link> ourselves.
 * - `"mathml"` : KaTeX MathML output. Self-contained — Firefox/Gecko
 *                renders <math> natively without external CSS. Used in
 *                the Zotero note path, where we cannot load chrome:// CSS
 *                inside the note editor.
 * - `"source"` : No KaTeX call. Emit the LaTeX source as plain text
 *                wrapped in a styled element. Last-resort fallback for
 *                contexts where neither HTML nor MathML survives.
 */
export type MathRenderMode = "html" | "mathml" | "source";

// Render a closed LaTeX region into target via KaTeX.
//
// SECURITY NOTE: this is the ONLY place in the renderer pipeline that uses
// innerHTML. It is bounded because:
//   1. KaTeX with strict='ignore' + trust=false parses LaTeX into an
//      internal AST and emits its own escaped HTML — it never embeds the
//      raw input as HTML. The output surface is the set of tags KaTeX
//      itself produces (span, math, mfrac, etc.), not anything the model wrote.
//   2. KaTeX's renderToString throws on truly broken input; we catch and
//      fall back to plain-text source so the user still sees what the
//      model produced.
//   3. Only the math wrapper element receives innerHTML. Everything else
//      in the sidebar continues to use textContent / createElement only.
export function renderMathInto(
  target: HTMLElement,
  region: MathRegion,
  mode: MathRenderMode = "html",
): void {
  const doc = target.ownerDocument!;

  if (mode === "source") {
    appendMathSource(target, region);
    return;
  }

  let html: string;
  try {
    html = katex.renderToString(region.latex, {
      displayMode: region.display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: mode === "mathml" ? "mathml" : "html",
    });
  } catch {
    appendMathSource(target, region);
    return;
  }
  const wrapper = doc.createElement(region.display ? "div" : "span");
  wrapper.className = region.display ? "math-display" : "math-inline";
  // Stash the original LaTeX so selection serializers can reconstruct
  // copy-pasteable source instead of the visually-positioned glyphs that
  // selection.toString() would otherwise emit (KaTeX HTML order ≠ visual
  // order; e.g. subscripts live in absolutely-positioned vlist spans).
  wrapper.dataset.latex = region.latex;
  wrapper.dataset.display = region.display ? "true" : "false";
  wrapper.innerHTML = html;
  target.append(wrapper);
}

// Emit the LaTeX source in Zotero's official note-editor math storage shape:
//   - display: <pre class="math">$$LATEX$$</pre>
//   - inline:  <span class="math">$LATEX$</span>
// Zotero's ProseMirror schema strips these delimiters while parsing, then
// stores the node as a single editable/rendered math atom. Using ad-hoc
// classes such as math-display/math-inline leaves the formula as normal HTML
// and can make Better Notes/Zotero render delimiter/source fragments as
// separate visible formulas.
function appendMathSource(target: HTMLElement, region: MathRegion): void {
  const doc = target.ownerDocument!;
  const wrapper = doc.createElement(region.display ? "pre" : "span");
  wrapper.className = "math";
  wrapper.dataset.latex = region.latex;
  wrapper.dataset.display = region.display ? "true" : "false";
  wrapper.textContent = region.display
    ? `$$${region.latex}$$`
    : `$${region.latex}$`;
  target.append(wrapper);
}
