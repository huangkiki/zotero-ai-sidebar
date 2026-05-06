# Math Rendering Status

Working notes for LaTeX/math rendering across the chat sidebar and the
Zotero note write path. Capture what's built, what's verified, and what's
still failing — so we don't relitigate decisions or lose state between
debugging sessions.

## Two render contexts

| Context | Where | Owner of typesetting | Math mode in our renderer |
|---|---|---|---|
| **Chat sidebar** | `src/modules/sidebar.ts` bubble bodies | Bundled KaTeX + our injected `katex.min.css` | `"html"` |
| **Zotero note** | `assistantContentToNoteHTML` → `note.setNote` (or BN insert) | **Better Notes' own KaTeX pass** | `"source"` |

Both contexts share `findNextMathRegion` for delimiter detection. Only
`renderMathInto`'s output shape differs by mode.

## Pipeline

```
model output (Markdown + LaTeX delimiters)
    │
    ├── chat:     renderMarkdownInto(body, content, "html")
    │             └── appendInlineMarkdown
    │                  └── findNextMathRegion → renderMathInto (html)
    │                       └── katex.renderToString({ output: "html" })
    │                       └── <div|span class="math-display|inline">…KaTeX HTML…</div>
    │                       (CSS: addon/content/katex/katex.min.css via <link>)
    │
    └── note:     assistantContentToNoteHTML → renderMarkdownInto(body, content, "source")
                  └── appendInlineMarkdown
                       └── findNextMathRegion → renderMathInto (source)
                            └── <span class="math">$inner$</span>           (inline)
                            └── <span class="math">$$inner$$</span>         (display)
                       (Better Notes' KaTeX pass picks up class="math" and renders)
```

## Mode matrix

| `mathMode` | renderer output | Survives in… | Used by |
|---|---|---|---|
| `"html"` | KaTeX HTML+CSS | Anywhere our `katex.min.css` is loaded | Chat sidebar |
| `"mathml"` | KaTeX MathML | Native browser MathML; **NOT** in Zotero note editor (gets flattened to textContent — see Issue 2) | _abandoned for note path; kept as option in case a future surface needs native rendering without our CSS_ |
| `"source"` | `<span class="math">$..$</span>` | Better Notes ProseMirror (BN's `.math` selector renders) | Zotero note path |

## Key files

- `src/ui/math.ts` — `MathRegion` type, `findNextMathRegion`, `renderMathInto`, `appendMathSource`.
- `src/modules/sidebar.ts`:
  - `renderMarkdownInto` / `appendInlineMarkdown` (around line 4889 and 5008) — block + inline parsers, threaded with `mathMode`.
  - `assistantContentToNoteHTML` (around line 4448) — note path entry, hardcoded `"source"`.
  - `<link>` injection for `katex.min.css` near column registration (~line 5703).
- `src/context/builder.ts` — `SYSTEM_BASE` system prompt, includes "use $..$, no backticks" rule.
- `src/context/agent-tools.ts` — `zotero_append_to_note` tool description, includes math formatting guidance.
- `addon/content/katex/katex.min.css` + `addon/content/katex/fonts/*.woff2` — bundled KaTeX assets.
- `tests/ui/math.test.ts` — `findNextMathRegion` spec.

## Issue log

Numbering matches the order they were diagnosed.

### Issue 1 — Chat showed raw LaTeX text (`\[ ... \]`)

- **Symptom:** Chat displayed `\[ \mathbb{E}_{\mathcal{D}} ... \]` as plain text.
- **Root cause:** Hand-rolled Markdown renderer had zero math support.
- **Fix:** Added `findNextMathRegion` + KaTeX integration. Chat now uses
  `mathMode="html"` and consumes `\[..\]` `\(..\)` `$$..$$` `$..$` delimiters.
- **Status:** ✅ Fixed.

### Issue 2 — Note showed flat Unicode AND LaTeX source side by side

- **Symptom:** A formula written to a Zotero note showed up as
  `ED,τ,ω[H(x1:M,fθ...)] \mathbb{E}_{\mathcal D,\tau,\omega} \left[...`
  i.e. KaTeX's visible-glyph textContent **plus** the `<annotation>`
  textContent, concatenated.
- **Root cause:** The note editor strips `<math>`/`<semantics>`/`<mrow>`
  tags down to textContent, so MathML output is flattened. KaTeX's MathML
  output contains both the rendered glyph tree AND a `<annotation
  encoding="application/x-tex">` source-code element. Both end up as text.
- **Fix:** Switched note path from `"mathml"` to `"source"` mode.
- **Status:** ✅ Fixed (this specific failure mode).

### Issue 3 — Note showed raw `$$ ... $$` even after source mode

- **Symptom:** With source mode emitting plain `$..$` text, the note
  still showed visible `$$` delimiters and unrendered LaTeX.
- **Root cause:** Better Notes does NOT scan note text for `$..$` —
  it only renders math inside elements with `class="math"` (see
  `BetterNotes.js: doc.querySelectorAll(".math")`). Plain `$..$` text
  in a `<p>` is invisible to BN's renderer.
- **Fix:** `appendMathSource` now wraps in `<span class="math">$..$</span>`
  for source mode. BN strips `^\$+|\$+$` then hands the body to KaTeX.
- **Status:** ✅ Fixed (verified against BN source code, not yet
  end-to-end confirmed by user).

### Issue 4 — Chat showed `$$ formula $$` in inline-code styling

- **Symptom:** Chat displayed `$$ H(x_{1:M}, f_\theta^\ell(o_t, \ell)) $$`
  in a light pink/beige rounded box (inline `<code>` styling), with the
  `$$` delimiters visible.
- **Root cause:** Model wrapped the formula in backticks
  (`` `$$..$$` ``). In `appendInlineMarkdown`'s priority order, the
  backtick was at an earlier index than the `$$`, so the code branch
  won and the dollars were preserved verbatim.
- **Fix:**
  1. Renderer escape hatch: when an inline-code body, after trimming,
     is exactly one closed math region, render as math instead of code.
  2. System prompt: "Do NOT wrap math formulas in backticks."
- **Status:** ✅ Fixed in renderer; model behavior change pending model
  response to updated prompt.

### Issue 5 — Display math in note showed `$ ...` (single-$ leak), inline worked

- **Symptom:** After the source-mode + `<span class="math">` fix, inline
  math like `$\mathbb{E}[·]$` rendered correctly in notes. But display
  math written as `\[ ... \]` round-tripped to a literal text run
  starting with a single `$`, e.g. `$ \mathbb{E}_{\mathcal D,\tau,\omega}
  \left[ ...` — overflowing the column, no KaTeX.
- **Root cause:** Better Notes' storage contract distinguishes inline vs
  display math by **HTML tag**, not by class:
    - inline:  `<span class="math">$LATEX$</span>`
    - display: `<pre  class="math">$$LATEX$$</pre>`  ← `<pre>`, not `<span>`
  Found in `convert.js` (`parseKatexHTML`, around the
  `doc.querySelectorAll("span.katex, span.katex-display")` block). Our
  `<span class="math">$$..$$</span>` got parsed as inline math whose
  body began with `$`, leaking the dollars through.
- **Fix (a):** `appendMathSource` now emits `<pre>` for display, `<span>`
  for inline.
- **Fix (b):** `<p><pre></pre></p>` is invalid HTML — BN's ProseMirror
  parser drops the inner block. Added `flushParagraphWithBlockHoist` to
  hoist any `<pre>` direct children out of the paragraph wrapper, so
  display math sits at block level next to inline-text `<p>`s.
- **Status:** ✅ Fixed and end-to-end verified. Display math in notes
  now renders via Better Notes' KaTeX pass; the original "leaking `$`"
  symptom is gone.

- **Symptom:** User reports problems remain after Issue 4 fix.
- **Specifics:** Not yet provided in this debugging session.
- **Possible failure modes to investigate:**
  - **(a) Note-path single-line mismatch:** model may write
    `$$\nformula\n$$` (newlines around delimiters) which the block
    parser splits on blank lines if any exist, leaving an unclosed
    region per paragraph. `findNextMathRegion` returns null per
    paragraph → both `$$` lines render as plain text.
  - **(b) BN insertion path mismatch:** if `betterNotesNoteInsert`
    sanitizes/strips unknown classes, our `class="math"` might not
    survive into the saved note. Verify by inspecting the saved note
    HTML in Zotero (Tools → Run JavaScript → `Zotero.Items.get(noteID).getNote()`).
  - **(c) Vanilla Zotero editor (no Better Notes):** if Better Notes
    isn't loaded for this user, the note path falls through to
    `note.setNote(...)` directly and BN's renderer never runs. The
    `$..$` source remains literal text.
  - **(d) KaTeX parse error fallback:** when KaTeX throws on a specific
    formula, `appendMathSource` writes `<span class="math">$..$</span>`
    as fallback. In chat (no BN), this displays as plain text with
    `$..$` visible. Look for `console.error` from KaTeX in the
    Zotero Browser Console.
  - **(e) Model still wrapping in backticks:** the backtick escape
    hatch only triggers when the entire trimmed code body is a single
    math region. If model writes `` `$$ x $$ remark` ``, the trailing
    "remark" defeats the heuristic.
- **Status:** 🚧 Open — needs user repro: (1) which context (chat or
  note?), (2) screenshot, (3) the raw model output from chat history
  (long-press the assistant message and copy as Markdown to inspect
  the actual delimiters used).

## Diagnostic checklist

When a math rendering issue is reported, run through these in order:

1. **Identify the context.** Chat or note? CSS clue: chat formulas use
   our `.math-display` / `.math-inline` classes; note formulas use
   `class="math"` (BN's contract).
2. **Get the raw model output.** Inspect `chat-history.json` or use
   the chat's "copy as markdown" feature. Confirm which delimiters
   the model actually used.
3. **Run through `findNextMathRegion` mentally.** Does the input have
   a CLOSED region? Are there guards rejecting it (digit-before-`$`,
   space-padded `$`, newline in inline body)?
4. **For chat issues**, check that `katex.min.css` actually loaded.
   In the Browser Console:
   ```js
   document.querySelector('link[href*="katex"]')
   ```
   Should not be null.
5. **For note issues**, after writing, check the saved HTML:
   ```js
   Zotero.Items.get(<noteID>).getNote()
   ```
   Look for `<span class="math">` wrappers. If present and BN doesn't
   render → BN integration. If absent → our renderer didn't emit them
   (mode mismatch).
6. **Check Better Notes presence:** if BN is missing, source mode
   leaves `$..$` literal in the note. That's the documented vanilla
   fallback, not a bug.

## Decisions and tradeoffs

- **KaTeX over MathJax:** smaller bundle (~75 KB vs ~250 KB), synchronous
  rendering. Coverage suffices for academic papers; AMS macros and
  custom `\newcommand` were not deemed essential.
- **woff2-only fonts:** reduced 1.2 MB → 296 KB by dropping `.woff`
  and `.ttf` fallbacks. Zotero 7+ ships Firefox 102+ which has full
  woff2 support.
- **Single-`$` Contract A (with prose-safety guards):** chosen over
  Contract B (require `\(..\)` for inline). `$..$` is overwhelmingly
  the form models produce; guards (digit-before, space-after, newline,
  $-after) keep prose like "earned $5" out of math mode.
- **Source mode emits BN's class="math" wrapper:** this is the only
  serialization that survives BN's ProseMirror schema and triggers
  its KaTeX pass. Diagnosed by reading BN's `BetterNotes.js`
  (`querySelectorAll(".math")` block, ~line 32158).
- **Backtick escape hatch only triggers on whole-body math:** narrow
  heuristic (`inner.start === 0 && inner.end === trimmed.length`) so
  that `` `the formula $x$ is...` `` stays as code while
  `` `$x$` `` renders.

## Non-decisions (deliberately out of scope)

- We do NOT pre-process model output to wrap unwrapped LaTeX. If the
  model writes `\mathbb{E}_{x}[f(x)]` without delimiters, that's a
  prompt issue, not a renderer issue.
- We do NOT support custom `\newcommand` or AMS environments beyond
  what KaTeX ships with.
- We do NOT render math inside fenced code blocks (` ``` `). Those
  are handled at the block level and intentionally bypass math
  detection — they exist for showing LaTeX source as text.
