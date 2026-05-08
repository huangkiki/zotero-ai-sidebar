import { describe, expect, it } from 'vitest';
import {
  detectSentenceAtPoint,
  detectSentenceFromSelection,
} from '../../src/translate/sentence-detect';
import type { PdfLocator, PdfPageContent } from '../../src/context/pdf-locator';

function pageContent(text: string): PdfPageContent {
  return {
    pageIndex: 0,
    pageLabel: '1',
    pageText: text,
    normalizedText: text,
    normalizedToOriginal: Array.from({ length: text.length }, (_, index) => index),
  };
}

describe('detectSentenceAtPoint', () => {
  it('maps a text-layer click to the containing page sentence', async () => {
    const text = 'First sentence. Second sentence.';
    const content = pageContent(text);
    let locateNeedle = '';
    let locatePageIndex: number | undefined;
    const locator: PdfLocator = {
      attachmentID: 1,
      getFullText: async () => text,
      extractTextFromPosition: async () => '',
      getPageContent: async () => content,
      locate: async (needle, opts) => {
        locateNeedle = needle;
        locatePageIndex = opts?.pageIndex;
        return {
          pageIndex: 0,
          pageLabel: '1',
          rects: [[10, 10, 120, 20]],
          sortIndex: '00000|000000|00010',
          matchedText: needle,
          confidence: 1,
        };
      },
      dispose: () => undefined,
    };

    const page = document.createElement('div');
    page.className = 'page';
    page.setAttribute('data-page-number', '1');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.textContent = text;
    page.append(textLayer);
    document.body.append(page);

    const offsetNode = textLayer.firstChild!;
    (document as Document & { caretPositionFromPoint?: unknown }).caretPositionFromPoint = () => ({
      offsetNode,
      offset: text.indexOf('Second') + 2,
    });

    const hit = await detectSentenceAtPoint({
      iframeWindow: { document },
      clientX: 10,
      clientY: 10,
      locator,
    });

    expect(hit?.text).toBe('Second sentence.');
    expect(hit?.pageSentenceIndex).toBe(1);
    expect(locateNeedle).toBe('Second sentence.');
    expect(locatePageIndex).toBe(0);
    page.remove();
  });

  it('falls back to caretRangeFromPoint when caretPositionFromPoint is unavailable', async () => {
    const text = 'First sentence. Second sentence.';
    const content = pageContent(text);
    const locator: PdfLocator = {
      attachmentID: 1,
      getFullText: async () => text,
      extractTextFromPosition: async () => '',
      getPageContent: async () => content,
      locate: async (needle, opts) => ({
        pageIndex: opts?.pageIndex ?? 0,
        pageLabel: '1',
        rects: [[10, 10, 120, 20]],
        sortIndex: '00000|000000|00010',
        matchedText: needle,
        confidence: 1,
      }),
      dispose: () => undefined,
    };

    const page = document.createElement('div');
    page.className = 'page';
    page.setAttribute('data-page-number', '1');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.textContent = text;
    page.append(textLayer);
    document.body.append(page);

    const range = document.createRange();
    range.setStart(textLayer.firstChild!, text.indexOf('Second') + 2);
    range.collapse(true);
    (document as Document & { caretPositionFromPoint?: unknown }).caretPositionFromPoint =
      undefined;
    (document as Document & { caretRangeFromPoint?: unknown }).caretRangeFromPoint =
      () => range;

    const hit = await detectSentenceAtPoint({
      iframeWindow: { document },
      clientX: 10,
      clientY: 10,
      locator,
    });

    expect(hit?.text).toBe('Second sentence.');
    page.remove();
  });

  it('maps a Zotero text-layer selection to the containing sentence', async () => {
    const text = 'First sentence. Second sentence.';
    const content = pageContent(text);
    const locator: PdfLocator = {
      attachmentID: 1,
      getFullText: async () => text,
      extractTextFromPosition: async () => '',
      getPageContent: async () => content,
      locate: async (needle, opts) => ({
        pageIndex: opts?.pageIndex ?? 0,
        pageLabel: '1',
        rects: [[10, 10, 120, 20]],
        sortIndex: '00000|000000|00010',
        matchedText: needle,
        confidence: 1,
      }),
      dispose: () => undefined,
    };

    const page = document.createElement('div');
    page.className = 'page';
    page.setAttribute('data-page-number', '1');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.textContent = text;
    page.append(textLayer);
    document.body.append(page);

    const range = document.createRange();
    range.setStart(textLayer.firstChild!, text.indexOf('Second') + 1);
    range.setEnd(textLayer.firstChild!, text.indexOf('Second') + 7);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const hit = await detectSentenceFromSelection({
      iframeWindow: {
        document,
        getSelection: () => selection,
      },
      locator,
    });

    expect(hit?.text).toBe('Second sentence.');
    selection.removeAllRanges();
    page.remove();
  });
});
