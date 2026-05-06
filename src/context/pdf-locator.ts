// Locator that maps a verbatim text passage to PDF coordinates so we can
// write a Zotero highlight at the correct rectangle.
//
// Why this file is hard:
// 1. Zotero exposes TWO PDF text APIs we have to support:
//    - "processed" (Zotero 8/9): char-level data with rects and break flags.
//    - "textContent" (PDF.js fallback): item-level strings with transforms,
//      no per-char rects — we synthesize them by interpolating x within
//      each item's width.
// 2. The PDF text we match against is normalized (lowercased, ligatures
//    expanded, hyphen-line-breaks collapsed, whitespace coalesced). We must
//    map normalized offsets back to ORIGINAL char offsets to extract rects
//    accurately. That's `normalizeWithMap` + `originalRangeFromNormalized`.
// 3. Match runs in two stages per page: exact substring in normalized text,
//    falling back to a Levenshtein fuzzy scan with stride = needle/4. We
//    never claim a hit below `minConfidence` (default 0.85).
// 4. Annotations in Zotero sort by a "pageIndex|offset|topY" string. The
//    semantics of `offset` differ between the two text-source paths — see
//    `sortOffsetForRange`.
//
// REF: Zotero source `Zotero.Annotations.saveFromJSON`, PDF.js
//      `getTextContent`, Zotero pdf-reader `_pdfPages` / `getProcessedData`.

export type PdfRect = [number, number, number, number];

export interface LocateResult {
  pageIndex: number;
  pageLabel: string;
  rects: PdfRect[];
  sortIndex: string;
  matchedText: string;
  confidence: number;
}

export interface PdfLocator {
  attachmentID: number;
  getFullText(): Promise<string>;
  extractTextFromPosition(position: unknown): Promise<string>;
  locate(
    needle: string,
    opts?: { minConfidence?: number },
  ): Promise<LocateResult | null>;
  dispose(): void;
}

interface PdfDocumentLike {
  numPages?: number;
  pdfInfo?: { numPages?: number };
  _pdfInfo?: { numPages?: number };
  getPage?(pageNumber: number): Promise<PdfPageLike>;
  getPageLabels?(): Promise<Array<string | null> | null>;
  getPageLabels2?(): Promise<Array<string | null> | null>;
  getProcessedData?(): Promise<{ pages?: ProcessedPageCollection }>;
  getPageData?(options: { pageIndex: number }): Promise<ProcessedPageLike>;
}

interface PdfPageLike {
  getTextContent(options?: {
    disableCombineTextItems?: boolean;
  }): Promise<{ items?: PdfTextItemLike[] }>;
}

interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

interface ItemAnchor {
  itemIndex: number;
  pageIndex: number;
  startOffset: number;
  endOffset: number;
  x: number;
  y: number;
  width: number;
  height: number;
  itemString: string;
  lineBreakAfter?: boolean;
  source?: "textContent" | "processed";
}

interface PageBundle {
  pageIndex: number;
  pageLabel: string;
  pageText: string;
  anchors: ItemAnchor[];
  normalizedText: string;
  normalizedToOriginal: number[];
  viewBox?: PdfRect;
  source?: "textContent" | "processed";
}

interface NormalizedText {
  text: string;
  map: number[];
}

interface NormalizedMatch {
  page: PageBundle;
  normalizedStart: number;
  normalizedEnd: number;
  confidence: number;
}

interface PdfPageSource {
  pageCount: number;
  getPage?(pageIndex: number): Promise<PdfPageLike>;
  getPageBundle?(
    pageIndex: number,
    pageLabel: string,
  ): Promise<PageBundle | null>;
  getPageLabels(): Promise<string[]>;
}

type ProcessedPageCollection =
  | Record<string, ProcessedPageLike | undefined>
  | Array<ProcessedPageLike | undefined>;

interface ProcessedPageLike {
  chars?: ProcessedCharLike[];
  viewBox?: unknown;
}

interface ProcessedCharLike {
  c?: string;
  u?: string;
  rect?: unknown;
  inlineRect?: unknown;
  ignorable?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
  wordBreakAfter?: boolean;
}

// Tuning constants. INVARIANT: changes here must be re-validated against
// real PDFs (small-font 2-col papers expose Y-grouping bugs first).
const DEFAULT_MIN_CONFIDENCE = 0.85;
// LINE_Y_TOLERANCE is in PDF user-space units: items whose y differs by
// ≤2 are treated as the same visual line. Loose enough for descender drift,
// tight enough to keep adjacent lines separate at body font sizes.
const LINE_Y_TOLERANCE = 2;
const SELECTION_RECT_TOLERANCE = 2;
// Reader can be polled for up to 5s before its iframe has a pdfDocument.
// GOTCHA: opening a tab via `Zotero.Reader.open` resolves before the PDF.js
// viewer is ready; we MUST wait, not throw immediately.
const PDF_SOURCE_WAIT_MS = 5000;
const PDF_SOURCE_POLL_MS = 120;
// Common Latin ligatures the PDF text layer emits as single codepoints.
// Expanded BEFORE matching so a needle "office" finds "oﬃce".
const LIGATURES: Record<string, string> = {
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

export async function createPdfLocator(reader: unknown): Promise<PdfLocator> {
  const source = await waitForPdfSource(reader);
  if (!source) {
    throw new Error(
      "No PDF document is available from the active Zotero Reader.",
    );
  }

  const attachmentID = extractAttachmentID(reader);
  if (attachmentID == null) {
    throw new Error(
      "No PDF attachment ID is available from the active Zotero Reader.",
    );
  }

  // Page bundles are loaded lazily and memoized as PROMISES (not values),
  // so two concurrent locate() calls share one extraction pass per page.
  // INVARIANT: never re-extract a page — the textContent / processed
  // results are not guaranteed to be identical across calls.
  const bundles = new Map<number, Promise<PageBundle | null>>();
  const pageLengths = new Map<number, number>();
  const pageLabels = await source.getPageLabels();

  const bundleFor = (pageIndex: number): Promise<PageBundle | null> => {
    const existing = bundles.get(pageIndex);
    if (existing) return existing;
    const bundle = readPageBundle(source, pageIndex, pageLabels[pageIndex])
      .then((page) => {
        if (page) pageLengths.set(pageIndex, page.pageText.length);
        return page;
      })
      .catch(() => null);
    bundles.set(pageIndex, bundle);
    return bundle;
  };

  // Sum of pageText lengths for pages [0, pageIndex). Used by the
  // textContent source to build a document-wide sort offset (Zotero needs
  // this so annotations sort in reading order across pages).
  const cumulativeOffset = async (pageIndex: number): Promise<number> => {
    let offset = 0;
    for (let index = 0; index < pageIndex; index++) {
      if (!pageLengths.has(index)) {
        await bundleFor(index);
      }
      offset += pageLengths.get(index) ?? 0;
    }
    return offset;
  };

  return {
    attachmentID,
    async getFullText() {
      const pages: string[] = [];
      for (let pageIndex = 0; pageIndex < source.pageCount; pageIndex++) {
        const page = await bundleFor(pageIndex);
        if (page?.pageText) pages.push(page.pageText.trimEnd());
      }
      return pages.join("\n");
    },
    async extractTextFromPosition(position) {
      const groups = selectionRectGroups(position);
      const pages: string[] = [];
      for (const group of groups) {
        const page = await bundleFor(group.pageIndex);
        if (!page) continue;
        const text = extractPageTextFromSelectionRects(page, group.rects);
        if (text) pages.push(text);
      }
      return pages.join("\n");
    },
    // Two-stage match. WHY two stages: most model-supplied passages match
    // verbatim (they were copied from getFullText output), so an O(N) page
    // scan with `indexOf` finds them fast. We only fall back to the O(N·k)
    // fuzzy stage for the minority of cases where ligatures / dehyphenation
    // / column-break artifacts perturb the text.
    //
    // Exact match returns immediately on the first page that contains the
    // needle. Fuzzy match scans ALL pages and picks the highest-confidence
    // window above `minConfidence` — never a same-page early-exit, because
    // a low-confidence early page can mask a high-confidence later page.
    async locate(needle, opts) {
      const normalizedNeedle = normalizeWithMap(needle).text;
      if (!normalizedNeedle) return null;

      const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
      let bestFuzzy: NormalizedMatch | null = null;
      for (let pageIndex = 0; pageIndex < source.pageCount; pageIndex++) {
        const page = await bundleFor(pageIndex);
        if (!page || !page.normalizedText) continue;

        const exactIndex = page.normalizedText.indexOf(normalizedNeedle);
        if (exactIndex >= 0) {
          return locateOnPage(
            page,
            exactIndex,
            exactIndex + normalizedNeedle.length,
            1,
            await cumulativeOffset(pageIndex),
          );
        }

        const fuzzy = fuzzyNormalizedMatch(page, normalizedNeedle);
        if (
          fuzzy &&
          fuzzy.confidence >= minConfidence &&
          (!bestFuzzy || fuzzy.confidence > bestFuzzy.confidence)
        ) {
          bestFuzzy = fuzzy;
        }
      }

      if (!bestFuzzy) return null;
      return locateOnPage(
        bestFuzzy.page,
        bestFuzzy.normalizedStart,
        bestFuzzy.normalizedEnd,
        bestFuzzy.confidence,
        await cumulativeOffset(bestFuzzy.page.pageIndex),
      );
    },
    dispose() {
      bundles.clear();
      pageLengths.clear();
    },
  };
}

async function waitForPdfSource(
  reader: unknown,
): Promise<PdfPageSource | null> {
  const started = Date.now();
  let source = extractPdfSource(reader);
  while (!source && Date.now() - started < PDF_SOURCE_WAIT_MS) {
    await delay(PDF_SOURCE_POLL_MS);
    source = extractPdfSource(reader);
  }
  return source;
}

// Walks the Zotero Reader object graph looking for any PDF text source.
// GOTCHA: Zotero 7/8/9 expose this differently and even pre-release builds
// switch between `_internalReader._primaryView` and direct `_iframeWindow`.
// We try every shape we know and take the first that yields pageCount > 0.
// REF: Zotero source `chrome/content/zotero/elements/reader.js`.
function extractPdfSource(reader: unknown): PdfPageSource | null {
  const r = reader as any;
  const views = [
    r?._internalReader?._primaryView,
    r?._internalReader?._secondaryView,
  ].filter(Boolean);
  const windows = [
    ...views.map((view) => view?._iframeWindow),
    r?._internalReader?._iframeWindow,
    r?._iframeWindow,
  ];
  const apps = windows.flatMap((win) => pdfViewerApplications(win));

  return firstPdfSource([
    ...views.map((view) => processedViewSource(view)),
    ...apps.flatMap((app) => [
      processedDocumentSource(
        app?.pdfDocument,
        numberValue(app?.pdfViewer?.pagesCount),
      ),
      processedDocumentSource(
        app?.pdfViewer?.pdfDocument,
        numberValue(app?.pdfViewer?.pagesCount),
      ),
      documentSource(app?.pdfDocument),
      documentSource(app?.pdfViewer?.pdfDocument),
      pageViewSource(app?.pdfViewer),
    ]),
  ]);
}

function pdfViewerApplications(win: unknown): any[] {
  const w = win as any;
  return [
    w?.PDFViewerApplication,
    w?.wrappedJSObject?.PDFViewerApplication,
    w?.contentWindow?.PDFViewerApplication,
    w?.contentWindow?.wrappedJSObject?.PDFViewerApplication,
  ].filter(Boolean);
}

function firstPdfSource(
  values: Array<PdfPageSource | null>,
): PdfPageSource | null {
  for (const value of values) {
    if (value && value.pageCount > 0) return value;
  }
  return null;
}

function processedViewSource(view: unknown): PdfPageSource | null {
  const v = view as {
    _pdfPages?: ProcessedPageCollection;
    _pageLabels?: Array<string | null>;
    _iframeWindow?: unknown;
    _pages?: unknown[];
  } | null;
  if (!v) return null;
  const apps = pdfViewerApplications(v._iframeWindow);
  const doc = apps.find((app) => app?.pdfDocument)?.pdfDocument;
  const pageCount = Math.max(
    0,
    Math.floor(
      pageCountFromDocument(doc) ||
        numberValue(v._pageLabels?.length) ||
        numberValue(v._pages?.length) ||
        processedPageCount(v._pdfPages) ||
        0,
    ),
  );
  if (pageCount <= 0 || (!v._pdfPages && !hasProcessedPageAPI(doc))) {
    return null;
  }

  const documentSource = processedDocumentSource(doc, pageCount);
  return {
    pageCount,
    async getPageBundle(pageIndex, pageLabel) {
      const pageData = processedPageAt(v._pdfPages, pageIndex);
      if (pageData) {
        return buildProcessedPageBundle(pageData, pageIndex, pageLabel);
      }
      return documentSource?.getPageBundle?.(pageIndex, pageLabel) ?? null;
    },
    async getPageLabels() {
      if (Array.isArray(v._pageLabels)) {
        return labelsFromArray(v._pageLabels, pageCount);
      }
      return documentSource?.getPageLabels() ?? numericPageLabels(pageCount);
    },
  };
}

function processedDocumentSource(
  pdfDocument: unknown,
  fallbackPageCount?: number | null,
): PdfPageSource | null {
  const doc = pdfDocument as PdfDocumentLike | null;
  if (!hasProcessedPageAPI(doc)) return null;
  const pageCount = Math.max(
    0,
    Math.floor(
      pageCountFromDocument(doc) || numberValue(fallbackPageCount) || 0,
    ),
  );
  if (pageCount <= 0) return null;

  let processedPages: Promise<ProcessedPageCollection | null> | null = null;
  const readProcessedPages = async () => {
    if (!doc?.getProcessedData) return null;
    if (!processedPages) {
      processedPages = doc
        .getProcessedData()
        .then((data) => data?.pages ?? null)
        .catch(() => null);
    }
    return processedPages;
  };

  return {
    pageCount,
    async getPageBundle(pageIndex, pageLabel) {
      const pages = await readProcessedPages();
      const pageData =
        processedPageAt(pages, pageIndex) ??
        (doc?.getPageData
          ? await doc.getPageData({ pageIndex }).catch(() => null)
          : null);
      return buildProcessedPageBundle(pageData, pageIndex, pageLabel);
    },
    getPageLabels: () => readDocumentPageLabels(doc, pageCount),
  };
}

function documentSource(pdfDocument: unknown): PdfPageSource | null {
  const doc = pdfDocument as PdfDocumentLike | null;
  if (!doc || typeof doc.getPage !== "function") return null;
  const getPage = doc.getPage.bind(doc);
  const pageCount = pageCountFromDocument(doc);
  if (pageCount <= 0) return null;
  return {
    pageCount,
    getPage: (pageIndex) => getPage(pageIndex + 1),
    getPageLabels: () => readDocumentPageLabels(doc, pageCount),
  };
}

function pageViewSource(pdfViewer: unknown): PdfPageSource | null {
  const viewer = pdfViewer as {
    pagesCount?: number;
    _pages?: Array<{ pdfPage?: PdfPageLike }>;
    getPageView?: (pageIndex: number) => { pdfPage?: PdfPageLike } | null;
  } | null;
  if (!viewer) return null;
  const pageCount = Math.max(
    0,
    Math.floor(
      numberValue(viewer.pagesCount) ?? numberValue(viewer._pages?.length) ?? 0,
    ),
  );
  if (pageCount <= 0) return null;
  return {
    pageCount,
    async getPage(pageIndex) {
      const pageView =
        viewer.getPageView?.(pageIndex) ?? viewer._pages?.[pageIndex];
      const page = pageView?.pdfPage;
      if (!page || typeof page.getTextContent !== "function") {
        throw new Error(`PDF page ${pageIndex + 1} is not loaded yet.`);
      }
      return page;
    },
    getPageLabels: async () => numericPageLabels(pageCount),
  };
}

function pageCountFromDocument(
  pdfDocument: PdfDocumentLike | null | undefined,
): number {
  if (!pdfDocument) return 0;
  return Math.max(
    0,
    Math.floor(
      numberValue(pdfDocument.numPages) ??
        numberValue(pdfDocument.pdfInfo?.numPages) ??
        numberValue(pdfDocument._pdfInfo?.numPages) ??
        0,
    ),
  );
}

function hasProcessedPageAPI(
  pdfDocument: PdfDocumentLike | null | undefined,
): pdfDocument is PdfDocumentLike {
  return (
    !!pdfDocument &&
    (typeof pdfDocument.getProcessedData === "function" ||
      typeof pdfDocument.getPageData === "function")
  );
}

function processedPageCount(
  pages: ProcessedPageCollection | null | undefined,
): number {
  if (!pages) return 0;
  if (Array.isArray(pages)) return pages.length;
  const numericKeys = Object.keys(pages)
    .map((key) => Number(key))
    .filter((value) => Number.isInteger(value) && value >= 0);
  return numericKeys.length ? Math.max(...numericKeys) + 1 : 0;
}

function processedPageAt(
  pages: ProcessedPageCollection | null | undefined,
  pageIndex: number,
): ProcessedPageLike | null {
  if (!pages) return null;
  const page = Array.isArray(pages)
    ? pages[pageIndex]
    : pages[String(pageIndex)];
  return page && typeof page === "object" ? page : null;
}

function labelsFromArray(
  labels: Array<string | null>,
  pageCount: number,
): string[] {
  return Array.from({ length: pageCount }, (_, index) =>
    labels[index] ? String(labels[index]) : String(index + 1),
  );
}

function numericPageLabels(pageCount: number): string[] {
  return Array.from({ length: pageCount }, (_, index) => String(index + 1));
}

function rectValue(value: unknown): PdfRect | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const rect = value.slice(0, 4).map((entry) => numberValue(entry));
  if (rect.some((entry) => entry == null)) return null;
  return rect as PdfRect;
}

interface SelectionRectGroup {
  pageIndex: number;
  rects: PdfRect[];
}

function selectionRectGroups(position: unknown): SelectionRectGroup[] {
  const p = position as
    | {
        pageIndex?: unknown;
        rects?: unknown;
      }
    | null
    | undefined;
  const pageIndex = numberValue(p?.pageIndex);
  const rects = rectsValue(p?.rects);
  if (pageIndex == null || pageIndex < 0 || rects.length === 0) return [];
  return [{ pageIndex: Math.floor(pageIndex), rects }];
}

function rectsValue(value: unknown): PdfRect[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => rectValue(entry))
    .filter((rect): rect is PdfRect => !!rect);
}

function extractAttachmentID(reader: unknown): number | null {
  const r = reader as {
    itemID?: number;
    _item?: { id?: number };
  } | null;
  if (typeof r?._item?.id === "number") return r._item.id;
  return typeof r?.itemID === "number" ? r.itemID : null;
}

async function readDocumentPageLabels(
  pdfDocument: PdfDocumentLike,
  pageCount: number,
): Promise<string[]> {
  try {
    const labels =
      (await pdfDocument.getPageLabels2?.()) ??
      (await pdfDocument.getPageLabels?.());
    if (Array.isArray(labels)) {
      return labelsFromArray(labels, pageCount);
    }
  } catch {
    // Fall through to numeric labels.
  }
  return numericPageLabels(pageCount);
}

async function readPageBundle(
  source: PdfPageSource,
  pageIndex: number,
  pageLabel: string,
): Promise<PageBundle | null> {
  if (source.getPageBundle) {
    return source.getPageBundle(pageIndex, pageLabel);
  }
  if (!source.getPage) return null;
  const page = await source.getPage(pageIndex);
  const textContent = await page.getTextContent({
    disableCombineTextItems: false,
  });
  const items = Array.isArray(textContent.items) ? textContent.items : [];
  let pageText = "";
  const anchors: ItemAnchor[] = [];

  items.forEach((item, itemIndex) => {
    const itemString = typeof item.str === "string" ? item.str : "";
    const start = pageText.length;
    pageText += itemString;
    const end = start + itemString.length;
    if (itemString) {
      anchors.push(
        anchorFromItem(item, itemIndex, pageIndex, start, end, itemString),
      );
    }
    if (item.hasEOL) {
      pageText += "\n";
    } else if (itemString && !/\s$/.test(itemString)) {
      pageText += " ";
    }
  });

  if (!pageText || anchors.length === 0) return null;
  const normalized = normalizeWithMap(pageText);
  return {
    pageIndex,
    pageLabel,
    pageText,
    anchors,
    normalizedText: normalized.text,
    normalizedToOriginal: normalized.map,
    source: "textContent",
  };
}

function buildProcessedPageBundle(
  pageData: ProcessedPageLike | null | undefined,
  pageIndex: number,
  pageLabel: string,
): PageBundle | null {
  const chars = Array.isArray(pageData?.chars) ? pageData.chars : [];
  if (!chars.length) return null;

  let pageText = "";
  const anchors: ItemAnchor[] = [];
  chars.forEach((char, charIndex) => {
    if (char.ignorable) return;
    const charText = typeof char.c === "string" ? char.c : "";
    const start = pageText.length;
    pageText += charText;
    const end = start + charText.length;
    const rect = rectValue(char.inlineRect) ?? rectValue(char.rect);
    if (charText && rect) {
      anchors.push({
        itemIndex: charIndex,
        pageIndex,
        startOffset: start,
        endOffset: end,
        x: rect[0],
        y: rect[1],
        width: Math.max(0, rect[2] - rect[0]),
        height: Math.max(0, rect[3] - rect[1]),
        itemString: charText,
        lineBreakAfter: !!char.lineBreakAfter,
        source: "processed",
      });
    }
    if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
      pageText += " ";
    }
  });

  if (!pageText || anchors.length === 0) return null;
  const normalized = normalizeWithMap(pageText);
  return {
    pageIndex,
    pageLabel,
    pageText,
    anchors,
    normalizedText: normalized.text,
    normalizedToOriginal: normalized.map,
    viewBox: rectValue(pageData?.viewBox) ?? undefined,
    source: "processed",
  };
}

function anchorFromItem(
  item: PdfTextItemLike,
  itemIndex: number,
  pageIndex: number,
  startOffset: number,
  endOffset: number,
  itemString: string,
): ItemAnchor {
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const fontSize = Math.abs(
    numberValue(transform[3]) ?? numberValue(transform[0]) ?? 10,
  );
  return {
    itemIndex,
    pageIndex,
    startOffset,
    endOffset,
    x: numberValue(transform[4]) ?? 0,
    y: numberValue(transform[5]) ?? 0,
    width: Math.abs(
      numberValue(item.width) ?? fontSize * itemString.length * 0.5,
    ),
    height: Math.abs(numberValue(item.height) ?? fontSize),
    itemString,
  };
}

// Normalizer with offset back-mapping.
// Returns:
//   text: lowercased + ligatures expanded + zero-widths stripped + each run
//         of whitespace collapsed to a single space.
//   map:  for each char in `text`, the offset in the ORIGINAL `input` that
//         char came from. Used by `originalRangeFromNormalized` to recover
//         original-space offsets after we match in normalized space.
//
// Special-case `-\n` (hyphen at line end): both consumed, no output. WHY:
// PDFs hyphenate words across lines; preserving the hyphen would make
// "self-\nattention" fail to match "self-attention".
//
// INVARIANT: map.length === [...text].length AT EVERY POINT during build —
// used by `originalRangeFromNormalized` to find the source char of `text[i]`.
function normalizeWithMap(input: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpaceOffset: number | null = null;
  let index = 0;

  const pushSpace = () => {
    if (pendingSpaceOffset == null) return;
    if (chars.length > 0 && chars[chars.length - 1] !== " ") {
      chars.push(" ");
      map.push(pendingSpaceOffset);
    }
    pendingSpaceOffset = null;
  };

  while (index < input.length) {
    const hyphenBreakEnd = hyphenBreakEndAt(input, index);
    if (hyphenBreakEnd > index) {
      index = hyphenBreakEnd;
      continue;
    }

    const codePoint = input.codePointAt(index);
    if (codePoint == null) break;
    const rawChar = String.fromCodePoint(codePoint);
    const charLength = rawChar.length;

    if (isZeroWidth(rawChar)) {
      index += charLength;
      continue;
    }

    if (/\s/u.test(rawChar)) {
      if (pendingSpaceOffset == null) pendingSpaceOffset = index;
      index += charLength;
      continue;
    }

    pushSpace();
    for (const char of expandNormalizedChar(rawChar)) {
      if (/\s/u.test(char)) {
        if (pendingSpaceOffset == null) pendingSpaceOffset = index;
      } else {
        chars.push(char);
        map.push(index);
      }
    }
    index += charLength;
  }

  if (chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(""), map };
}

function hyphenBreakEndAt(input: string, index: number): number {
  if (input[index] !== "-") return -1;
  let cursor = index + 1;
  while (cursor < input.length && isHorizontalSpace(input[cursor])) cursor++;
  const newlineEnd = newlineEndAt(input, cursor);
  if (newlineEnd < 0) return -1;
  cursor = newlineEnd;
  while (cursor < input.length && /\s/u.test(input[cursor])) cursor++;
  return cursor;
}

function newlineEndAt(input: string, index: number): number {
  if (input[index] === "\r" && input[index + 1] === "\n") return index + 2;
  if (input[index] === "\r" || input[index] === "\n") return index + 1;
  return -1;
}

function isHorizontalSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\f" || char === "\v";
}

function expandNormalizedChar(char: string): string[] {
  const expanded = LIGATURES[char] ?? char.normalize("NFKC");
  const lower = expanded.toLowerCase();
  const output: string[] = [];
  for (const normalizedChar of Array.from(lower)) {
    output.push(...Array.from(LIGATURES[normalizedChar] ?? normalizedChar));
  }
  return output;
}

function isZeroWidth(char: string): boolean {
  return (
    char === "\u200b" ||
    char === "\u200c" ||
    char === "\u200d" ||
    char === "\ufeff"
  );
}

// Fuzzy match: slide a needle-sized window across the page in coarse
// strides and pick the highest-confidence window. Confidence = 1 - (edit
// distance / max(window, needle)).
// WHY stride = needleLength / 4 (not 1): full O(N·k) Levenshtein over every
// offset would be too slow for long pages. A stride of needle/4 still finds
// the optimum window within a few characters, and the misalignment is
// absorbed by Levenshtein insertions/deletions on the boundaries.
// GOTCHA: this CANNOT find a match shorter than `needleLength` — by design,
// since the caller wants a passage of roughly the needle's size.
function fuzzyNormalizedMatch(
  page: PageBundle,
  normalizedNeedle: string,
): NormalizedMatch | null {
  const haystack = page.normalizedText;
  const needleLength = normalizedNeedle.length;
  if (!haystack || needleLength === 0) return null;

  const step = Math.max(1, Math.floor(needleLength / 4));
  let best: NormalizedMatch | null = null;
  for (let start = 0; start < haystack.length; start += step) {
    const end = Math.min(haystack.length, start + needleLength);
    if (end <= start) continue;
    const candidate = haystack.slice(start, end);
    const distance = levenshteinDistance(candidate, normalizedNeedle);
    const confidence = 1 - distance / Math.max(candidate.length, needleLength);
    if (!best || confidence > best.confidence) {
      best = {
        page,
        normalizedStart: start,
        normalizedEnd: end,
        confidence,
      };
    }
  }
  return best;
}

function levenshteinDistance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

async function locateOnPage(
  page: PageBundle,
  normalizedStart: number,
  normalizedEnd: number,
  confidence: number,
  pageGlobalOffset: number,
): Promise<LocateResult | null> {
  const range = originalRangeFromNormalized(
    page.pageText,
    page.normalizedToOriginal,
    normalizedStart,
    normalizedEnd,
  );
  if (!range) return null;

  const rects = rectsForRange(page.anchors, range.start, range.end);
  if (rects.length === 0) return null;

  const matchedText = page.pageText
    .slice(range.start, range.end)
    .replace(/\s+/g, " ")
    .trim();
  const top = sortTopForPage(page, rects);
  return {
    pageIndex: page.pageIndex,
    pageLabel: page.pageLabel,
    rects,
    sortIndex: buildSortIndex(
      page.pageIndex,
      sortOffsetForRange(page, range.start, range.end, pageGlobalOffset),
      top,
    ),
    matchedText,
    confidence,
  };
}

// Sort offset semantics differ between the two source types:
// - "processed": offset is the FIRST char's `itemIndex` in the page's char
//   stream — Zotero's native annotation sort comparator expects this for
//   processed-page annotations.
// - "textContent" (PDF.js fallback): offset is a document-wide char index
//   (cumulativeOffset + rangeStart). WHY document-wide: Zotero compares
//   sortIndex strings lexicographically, so per-page-relative offsets
//   would sort the same value across different pages incorrectly.
function sortOffsetForRange(
  page: PageBundle,
  rangeStart: number,
  rangeEnd: number,
  pageGlobalOffset: number,
): number {
  if (page.source === "processed") {
    const first = page.anchors.find(
      (anchor) =>
        anchor.startOffset < rangeEnd && anchor.endOffset > rangeStart,
    );
    return first?.itemIndex ?? 0;
  }
  return pageGlobalOffset + rangeStart;
}

function sortTopForPage(page: PageBundle, rects: PdfRect[]): number {
  const y2 = Math.max(...rects.map((rect) => rect[3]));
  if (page.viewBox) {
    const pageHeight = page.viewBox[3] - page.viewBox[1];
    return Math.max(0, pageHeight - y2);
  }
  return y2;
}

function originalRangeFromNormalized(
  original: string,
  map: number[],
  normalizedStart: number,
  normalizedEnd: number,
): { start: number; end: number } | null {
  const start = map[normalizedStart];
  const last = map[normalizedEnd - 1];
  if (start == null || last == null) return null;
  return {
    start,
    end: Math.min(original.length, last + charLengthAt(original, last)),
  };
}

function charLengthAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint == null) return 1;
  return codePoint > 0xffff ? 2 : 1;
}

function rectsForRange(
  anchors: ItemAnchor[],
  matchStart: number,
  matchEnd: number,
): PdfRect[] {
  const parts = anchors
    .map((anchor) => {
      const rect = anchorPartialRect(anchor, matchStart, matchEnd);
      return rect ? { rect, itemIndex: anchor.itemIndex } : null;
    })
    .filter((part): part is RectPart => !!part);
  if (!parts.length) return [];
  return mergeRectParts(parts);
}

interface RectPart {
  rect: PdfRect;
  itemIndex: number;
}

// Build rectangles for the exact text segments, not a single min/max block.
// This matters for two-column PDFs: a sentence can wrap from the bottom of
// the left column to the top of the right column, and one union rectangle
// would cover unrelated text between those two visual positions.
function mergeRectParts(parts: RectPart[]): PdfRect[] {
  const rows = groupRectPartsByY(parts);
  const rects: PdfRect[] = [];

  for (const row of rows) {
    const sorted = row
      .slice()
      .sort((a, b) => a.rect[0] - b.rect[0] || a.itemIndex - b.itemIndex);
    let current: PdfRect | null = null;

    for (const part of sorted) {
      if (current && shouldMergeInline(current, part.rect)) {
        current = unionRect(current, part.rect);
        continue;
      }
      if (current) rects.push(roundRect(current));
      current = part.rect;
    }

    if (current) rects.push(roundRect(current));
  }

  return rects;
}

function groupRectPartsByY(parts: RectPart[]): RectPart[][] {
  const sorted = parts
    .slice()
    .sort(
      (a, b) =>
        rectMidY(b.rect) - rectMidY(a.rect) ||
        a.rect[0] - b.rect[0] ||
        a.itemIndex - b.itemIndex,
    );
  const rows: Array<{ y: number; parts: RectPart[] }> = [];

  for (const part of sorted) {
    const y = rectMidY(part.rect);
    const row = rows.find(
      (candidate) => Math.abs(candidate.y - y) <= LINE_Y_TOLERANCE,
    );
    if (row) {
      row.parts.push(part);
    } else {
      rows.push({ y, parts: [part] });
    }
  }

  return rows.map((row) => row.parts);
}

function shouldMergeInline(left: PdfRect, right: PdfRect): boolean {
  const gap = right[0] - left[2];
  const height = Math.max(rectHeight(left), rectHeight(right), 1);
  return gap <= Math.max(2, height * 1.5);
}

function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function rectMidY(rect: PdfRect): number {
  return (rect[1] + rect[3]) / 2;
}

function rectHeight(rect: PdfRect): number {
  return Math.abs(rect[3] - rect[1]);
}

function roundRect(rect: PdfRect): PdfRect {
  return rect.map((value) => Number(value.toFixed(3))) as PdfRect;
}

// Cuts a partial rect out of one item-level anchor by linearly
// interpolating x within the anchor's width. WHY linear (not glyph-aware):
// the textContent path doesn't expose per-glyph widths, so we approximate
// monospace-style positioning. GOTCHA: this is INACCURATE for proportional
// fonts — a passage like "Wii Wii Wii" gets equal-width slices when the
// real glyphs differ. Acceptable because the highlight is shown over the
// right line and the user can always edit it in Zotero.
function anchorPartialRect(
  anchor: ItemAnchor,
  matchStart: number,
  matchEnd: number,
): PdfRect | null {
  const localStart = Math.max(0, matchStart - anchor.startOffset);
  const localEnd = Math.min(
    anchor.itemString.length,
    matchEnd - anchor.startOffset,
  );
  if (localEnd <= localStart) return null;

  const length = Math.max(1, anchor.itemString.length);
  const startX = anchor.x + (anchor.width * localStart) / length;
  const endX = anchor.x + (anchor.width * localEnd) / length;
  const y0 = Math.min(anchor.y, anchor.y + anchor.height);
  const y1 = Math.max(anchor.y, anchor.y + anchor.height);
  return [Math.min(startX, endX), y0, Math.max(startX, endX), y1];
}

interface TextSpan {
  itemIndex: number;
  startOffset: number;
  endOffset: number;
}

function extractPageTextFromSelectionRects(
  page: PageBundle,
  rects: PdfRect[],
): string {
  const lines = rects
    .map((rect) => extractSelectionRectText(page, rect))
    .filter(Boolean);
  return lines.join("\n").trim();
}

function extractSelectionRectText(page: PageBundle, rect: PdfRect): string {
  const spans = page.anchors
    .map((anchor) => selectionSpanForAnchor(anchor, rect))
    .filter((span): span is TextSpan => !!span)
    .sort((a, b) => a.itemIndex - b.itemIndex);
  if (!spans.length) return "";
  return textFromSpans(page.pageText, spans);
}

function selectionSpanForAnchor(
  anchor: ItemAnchor,
  selectionRect: PdfRect,
): TextSpan | null {
  const anchorRect = fullAnchorRect(anchor);
  if (!rectsOverlap(anchorRect, selectionRect)) return null;
  const yOverlap = intervalOverlap(
    anchorRect[1],
    anchorRect[3],
    selectionRect[1],
    selectionRect[3],
    SELECTION_RECT_TOLERANCE,
  );
  const anchorHeight = Math.max(rectHeight(anchorRect), 1);
  if (yOverlap / anchorHeight < 0.25) return null;

  const xOverlap = intervalOverlap(
    anchorRect[0],
    anchorRect[2],
    selectionRect[0],
    selectionRect[2],
    SELECTION_RECT_TOLERANCE,
  );
  if (xOverlap <= 0) return null;

  const span = partialAnchorTextSpan(anchor, selectionRect);
  return span.endOffset > span.startOffset ? span : null;
}

function partialAnchorTextSpan(
  anchor: ItemAnchor,
  selectionRect: PdfRect,
): TextSpan {
  if (anchor.source === "processed" || anchor.itemString.length <= 1) {
    return {
      itemIndex: anchor.itemIndex,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }

  const length = Math.max(1, anchor.itemString.length);
  const width = Math.max(Math.abs(anchor.width), 1);
  const left = Math.min(anchor.x, anchor.x + anchor.width);
  const right = Math.max(anchor.x, anchor.x + anchor.width);
  const selectionLeft = Math.min(selectionRect[0], selectionRect[2]);
  const selectionRight = Math.max(selectionRect[0], selectionRect[2]);
  const startRatio = clamp01((selectionLeft - left) / width);
  const endRatio = clamp01((selectionRight - left) / width);
  const startOffset =
    anchor.startOffset + Math.max(0, Math.floor(startRatio * length));
  const endOffset =
    anchor.startOffset + Math.min(length, Math.ceil(endRatio * length));

  // If the rect covers the anchor but x ordering was inverted, fall back to
  // the full item instead of returning an empty slice.
  if (
    endOffset <= startOffset &&
    selectionLeft <= right &&
    selectionRight >= left
  ) {
    return {
      itemIndex: anchor.itemIndex,
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
    };
  }

  return { itemIndex: anchor.itemIndex, startOffset, endOffset };
}

function textFromSpans(pageText: string, spans: TextSpan[]): string {
  let output = "";
  let cursor: number | null = null;
  for (const span of spans) {
    const start = Math.max(0, Math.min(pageText.length, span.startOffset));
    const end = Math.max(start, Math.min(pageText.length, span.endOffset));
    if (cursor != null && start > cursor) {
      const gap = pageText.slice(cursor, start);
      output += /\S/.test(gap) ? " " : gap;
    }
    output += pageText.slice(start, end);
    cursor = Math.max(cursor ?? 0, end);
  }
  return output.replace(/[ \t\f\v]+/g, " ").trim();
}

function fullAnchorRect(anchor: ItemAnchor): PdfRect {
  const partial = anchorPartialRect(
    anchor,
    anchor.startOffset,
    anchor.endOffset,
  );
  return (
    partial ?? [
      anchor.x,
      anchor.y,
      anchor.x + anchor.width,
      anchor.y + anchor.height,
    ]
  );
}

function rectsOverlap(a: PdfRect, b: PdfRect): boolean {
  return (
    intervalOverlap(a[0], a[2], b[0], b[2], SELECTION_RECT_TOLERANCE) > 0 &&
    intervalOverlap(a[1], a[3], b[1], b[3], SELECTION_RECT_TOLERANCE) > 0
  );
}

function intervalOverlap(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  tolerance = 0,
): number {
  const left = Math.max(Math.min(a0, a1), Math.min(b0, b1) - tolerance);
  const right = Math.min(Math.max(a0, a1), Math.max(b0, b1) + tolerance);
  return Math.max(0, right - left);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// Zotero's annotation sort key. Format: "PPPPP|OOOOOO|TTTTT" — three
// zero-padded numeric fields joined with "|". Lexicographic order on this
// string yields reading order: by page, then by stream/char offset, then
// by Y position within the page.
// REF: Zotero source `chrome/content/zotero/elements/annotation-row.js`.
function buildSortIndex(
  pageIndex: number,
  offset: number,
  top: number,
): string {
  return [
    String(pageIndex).padStart(5, "0"),
    String(offset).padStart(6, "0"),
    String(Math.floor(top)).padStart(5, "0"),
  ].join("|");
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
