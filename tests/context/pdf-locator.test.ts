import { describe, expect, it } from "vitest";
import { createPdfLocator } from "../../src/context/pdf-locator";

interface FakeTextItem {
  str: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface FakeProcessedChar {
  c: string;
  rect: [number, number, number, number];
  inlineRect: [number, number, number, number];
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
}

describe("pdf locator", () => {
  it("exposes full text from the same PDF.js text layer used for locating", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [item("First page text", 0, 100)],
        [item("Second page text", 0, 100)],
      ]),
    );

    await expect(locator.getFullText()).resolves.toBe(
      "First page text\nSecond page text",
    );
  });

  it("locates an exact passage and returns page rects", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [item("Alpha", 0, 100), item("beta", 60, 100), item("tail", 0, 80)],
      ]),
    );

    const result = await locator.locate("Alpha beta");

    expect(result).toMatchObject({
      pageIndex: 0,
      pageLabel: "1",
      matchedText: "Alpha beta",
      confidence: 1,
    });
    expect(result?.rects).toEqual([[0, 100, 100, 110]]);
    expect(result?.sortIndex).toMatch(/^00000\|000000\|00110$/);
  });

  it("returns one rect per line for cross-line matches", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [
          item("Alpha", 0, 100),
          item("beta", 60, 100, { hasEOL: true }),
          item("Gamma", 0, 80),
          item("delta", 70, 80),
        ],
      ]),
    );

    const result = await locator.locate("beta Gamma");

    expect(result?.rects).toEqual([
      [60, 100, 100, 110],
      [0, 80, 50, 90],
    ]);
  });

  it("keeps column-break matches as separate precise rects", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [
          item("unrelated left top", 0, 720),
          item("autonomous driving. Extensive experiments are con-", 0, 100, {
            hasEOL: true,
            width: 240,
          }),
          item(
            "ducted with Waymo-4DSeg and unseen dataset under dif-",
            300,
            720,
            { hasEOL: true, width: 240 },
          ),
          item("ferent challenging settings.", 300, 700, { width: 180 }),
        ],
      ]),
    );

    const result = await locator.locate(
      "Extensive experiments are conducted with Waymo-4DSeg and unseen dataset under different challenging settings.",
    );

    expect(result?.rects).toHaveLength(3);
    // No returned rect may span from the left column into the right column.
    expect(result?.rects.some((rect) => rect[0] < 200 && rect[2] > 280)).toBe(
      false,
    );
    expect(result?.rects.every((rect) => rect[2] - rect[0] < 260)).toBe(true);
    expect(result?.matchedText).toContain("Extensive experiments");
  });

  it("uses normalized substring matching for full-width text", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("Ｆｉｅｌｄ result", 0, 100)]]),
    );

    const result = await locator.locate("field result");

    expect(result?.confidence).toBe(1);
    expect(result?.matchedText).toBe("Ｆｉｅｌｄ result");
  });

  it("falls back to fuzzy matching when one character differs", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("The critical results are stable.", 0, 100)]]),
    );

    const result = await locator.locate("The critical result are stable.");

    expect(result?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result?.matchedText).toContain("critical results");
  });

  it("returns null when the best fuzzy match is below the threshold", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("alpha beta gamma", 0, 100)]]),
    );

    await expect(
      locator.locate("unrelated theorem statement"),
    ).resolves.toBeNull();
  });

  it("matches PDF line-break hyphenation", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [
          item("pre-", 0, 100, { hasEOL: true }),
          item("fix improves retrieval", 0, 80),
        ],
      ]),
    );

    const result = await locator.locate("prefix improves");

    expect(result?.matchedText).toContain("pre-");
    expect(result?.rects).toHaveLength(2);
  });

  it("matches common ligatures", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("\ufb01eld evidence", 0, 100)]]),
    );

    const result = await locator.locate("field evidence");

    expect(result?.confidence).toBe(1);
    expect(result?.matchedText).toBe("\ufb01eld evidence");
  });

  it("can read PDFViewerApplication through wrappedJSObject", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("wrapped window text", 0, 100)]], {
        wrapped: true,
      }),
    );

    await expect(locator.getFullText()).resolves.toBe("wrapped window text");
  });

  it("can read loaded pages from pdfViewer page views", async () => {
    const locator = await createPdfLocator(
      readerWithPages([[item("page view text", 0, 100)]], {
        pageViewOnly: true,
      }),
    );

    await expect(locator.getFullText()).resolves.toBe("page view text");
  });

  it("prefers Zotero processed page data for text and rects", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages([
        processedPage([
          ...processedWord("Alpha", 0, 100, { spaceAfter: true }),
          ...processedWord("beta", 60, 100),
        ]),
      ]),
    );

    await expect(locator.getFullText()).resolves.toBe("Alpha beta");
    const result = await locator.locate("Alpha beta");

    expect(result).toMatchObject({
      pageIndex: 0,
      pageLabel: "1",
      matchedText: "Alpha beta",
      confidence: 1,
    });
    expect(result?.rects).toEqual([[0, 100, 100, 110]]);
    expect(result?.sortIndex).toBe("00000|000000|00690");
  });

  it("falls back to Zotero getPageData when processed pages are not cached", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages(
        [processedPage([...processedWord("fallback", 0, 100)])],
        { lazyPageData: true },
      ),
    );

    await expect(locator.getFullText()).resolves.toBe("fallback");
  });
});

function item(
  str: string,
  x: number,
  y: number,
  opts: Partial<FakeTextItem> = {},
): FakeTextItem {
  return {
    str,
    x,
    y,
    width: opts.width ?? str.length * 10,
    height: opts.height ?? 10,
    hasEOL: opts.hasEOL,
  };
}

function processedWord(
  text: string,
  x: number,
  y: number,
  opts: { spaceAfter?: boolean; lineBreakAfter?: boolean } = {},
): FakeProcessedChar[] {
  return Array.from(text).map((char, index, chars) => {
    const charX = x + index * 10;
    return {
      c: char,
      rect: [charX, y, charX + 10, y + 10],
      inlineRect: [charX, y, charX + 10, y + 10],
      spaceAfter: opts.spaceAfter && index === chars.length - 1,
      lineBreakAfter: opts.lineBreakAfter && index === chars.length - 1,
    };
  });
}

function processedPage(chars: FakeProcessedChar[]) {
  return {
    chars,
    viewBox: [0, 0, 600, 800],
  };
}

function readerWithPages(
  pages: FakeTextItem[][],
  options: { wrapped?: boolean; pageViewOnly?: boolean } = {},
): unknown {
  const pdfDocument = {
    numPages: pages.length,
    getPageLabels: async () => pages.map((_, index) => String(index + 1)),
    getPage: async (pageNumber: number) => ({
      getTextContent: async () => ({
        items: pages[pageNumber - 1].map((entry) => ({
          str: entry.str,
          hasEOL: entry.hasEOL,
          transform: [1, 0, 0, entry.height ?? 10, entry.x, entry.y],
          width: entry.width,
          height: entry.height,
        })),
      }),
    }),
  };
  const pdfViewer = {
    pagesCount: pages.length,
    getPageView: (pageIndex: number) => ({
      pdfPage: {
        getTextContent: async () => ({
          items: pages[pageIndex].map((entry) => ({
            str: entry.str,
            hasEOL: entry.hasEOL,
            transform: [1, 0, 0, entry.height ?? 10, entry.x, entry.y],
            width: entry.width,
            height: entry.height,
          })),
        }),
      },
    }),
  };
  const app = options.pageViewOnly ? { pdfViewer } : { pdfDocument, pdfViewer };
  const iframeWindow = options.wrapped
    ? { wrappedJSObject: { PDFViewerApplication: app } }
    : { PDFViewerApplication: app };
  return {
    itemID: 2,
    _item: { id: 2, parentID: 1 },
    _internalReader: {
      _primaryView: {
        _iframeWindow: iframeWindow,
      },
    },
  };
}

function readerWithProcessedPages(
  pages: ReturnType<typeof processedPage>[],
  options: { lazyPageData?: boolean } = {},
): unknown {
  const pdfDocument = {
    numPages: pages.length,
    getPageLabels2: async () => pages.map((_, index) => String(index + 1)),
    getProcessedData: async () => ({
      pages: options.lazyPageData
        ? {}
        : Object.fromEntries(pages.map((page, index) => [String(index), page])),
    }),
    getPageData: async ({ pageIndex }: { pageIndex: number }) =>
      pages[pageIndex],
    getPage: async () => ({
      getTextContent: async () => ({
        items: [{ str: "raw fallback should not be used" }],
      }),
    }),
  };
  return {
    itemID: 2,
    _item: { id: 2, parentID: 1 },
    _internalReader: {
      _primaryView: {
        _pdfPages: options.lazyPageData
          ? {}
          : Object.fromEntries(
              pages.map((page, index) => [String(index), page]),
            ),
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument,
            pdfViewer: { pagesCount: pages.length },
          },
        },
      },
    },
  };
}
