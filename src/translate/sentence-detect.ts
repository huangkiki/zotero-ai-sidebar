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
  };
}

interface CaretPosition {
  offsetNode: Node | null;
  offset: number;
}

export interface DetectInput {
  iframeWindow: IframeWindowLike;
  clientX: number;
  clientY: number;
  locator: PdfLocator;
}

export async function detectSentenceAtPoint(input: DetectInput): Promise<DetectedSentence | null> {
  const { iframeWindow, clientX, clientY, locator } = input;
  const doc = iframeWindow.document;
  const caret = doc.caretPositionFromPoint?.(clientX, clientY);
  if (!caret) return null;

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

  const located = await locator.locate(sentenceText, { minConfidence: 0.6 });
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

function findTextLayerAncestor(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur instanceof HTMLElement && cur.classList.contains('textLayer')) return cur;
    cur = cur.parentNode;
  }
  return null;
}

function approxClickOffset(textLayer: HTMLElement, caret: CaretPosition): number {
  if (!textLayer.ownerDocument) return -1;
  let offset = 0;
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === caret.offsetNode) return offset + caret.offset;
    offset += (node.textContent ?? '').length;
    node = walker.nextNode();
  }
  return -1;
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
