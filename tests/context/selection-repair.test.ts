import { describe, expect, it } from "vitest";
import { resolveSelectedTextFromPdfText } from "../../src/context/selection-repair";

describe("selection repair", () => {
  it("normalizes PDF line-break hyphenation when the selection exists in full text", () => {
    const pdfText =
      "The selected paragraph starts in environments and ends correctly.";
    const selectedText =
      "The selected paragraph starts in environ-\nments and ends correctly.";

    expect(resolveSelectedTextFromPdfText(selectedText, pdfText)).toBe(pdfText);
  });

  it("repairs a cross-column insertion by matching the selected sentence prefix", () => {
    const pdfText = [
      "Left column text should not leak into the selected sentence.",
      "The selected paragraph starts in environments and ends correctly.",
      "Another sentence follows the selected sentence.",
    ].join(" ");
    const selectedText =
      "The selected paragraph starts in environleft column text should not leak";

    expect(resolveSelectedTextFromPdfText(selectedText, pdfText)).toBe(
      "The selected paragraph starts in environments and ends correctly.",
    );
  });

  it("prefers nearby passages before searching the full PDF", () => {
    const selectedText =
      "The repeated selected sentence starts in environwrong inserted text";
    const pdfText = [
      "The repeated selected sentence starts in environments near the start.",
      "The repeated selected sentence starts in environments near the target.",
    ].join(" ");

    expect(
      resolveSelectedTextFromPdfText(selectedText, pdfText, [
        {
          text: "The repeated selected sentence starts in environments near the target.",
          start: 100,
          end: 165,
          score: 1,
        },
      ]),
    ).toBe(
      "The repeated selected sentence starts in environments near the target.",
    );
  });
});
