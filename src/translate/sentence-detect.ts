import { sentenceAt, splitSentences } from './sentence-splitter';
import type {
  LocateResult,
  PdfLocator,
  PdfPageContent,
} from '../context/pdf-locator';

export interface DetectedSentence {
  text: string;
  pageIndex: number;
  pageLabel: string;
  rects: LocateResult['rects'];
  sortIndex: string;
  pageSentenceIndex: number;
  pageSentenceCount: number;
  paragraphContext: string;
  bundle: PdfPageContent;
}

interface IframeWindowLike {
  document: Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  getSelection?: () => Selection | null;
  PDFViewerApplication?: unknown;
  wrappedJSObject?: { PDFViewerApplication?: unknown };
}

interface CaretPosition {
  offsetNode: Node | null;
  offset: number;
  getClientRect?: () => DOMRect | null;
}

export interface DetectInput {
  iframeWindow: IframeWindowLike;
  clientX: number;
  clientY: number;
  locator: PdfLocator;
}

export async function detectSentenceAtPoint(input: DetectInput): Promise<DetectedSentence | null> {
  const { iframeWindow, clientX, clientY, locator } = input;
  const pdfPoint = pdfPointFromClientPoint(iframeWindow, clientX, clientY);
  if (pdfPoint && locator.sentenceAtPoint) {
    const located = await locator.sentenceAtPoint(pdfPoint.pageIndex, {
      x: pdfPoint.x,
      y: pdfPoint.y,
    });
    if (located) {
      const bundle = await locator.getPageContent(located.pageIndex);
      if (!bundle) return null;
      return {
        text: located.text,
        pageIndex: located.pageIndex,
        pageLabel: located.pageLabel,
        rects: located.rects,
        sortIndex: located.sortIndex,
        pageSentenceIndex: located.pageSentenceIndex,
        pageSentenceCount: located.pageSentenceCount,
        paragraphContext: located.paragraphContext,
        bundle,
      };
    }
  }

  const doc = iframeWindow.document;
  const caret = caretFromPoint(doc, clientX, clientY);
  if (!caret) return null;

  return detectSentenceAtCaret(doc, caret, locator);
}

export async function detectSentenceFromSelection(input: {
  iframeWindow: IframeWindowLike;
  locator: PdfLocator;
}): Promise<DetectedSentence | null> {
  const { iframeWindow, locator } = input;
  const selection =
    iframeWindow.getSelection?.() ?? iframeWindow.document.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (range.collapsed) continue;
    const caret = caretFromRange(range);
    if (!caret) continue;
    const detected = await detectSentenceAtCaret(
      iframeWindow.document,
      caret,
      locator,
    );
    if (detected) return detected;
  }
  return null;
}

async function detectSentenceAtCaret(
  doc: IframeWindowLike['document'],
  caret: CaretPosition,
  locator: PdfLocator,
): Promise<DetectedSentence | null> {
  if (!caret.offsetNode) return null;
  const textLayer = findTextLayerAncestor(caret.offsetNode);
  if (!textLayer) return null;
  const pageEl = textLayer.closest('.page,[data-page-number]');
  const pageNumberAttr = pageEl?.getAttribute('data-page-number');
  if (!pageNumberAttr) return null;
  const pageIndex = parseInt(pageNumberAttr, 10) - 1;
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;

  const bundle = await locator.getPageContent(pageIndex);
  if (!bundle) return null;

  const offsetWithinPageText = approxClickOffset(textLayer, caret);
  if (offsetWithinPageText < 0) return null;

  return detectSentenceAtPageOffset(pageIndex, offsetWithinPageText, locator);
}

async function detectSentenceAtPageOffset(
  pageIndex: number,
  offsetWithinPageText: number,
  locator: PdfLocator,
): Promise<DetectedSentence | null> {
  const bundle = await locator.getPageContent(pageIndex);
  if (!bundle) return null;

  const normalizedOffset = normalizedFromOriginalOffset(offsetWithinPageText, bundle.normalizedToOriginal);
  const span = sentenceAt(bundle.normalizedText, normalizedOffset);
  if (!span) return null;

  const origStart = bundle.normalizedToOriginal[span.start] ?? -1;
  const origEnd = bundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
  if (origStart < 0 || origEnd < 0 || origEnd <= origStart) return null;
  const sentenceText = bundle.pageText.slice(origStart, origEnd + 1).trim();
  if (!sentenceText) return null;

  const allSentencesNormalized = splitSentences(bundle.normalizedText);
  const idx = allSentencesNormalized.findIndex((s) => s.start === span.start && s.end === span.end);
  const pageSentenceIndex = idx >= 0 ? idx : 0;

  const located = await locator.locate(sentenceText, {
    minConfidence: 0.6,
    pageIndex,
  });
  if (!located) return null;

  return {
    text: sentenceText,
    pageIndex: located.pageIndex,
    pageLabel: located.pageLabel,
    rects: located.rects,
    sortIndex: located.sortIndex,
    pageSentenceIndex,
    pageSentenceCount: allSentencesNormalized.length,
    paragraphContext: extractParagraph(bundle.pageText, origStart, origEnd),
    bundle,
  };
}

function pdfPointFromClientPoint(
  iframeWindow: IframeWindowLike,
  clientX: number,
  clientY: number,
): { pageIndex: number; x: number; y: number } | null {
  const doc = iframeWindow.document;
  const pageEl = pageElementFromPoint(doc, clientX, clientY);
  if (!pageEl) return null;

  const pageIndex = pageIndexFromElement(iframeWindow, pageEl);
  if (pageIndex < 0) return null;
  const viewport = pdfPageViewport(iframeWindow, pageIndex);
  if (typeof viewport?.convertToPdfPoint !== 'function') return null;

  const rect = pageEl.getBoundingClientRect();
  const x = clientX + pageEl.scrollLeft - rect.left;
  const y = clientY + pageEl.scrollTop - rect.top;
  const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
  return Number.isFinite(pdfX) && Number.isFinite(pdfY)
    ? { pageIndex, x: pdfX, y: pdfY }
    : null;
}

function pageElementFromPoint(
  doc: Document,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const elements =
    typeof doc.elementsFromPoint === 'function'
      ? Array.from(doc.elementsFromPoint(clientX, clientY))
      : [];
  for (const element of elements) {
    const page = element.closest?.('.page,[data-page-number]');
    if (isElementWithLayout(page)) return page as HTMLElement;
  }
  return null;
}

function isElementWithLayout(value: unknown): value is Element {
  return (
    !!value &&
    typeof (value as Element).closest === 'function' &&
    typeof (value as Element).getBoundingClientRect === 'function'
  );
}

function pageIndexFromElement(
  iframeWindow: IframeWindowLike,
  pageEl: HTMLElement,
): number {
  const pages = pdfViewerPages(iframeWindow);
  const index = pages.findIndex((page) => page?.div === pageEl);
  if (index >= 0) return index;
  const pageNumber = Number(pageEl.getAttribute('data-page-number'));
  return Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber - 1 : -1;
}

function pdfPageViewport(
  iframeWindow: IframeWindowLike,
  pageIndex: number,
): { convertToPdfPoint?: (x: number, y: number) => [number, number] } | null {
  const page = pdfViewerPages(iframeWindow)[pageIndex];
  const viewport = page?.viewport;
  return viewport && typeof viewport === 'object'
    ? (viewport as { convertToPdfPoint?: (x: number, y: number) => [number, number] })
    : null;
}

function pdfViewerPages(iframeWindow: IframeWindowLike): Array<{ div?: Element; viewport?: unknown }> {
  const app = pdfViewerApplication(iframeWindow);
  const pages = (app as { pdfViewer?: { _pages?: unknown[] } } | null)?.pdfViewer?._pages;
  return Array.isArray(pages)
    ? (pages as Array<{ div?: Element; viewport?: unknown }>)
    : [];
}

function pdfViewerApplication(iframeWindow: IframeWindowLike): unknown {
  return (
    iframeWindow.PDFViewerApplication ??
    iframeWindow.wrappedJSObject?.PDFViewerApplication ??
    null
  );
}

function caretFromRange(range: Range): CaretPosition | null {
  const candidates: CaretPosition[] = [
    { offsetNode: range.startContainer, offset: range.startOffset },
    { offsetNode: range.endContainer, offset: range.endOffset },
  ];
  return (
    candidates.find((candidate) =>
      candidate.offsetNode
        ? findTextLayerAncestor(candidate.offsetNode) !== null
        : false,
    ) ?? null
  );
}

function caretFromPoint(
  doc: IframeWindowLike['document'],
  x: number,
  y: number,
): CaretPosition | null {
  doc.body?.classList.add('reading-caret-position');
  try {
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) {
      const withRect = position as CaretPosition & {
        getClientRect?: () => DOMRect | null;
      };
      return {
        offsetNode: position.offsetNode,
        offset: position.offset,
        getClientRect: withRect.getClientRect?.bind(position),
      };
    }
    const range = doc.caretRangeFromPoint?.(x, y);
    return range
      ? {
          offsetNode: range.startContainer,
          offset: range.startOffset,
          getClientRect: () => range.getBoundingClientRect(),
        }
      : null;
  } finally {
    doc.body?.classList.remove('reading-caret-position');
  }
}

function findTextLayerAncestor(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    const el = elementLike(cur);
    if (el?.classList?.contains('textLayer')) return el as HTMLElement;
    cur = (el?.parentElement as Node | null | undefined) ?? cur.parentNode;
  }
  return null;
}

function elementLike(node: Node): Element | null {
  return node.nodeType === 1 && typeof (node as Element).closest === 'function'
    ? (node as Element)
    : null;
}

function approxClickOffset(textLayer: HTMLElement, caret: CaretPosition): number {
  if (!textLayer.ownerDocument) return -1;
  const rangeOffset = rangeTextOffset(textLayer, caret);
  if (rangeOffset >= 0) return rangeOffset;

  let offset = 0;
  const showText =
    textLayer.ownerDocument.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, showText);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === caret.offsetNode) return offset + caret.offset;
    offset += (node.textContent ?? '').length;
    node = walker.nextNode();
  }
  return -1;
}

function rangeTextOffset(textLayer: HTMLElement, caret: CaretPosition): number {
  if (!caret.offsetNode || !textLayer.contains(caret.offsetNode)) return -1;
  const doc = textLayer.ownerDocument;
  if (!doc) return -1;
  try {
    const range = doc.createRange();
    range.setStart(textLayer, 0);
    range.setEnd(caret.offsetNode, caret.offset);
    return range.toString().length;
  } catch {
    return -1;
  }
}

// Find the smallest normalized index whose original offset >= originalOffset.
function normalizedFromOriginalOffset(originalOffset: number, map: number[]): number {
  if (map.length === 0) return 0;
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((map[mid] ?? -1) < originalOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function extractParagraph(pageText: string, start: number, _end: number): string {
  const paraStart = lastDoubleNewlineBefore(pageText, start);
  const paraEnd = nextDoubleNewlineAfter(pageText, start);
  return pageText.slice(paraStart, paraEnd).trim();
}

function lastDoubleNewlineBefore(s: string, from: number): number {
  const i = s.lastIndexOf('\n\n', from);
  return i < 0 ? 0 : i + 2;
}

function nextDoubleNewlineAfter(s: string, from: number): number {
  const i = s.indexOf('\n\n', from);
  return i < 0 ? s.length : i;
}
