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
    expect(result?.sortIndex).toMatch(/^00000\|000000\|00690$/);
  });

  it("can restrict locate to a specific page", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [item("Repeated sentence.", 0, 100)],
        [item("Repeated sentence.", 0, 200)],
      ]),
    );

    const result = await locator.locate("Repeated sentence.", { pageIndex: 1 });

    expect(result?.pageIndex).toBe(1);
    expect(result?.rects).toEqual([[0, 200, 180, 210]]);
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

  it("extracts selected text from annotation rects without crossing columns", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [
          item(
            "left column unrelated text should never leak into selection",
            0,
            720,
            { width: 380 },
          ),
          item(
            "right column selected text starts on this visual line",
            410,
            100,
            { hasEOL: true, width: 360 },
          ),
          item(
            "continues on the next selected line",
            410,
            80,
            { hasEOL: true, width: 360 },
          ),
          item("and ends on the final selected line.", 410, 60, {
            width: 260,
          }),
        ],
      ]),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [
        [410, 100, 770, 110],
        [410, 80, 770, 90],
        [410, 60, 670, 70],
      ],
    });

    expect(text).toContain("right column selected text starts");
    expect(text).toContain("final selected line");
    expect(text).not.toContain("left column unrelated");
  });

  it("prefers vertically flipped Zotero annotation rect text", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages([
        processedPage([
          ...processedWord("wrong direct line", 0, 200, {
            lineBreakAfter: true,
          }),
          ...processedWord("selected flipped line", 0, 590, {
            lineBreakAfter: true,
          }),
        ]),
      ]),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [
        [0, 200, 220, 210],
        [0, 185, 220, 195],
      ],
    });

    expect(text).toContain("selected flipped line");
    expect(text).not.toContain("wrong direct line");
  });

  it("uses the PDF document view box when processed page data omits it", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages([
        processedPageWithoutViewBox([
          ...processedWord("wrong direct line", 0, 200, {
            lineBreakAfter: true,
          }),
          ...processedWord("selected flipped line", 0, 590, {
            lineBreakAfter: true,
          }),
        ]),
      ]),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [[0, 200, 220, 210]],
    });

    expect(text).toContain("selected flipped line");
    expect(text).not.toContain("wrong direct line");
  });

  it("reads the view box from pdfViewer.pdfDocument for processed view pages", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages(
        [
          processedPageWithoutViewBox([
            ...processedWord("wrong direct line", 0, 200, {
              lineBreakAfter: true,
            }),
            ...processedWord("selected flipped line", 0, 590, {
              lineBreakAfter: true,
            }),
          ]),
        ],
        { viewerDocumentOnly: true },
      ),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [[0, 200, 220, 210]],
    });

    expect(text).toContain("selected flipped line");
    expect(text).not.toContain("wrong direct line");
  });

  it("reads the view box from cached reader page views", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages(
        [
          processedPageWithoutViewBox([
            ...processedWord("wrong direct line", 0, 200, {
              lineBreakAfter: true,
            }),
            ...processedWord("selected flipped line", 0, 590, {
              lineBreakAfter: true,
            }),
          ]),
        ],
        { noDocument: true, readerPageViewBox: true },
      ),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [[0, 200, 220, 210]],
    });

    expect(text).toContain("selected flipped line");
    expect(text).not.toContain("wrong direct line");
  });

  it("flips annotation rects when using the PDF.js text layer", async () => {
    const locator = await createPdfLocator(
      readerWithPages([
        [
          item("wrong direct line", 0, 200, { hasEOL: true }),
          item("selected flipped line", 0, 590, { hasEOL: true }),
        ],
      ]),
    );

    const text = await locator.extractTextFromPosition({
      pageIndex: 0,
      rects: [[0, 200, 220, 210]],
    });

    expect(text).toContain("selected flipped line");
    expect(text).not.toContain("wrong direct line");
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

  it("does not merge sentences across decimal model names", async () => {
    const text =
      "We describe π0.5, a new model. π0.5 uses data. Our system works.";
    const locator = await createPdfLocator(
      readerWithProcessedPages([processedPage(processedWord(text, 0, 100))]),
    );

    const hit = await locator.sentenceAtPoint?.(0, {
      x: text.indexOf("uses") * 10 + 5,
      y: 105,
    });

    expect(hit?.text).toBe("π0.5 uses data.");
    expect(hit?.pageSentenceIndex).toBe(1);
    expect(hit?.pageSentenceCount).toBe(3);
  });

  it("splits processed text using Zotero spaceAfter word gaps", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages([
        processedPage([
          ...processedWord("First", 0, 100, { spaceAfter: true }),
          ...processedWord("sentence.", 60, 100, { spaceAfter: true }),
          ...processedWord("Second", 180, 100, { spaceAfter: true }),
          ...processedWord("sentence.", 260, 100),
        ]),
      ]),
    );

    const hit = await locator.sentenceAtPoint?.(0, { x: 185, y: 105 });

    expect(hit?.text).toBe("Second sentence.");
    expect(hit?.pageSentenceIndex).toBe(1);
    expect(hit?.pageSentenceCount).toBe(2);
  });

  it("keeps a sentence together across a column continuation", async () => {
    const locator = await createPdfLocator(
      readerWithProcessedPages([
        processedPage([
          ...processedWord("First sentence.", 0, 120, {
            lineBreakAfter: true,
          }),
          ...processedWord("Our experiments show long-", 0, 100, {
            lineBreakAfter: true,
          }),
          ...processedWord("horizon skills.", 300, 720, {
            lineBreakAfter: true,
          }),
        ]),
      ]),
    );

    const hit = await locator.sentenceAtPoint?.(0, {
      x: 300 + "horizon".length * 5,
      y: 725,
    });

    expect(hit?.text).toBe("Our experiments show long- horizon skills.");
    expect(hit?.pageSentenceIndex).toBe(1);
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

function processedPageWithoutViewBox(
  chars: FakeProcessedChar[],
): ReturnType<typeof processedPage> {
  return { chars } as ReturnType<typeof processedPage>;
}

function readerWithPages(
  pages: FakeTextItem[][],
  options: { wrapped?: boolean; pageViewOnly?: boolean } = {},
): unknown {
  const pdfDocument = {
    numPages: pages.length,
    getPageLabels: async () => pages.map((_, index) => String(index + 1)),
    getPage: async (pageNumber: number) => ({
      view: [0, 0, 600, 800],
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
        view: [0, 0, 600, 800],
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
  options: {
    lazyPageData?: boolean;
    noDocument?: boolean;
    readerPageViewBox?: boolean;
    viewerDocumentOnly?: boolean;
  } = {},
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
      view: [0, 0, 600, 800],
      getTextContent: async () => ({
        items: [{ str: "raw fallback should not be used" }],
      }),
    }),
  };
  const pdfViewer = options.viewerDocumentOnly
    ? { pagesCount: pages.length, pdfDocument }
    : { pagesCount: pages.length };
  const app = options.noDocument
    ? { pdfViewer }
    : options.viewerDocumentOnly
    ? { pdfViewer }
    : {
        pdfDocument,
        pdfViewer,
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
        _pages: options.readerPageViewBox
          ? pages.map(() => ({
              originalPage: { viewport: { viewBox: [0, 0, 600, 800] } },
            }))
          : undefined,
        _iframeWindow: {
          PDFViewerApplication: app,
        },
      },
    },
  };
}
