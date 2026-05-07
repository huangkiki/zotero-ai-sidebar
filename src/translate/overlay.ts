import type { TranslateOverlayPosition } from '../settings/types';
import type { PdfPageContent, PdfRect } from '../context/pdf-locator';

export interface OverlayHandle {
  el: HTMLElement;
  appendText(delta: string): void;
  setError(message: string): void;
  setStatus(message: string): void;
  destroy(): void;
}

export interface OverlayActions {
  onPrev?: () => void;
  onNext?: () => void;
  onSave?: () => void;
  onClose: () => void;
  hint: string;
}

export interface MountOverlayInput {
  iframeDoc: Document;
  pageEl: HTMLElement;
  rects: PdfRect[];
  pageContent: PdfPageContent;
  position: TranslateOverlayPosition;
  actions: OverlayActions;
  initialText?: string;
}

export function mountOverlay(input: MountOverlayInput): OverlayHandle {
  const { iframeDoc, pageEl, rects, pageContent, position, actions, initialText } = input;

  ensureStyle(iframeDoc);

  const el = iframeDoc.createElement('div');
  el.className = 'zai-translate-overlay';
  el.setAttribute('data-position', position);

  const body = iframeDoc.createElement('div');
  body.className = 'zai-translate-overlay__body';
  if (initialText) body.textContent = initialText;
  el.appendChild(body);

  const actionsRow = iframeDoc.createElement('div');
  actionsRow.className = 'zai-translate-overlay__actions';
  actionsRow.appendChild(makeBtn(iframeDoc, '💾', '保存到笔记', actions.onSave));
  actionsRow.appendChild(makeBtn(iframeDoc, '▲', '上一句', actions.onPrev));
  actionsRow.appendChild(makeBtn(iframeDoc, '▼', '下一句', actions.onNext));
  actionsRow.appendChild(makeBtn(iframeDoc, '✕', '关闭', actions.onClose));
  el.appendChild(actionsRow);

  const hintEl = iframeDoc.createElement('div');
  hintEl.className = 'zai-translate-overlay__hint';
  hintEl.textContent = actions.hint;
  el.appendChild(hintEl);

  pageEl.appendChild(el);
  positionOverlay(el, pageEl, rects, pageContent, position);

  return {
    el,
    appendText(delta) { body.textContent = (body.textContent ?? '') + delta; },
    setError(message) {
      body.textContent = `⚠️ ${message}`;
      el.classList.add('zai-translate-overlay--error');
    },
    setStatus(message) {
      body.classList.add('zai-translate-overlay__body--status');
      body.textContent = message;
    },
    destroy() { el.remove(); },
  };
}

function makeBtn(doc: Document, label: string, title: string, handler?: () => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'zai-translate-overlay__btn';
  b.textContent = label;
  b.title = title;
  if (!handler) { b.disabled = true; return b; }
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handler();
  });
  return b;
}

function positionOverlay(
  overlay: HTMLElement,
  pageEl: HTMLElement,
  rects: PdfRect[],
  pageContent: PdfPageContent,
  position: TranslateOverlayPosition,
): void {
  if (rects.length === 0) return;

  const xs = rects.flatMap((r) => [r[0], r[2]]);
  const ys = rects.flatMap((r) => [r[1], r[3]]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  const pageRect = pageEl.getBoundingClientRect();
  const [pdfW, pdfH] = pdfPageDimensions(pageContent.viewBox)
    ?? [pageRect.width || 1, pageRect.height || 1];

  // PDF user-space origin = bottom-left; the overlay's CSS uses top-left.
  // We project the rect bbox onto the page element's CSS box and flip Y.
  const cssLeft = (x0 / pdfW) * pageRect.width;
  const cssRight = (x1 / pdfW) * pageRect.width;
  const cssTopOfRect = ((pdfH - y1) / pdfH) * pageRect.height;
  const cssBottomOfRect = ((pdfH - y0) / pdfH) * pageRect.height;

  overlay.style.position = 'absolute';
  overlay.style.left = `${cssLeft}px`;
  overlay.style.width = `${Math.max(220, cssRight - cssLeft)}px`;
  if (position === 'above') {
    overlay.style.bottom = `${pageRect.height - cssTopOfRect + 4}px`;
    overlay.style.top = '';
  } else {
    overlay.style.top = `${cssBottomOfRect + 4}px`;
    overlay.style.bottom = '';
  }
  overlay.style.zIndex = '20';
}

// PDF MediaBox / cropBox is [llx, lly, urx, ury] — width/height = ur - ll.
function pdfPageDimensions(viewBox: PdfRect | undefined): [number, number] | null {
  if (!viewBox) return null;
  const w = viewBox[2] - viewBox[0];
  const h = viewBox[3] - viewBox[1];
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return [w, h];
}

const STYLE_ID = 'zai-translate-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  (doc.head ?? doc.documentElement!).appendChild(style);
}

const STYLE_TEXT = `
.zai-translate-overlay {
  background: rgba(255, 255, 255, 0.97);
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  color: #1f2328;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12);
  max-height: 40%;
  overflow: auto;
  pointer-events: auto;
}
.zai-translate-overlay__body { white-space: pre-wrap; }
.zai-translate-overlay__body--status { color: #666; font-style: italic; }
.zai-translate-overlay--error .zai-translate-overlay__body { color: #b3261e; }
.zai-translate-overlay__actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  margin-top: 6px;
}
.zai-translate-overlay__btn {
  background: transparent;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
  font-size: 12px;
}
.zai-translate-overlay__btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
}
.zai-translate-overlay__btn:disabled { opacity: 0.4; cursor: default; }
.zai-translate-overlay__hint {
  margin-top: 4px;
  font-size: 11px;
  color: #888;
  text-align: right;
}
`;
