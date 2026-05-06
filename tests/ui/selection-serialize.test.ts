// Verify the selection serializer produces clean Markdown for the chat
// content shapes we actually emit (paragraphs + display math + bullet
// list with inline-math wrappers). The user-reported failure mode was
// that selecting prose + display math + a trailing paragraph dropped
// the trailing paragraph after a paste — so we test that explicit shape.

import { describe, expect, it } from "vitest";
import { serializeSelectionAsMarkdown } from "../../src/ui/selection-serialize";

function selectAll(root: HTMLElement): Selection {
  const range = root.ownerDocument!.createRange();
  range.selectNodeContents(root);
  const sel = root.ownerDocument!.defaultView!.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe("serializeSelectionAsMarkdown", () => {
  it("preserves prose + display math + trailing paragraph", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>这是一个用于训练/优化模型的期望损失函数。</p>
      <div class="math-display" data-latex="\\mathbb{E}_{\\mathcal D,\\tau,\\omega} [H(x_{1:M})]" data-display="true">
        <span class="katex-display">…rendered…</span>
      </div>
      <p>可以逐项解释。</p>
    `;
    document.body.append(root);
    const sel = selectAll(root);
    const md = serializeSelectionAsMarkdown(sel);
    root.remove();

    expect(md).toContain("这是一个用于训练/优化模型的期望损失函数。");
    expect(md).toContain(
      "$$\\mathbb{E}_{\\mathcal D,\\tau,\\omega} [H(x_{1:M})]$$",
    );
    expect(md).toContain("可以逐项解释。");

    // Display math must be on its own paragraph (blank lines on both
    // sides) — this is the bug we're guarding against.
    expect(md).toMatch(/\n\n\$\$.*?\$\$\n\n/s);
  });

  it("preserves bullet list with inline math wrappers", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <ul>
        <li><span class="math-inline" data-latex="\\mathbb{E}[\\cdot]" data-display="false">𝔼[·]</span>: 表示对数据集取期望。</li>
        <li>第二条: 损失函数。</li>
      </ul>
    `;
    document.body.append(root);
    const sel = selectAll(root);
    const md = serializeSelectionAsMarkdown(sel);
    root.remove();

    expect(md).toContain("- $\\mathbb{E}[\\cdot]$: 表示对数据集取期望。");
    expect(md).toContain("- 第二条: 损失函数。");
  });

  it("returns the whole LaTeX source when selection is inside a math wrapper", () => {
    const root = document.createElement("div");
    root.innerHTML = `<span class="math-inline" data-latex="x^2 + y^2" data-display="false">x²+y²</span>`;
    document.body.append(root);
    // Select only part of the rendered glyphs inside the wrapper.
    const inner = root.querySelector(".math-inline")!.firstChild!;
    const range = document.createRange();
    range.setStart(inner, 0);
    range.setEnd(inner, Math.min(2, inner.textContent?.length ?? 0));
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const md = serializeSelectionAsMarkdown(sel);
    root.remove();

    expect(md).toBe("$x^2 + y^2$");
  });

  it("emits one formula when selection starts inside KaTeX and continues after it", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>前文。</p>
      <div class="math-display" data-latex="E = mc^2" data-display="true">
        <span class="katex">
          <span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow></semantics></math></span>
          <span class="katex-html"><span class="mord">E</span><span class="mrel">=</span><span class="mord">mc²</span></span>
        </span>
      </div>
      <p>后文。</p>
    `;
    document.body.append(root);

    const htmlText = root.querySelector(".katex-html .mord")!.firstChild!;
    const trailingText = root.querySelectorAll("p")[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(htmlText, 0);
    range.setEnd(trailingText, trailingText.textContent!.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const md = serializeSelectionAsMarkdown(sel);
    root.remove();

    expect(md.match(/\$\$E = mc\^2\$\$/g)).toHaveLength(1);
    expect(md).toContain("后文。");
    expect(md).not.toContain("mc²");
  });

  it("serializes every range Firefox may expose for a discontinuous selection", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>第一段。</p>
      <p>第二段。</p>
    `;
    document.body.append(root);

    const first = root.querySelectorAll("p")[0]!.firstChild!;
    const second = root.querySelectorAll("p")[1]!.firstChild!;
    const firstRange = document.createRange();
    firstRange.selectNodeContents(first);
    const secondRange = document.createRange();
    secondRange.selectNodeContents(second);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index: number) => (index === 0 ? firstRange : secondRange),
    } as Selection;

    const md = serializeSelectionAsMarkdown(fakeSelection);
    root.remove();

    expect(md).toContain("第一段。");
    expect(md).toContain("第二段。");
  });

  it("deduplicates the same formula across Firefox-style overlapping ranges", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>前文。</p>
      <div class="math-display" data-latex="E = mc^2" data-display="true">
        <span class="katex">
          <span class="katex-html"><span class="mord">E</span></span>
          <svg><path /></svg>
        </span>
      </div>
      <p>后文。</p>
    `;
    document.body.append(root);

    const beforeText = root.querySelectorAll("p")[0]!.firstChild!;
    const htmlText = root.querySelector(".katex-html .mord")!.firstChild!;
    const svg = root.querySelector("svg")!;
    const trailingText = root.querySelectorAll("p")[1]!.firstChild!;

    const firstRange = document.createRange();
    firstRange.setStart(beforeText, 0);
    firstRange.setEnd(svg, 0);

    const mathOnlyRange = document.createRange();
    mathOnlyRange.setStart(htmlText, 0);
    mathOnlyRange.setEnd(htmlText, htmlText.textContent!.length);

    const trailingRange = document.createRange();
    trailingRange.setStart(htmlText, 0);
    trailingRange.setEnd(trailingText, trailingText.textContent!.length);

    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 3,
      getRangeAt: (index: number) =>
        [firstRange, mathOnlyRange, trailingRange][index]!,
    } as Selection;

    const md = serializeSelectionAsMarkdown(fakeSelection);
    root.remove();

    expect(md.match(/\$\$E = mc\^2\$\$/g)).toHaveLength(1);
    expect(md).toContain("前文。");
    expect(md).toContain("后文。");
  });
});
