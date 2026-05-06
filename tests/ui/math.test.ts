// Behavioral spec for findNextMathRegion. These tests will FAIL until the
// stub in src/ui/math.ts is implemented. Iterate against `npm test -- math`.

import { describe, expect, it } from "vitest";
import { findNextMathRegion, renderMathInto } from "../../src/ui/math";

describe("findNextMathRegion — display delimiters", () => {
  it("matches \\[ ... \\]", () => {
    expect(findNextMathRegion("a \\[ x \\] b", 0)).toEqual({
      start: 2,
      end: 9,
      latex: " x ",
      display: true,
    });
  });

  it("matches $$ ... $$", () => {
    expect(findNextMathRegion("a $$x = 1$$ b", 0)).toEqual({
      start: 2,
      end: 11,
      latex: "x = 1",
      display: true,
    });
  });

  it("matches multi-line \\[ ... \\] (no blank line inside)", () => {
    const text = "\\[\nE = mc^2\n\\]";
    const region = findNextMathRegion(text, 0);
    expect(region).not.toBeNull();
    expect(region!.display).toBe(true);
    expect(region!.latex.trim()).toBe("E = mc^2");
  });

  it("returns null for unclosed \\[ (streaming-safe)", () => {
    expect(findNextMathRegion("open: \\[ x = 1", 0)).toBeNull();
  });

  it("returns null for unclosed $$ (streaming-safe)", () => {
    expect(findNextMathRegion("a $$x = 1", 0)).toBeNull();
  });
});

describe("findNextMathRegion — inline delimiters", () => {
  it("matches \\( ... \\)", () => {
    expect(findNextMathRegion("a \\( y \\) b", 0)).toEqual({
      start: 2,
      end: 9,
      latex: " y ",
      display: false,
    });
  });

  it("returns null for unclosed \\(", () => {
    expect(findNextMathRegion("open: \\( y", 0)).toBeNull();
  });
});

describe("findNextMathRegion — earliest-region semantics", () => {
  it("returns the FIRST closed region, not later ones", () => {
    const region = findNextMathRegion("\\(a\\) and \\(b\\)", 0);
    expect(region).not.toBeNull();
    expect(region!.latex).toBe("a");
  });

  it("respects the cursor argument", () => {
    const text = "\\(a\\) and \\(b\\)";
    const second = findNextMathRegion(text, 5);
    expect(second).not.toBeNull();
    expect(second!.latex).toBe("b");
  });
});

// === Single-$ behavior — your design choice. ===
//
// Pick ONE of the two contracts below and delete the other describe block:
//
//   Contract A (recommended): honor $...$ with prose-safety guards.
//     - opening $ followed by non-space
//     - closing $ preceded by non-space
//     - body has no newline
//     - char before opening $ is not a digit (rejects "earned $5")
//
//   Contract B: don't honor single-$ at all (require \( ... \)).
//
// The two `describe.skip` blocks below show the expectations for each.
// Un-skip whichever matches your choice.

describe("findNextMathRegion — single-$ contract A (with guards)", () => {
  it("matches inline $x^2$", () => {
    expect(findNextMathRegion("a $x^2$ b", 0)).toEqual({
      start: 2,
      end: 7,
      latex: "x^2",
      display: false,
    });
  });

  it("rejects '$5 and $10' (digit before opening $)", () => {
    expect(findNextMathRegion("got $5 and $10", 0)).toBeNull();
  });

  it("rejects '$ x $' (space-padded delimiters)", () => {
    expect(findNextMathRegion("a $ x $ b", 0)).toBeNull();
  });

  it("rejects $...$ that crosses a newline", () => {
    expect(findNextMathRegion("a $x\ny$ b", 0)).toBeNull();
  });
});

describe.skip("findNextMathRegion — single-$ contract B (ignore single-$)", () => {
  it("does NOT match $x^2$", () => {
    expect(findNextMathRegion("a $x^2$ b", 0)).toBeNull();
  });

  it("still matches $$x$$ (display)", () => {
    expect(findNextMathRegion("a $$x$$ b", 0)).not.toBeNull();
  });
});

describe("renderMathInto — source mode", () => {
  it("stores display math in Zotero's official note schema", () => {
    const root = document.createElement("div");
    renderMathInto(
      root,
      { start: 0, end: 10, latex: "E = mc^2", display: true },
      "source",
    );

    const math = root.firstElementChild as HTMLElement;
    expect(math.tagName).toBe("PRE");
    expect(math.className).toBe("math");
    expect(math.textContent).toBe("$$E = mc^2$$");
  });

  it("stores inline math in Zotero's official note schema", () => {
    const root = document.createElement("div");
    renderMathInto(
      root,
      { start: 0, end: 7, latex: "x^2", display: false },
      "source",
    );

    const math = root.firstElementChild as HTMLElement;
    expect(math.tagName).toBe("SPAN");
    expect(math.className).toBe("math");
    expect(math.textContent).toBe("$x^2$");
  });
});
