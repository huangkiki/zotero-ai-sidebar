import type {
  TranslateOverlayPosition,
  TranslateOverlaySize,
} from "../settings/types";
import type { PdfPageContent, PdfRect } from "../context/pdf-locator";
import { logTranslateDebug } from "./debug-log";

export interface OverlayHandle {
  el: HTMLElement;
  setText(text: string): void;
  appendText(delta: string): void;
  setDone(): void;
  setError(message: string): void;
  setStatus(message: string): void;
  setStatusLabel(message: string): void;
  destroy(): void;
}

export interface OverlayActions {
  onPrev?: () => void;
  onNext?: () => void;
  onSave?: () => void;
  onRetry?: () => void;
  onClose: () => void;
  hint: string;
}

export interface MountOverlayInput {
  iframeDoc: Document;
  pageEl: HTMLElement;
  rects: PdfRect[];
  pageContent: PdfPageContent;
  position: TranslateOverlayPosition;
  size: TranslateOverlaySize;
  actions: OverlayActions;
  initialText?: string;
}

export function mountOverlay(input: MountOverlayInput): OverlayHandle {
  const {
    iframeDoc,
    pageEl,
    rects,
    pageContent,
    position,
    size,
    actions,
    initialText,
  } = input;

  ensureStyle(iframeDoc);
  removeStaleTranslateDom(iframeDoc);
  const popupGuard = mountSelectionPopupGuard(iframeDoc);
  const highlights = mountHighlights(iframeDoc, pageEl, rects, pageContent);

  const el = iframeDoc.createElement("div");
  el.className = "zai-translate-overlay";
  el.setAttribute("data-position", position);
  el.setAttribute("data-size", size);

  const meta = iframeDoc.createElement("div");
  meta.className = "zai-translate-overlay__meta";
  const lang = iframeDoc.createElement("span");
  lang.className = "zai-translate-overlay__lang";
  lang.textContent = "EN → 简体中文";
  const status = iframeDoc.createElement("span");
  status.className = "zai-translate-overlay__status";
  status.textContent = "● 翻译中…";
  meta.append(lang, status);
  el.appendChild(meta);

  const body = iframeDoc.createElement("div");
  body.className = "zai-translate-overlay__body";
  if (initialText) body.textContent = initialText;
  el.appendChild(body);

  const actionsRow = iframeDoc.createElement("div");
  actionsRow.className = "zai-translate-overlay__actions";
  actionsRow.appendChild(
    makeBtn(iframeDoc, "💾", "保存为 Zotero 注释", actions.onSave, true),
  );
  actionsRow.appendChild(
    makeBtn(iframeDoc, "↻", "重新翻译（忽略缓存并覆盖旧结果）", actions.onRetry),
  );
  actionsRow.appendChild(makeBtn(iframeDoc, "▲", "上一句", actions.onPrev));
  actionsRow.appendChild(makeBtn(iframeDoc, "▼", "下一句", actions.onNext));
  const hintEl = iframeDoc.createElement("span");
  hintEl.className = "zai-translate-overlay__hint";
  hintEl.textContent = actions.hint;
  actionsRow.appendChild(hintEl);
  actionsRow.appendChild(
    makeBtn(iframeDoc, "✕", "关闭 (Esc)", actions.onClose),
  );
  el.appendChild(actionsRow);

  el.style.visibility = "hidden";
  (iframeDoc.body ?? pageEl).appendChild(el);

  let destroyed = false;
  let positionFrame = 0;
  const win = iframeDoc.defaultView;
  const positionNow = () => {
    if (destroyed) return;
    if (positionFrame && win) {
      win.cancelAnimationFrame(positionFrame);
      positionFrame = 0;
    }
    positionOverlay(el, pageEl, rects, pageContent, position, size);
  };
  const schedulePosition = () => {
    if (destroyed) return;
    if (!win) {
      positionNow();
      return;
    }
    if (positionFrame) return;
    positionFrame = win.requestAnimationFrame(() => {
      positionFrame = 0;
      positionOverlay(el, pageEl, rects, pageContent, position, size);
    });
  };
  positionNow();
  win?.addEventListener("scroll", schedulePosition, true);
  win?.addEventListener("resize", schedulePosition);

  return {
    el,
    setText(text) {
      body.classList.remove("zai-translate-overlay__body--status");
      body.textContent = text;
      status.textContent = "● 已完成";
      schedulePosition();
    },
    appendText(delta) {
      if (body.classList.contains("zai-translate-overlay__body--status")) {
        body.textContent = "";
        body.classList.remove("zai-translate-overlay__body--status");
      }
      body.textContent = (body.textContent ?? "") + delta;
      schedulePosition();
    },
    setDone() {
      status.textContent = "● 已完成";
      schedulePosition();
    },
    setError(message) {
      body.classList.remove("zai-translate-overlay__body--status");
      body.textContent = `⚠️ ${message}`;
      status.textContent = "● 翻译失败";
      el.classList.add("zai-translate-overlay--error");
      schedulePosition();
    },
    setStatus(message) {
      body.classList.add("zai-translate-overlay__body--status");
      body.textContent = message;
      status.textContent = message.includes("翻译") ? "● 翻译中…" : "● 等待中…";
      schedulePosition();
    },
    setStatusLabel(message) {
      status.textContent = message;
      schedulePosition();
    },
    destroy() {
      destroyed = true;
      if (positionFrame && win) win.cancelAnimationFrame(positionFrame);
      win?.removeEventListener("scroll", schedulePosition, true);
      win?.removeEventListener("resize", schedulePosition);
      el.remove();
      for (const highlight of highlights) highlight.remove();
      popupGuard.destroy();
    },
  };
}

function removeStaleTranslateDom(doc: Document): void {
  doc
    .querySelectorAll(".zai-translate-overlay,.zai-translate-highlight")
    .forEach((node: Element) => node.remove());
}

export function mountSelectionPopupGuard(doc: Document): { destroy(): void } {
  const docs = relatedDocuments(doc);
  guardLog("mountSelectionPopupGuard", {
    docCount: docs.length,
    urls: docs.map(safeDocUrl),
  });
  for (const targetDoc of docs) {
    try {
      ensureSelectionPopupGuardStyle(targetDoc);
      targetDoc.documentElement?.classList.add(SELECTION_POPUP_GUARD_CLASS);
      guardLog("class added to documentElement", {
        url: safeDocUrl(targetDoc),
        hasClass: targetDoc.documentElement?.classList.contains(
          SELECTION_POPUP_GUARD_CLASS,
        ),
      });
    } catch (err) {
      guardLog("failed to add guard class to doc", {
        url: safeDocUrl(targetDoc),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // CSS-class approach can fail if `.selection-popup` is rendered in a doc
  // we cannot reach (cross-origin, shadow DOM, late-mount). Add a hard
  // MutationObserver that watches every reachable doc and hides every
  // `.selection-popup` it finds — both already-present and newly-inserted.
  const observers: MutationObserver[] = [];
  // Duck-type rather than `instanceof HTMLElement`: in the chrome bootstrap
  // realm, `HTMLElement` is undefined, so `instanceof` throws ReferenceError
  // when the observer callback runs.
  const hidePopup = (el: Element) => {
    try {
      const styled = el as Element & { style?: CSSStyleDeclaration };
      if (styled.style?.setProperty) {
        styled.style.setProperty("visibility", "hidden", "important");
        styled.style.setProperty("pointer-events", "none", "important");
      } else {
        el.setAttribute(
          "style",
          "visibility: hidden !important; pointer-events: none !important;",
        );
      }
    } catch {
      /* ignore — best effort */
    }
  };
  const scanAndHide = (root: ParentNode) => {
    const nodes = root.querySelectorAll?.(".selection-popup");
    if (!nodes) return;
    nodes.forEach((el: Element) => {
      hidePopup(el);
      guardLog("hid existing .selection-popup", { tag: (el as HTMLElement).tagName });
    });
  };
  for (const targetDoc of docs) {
    try {
      scanAndHide(targetDoc);
      const view = targetDoc.defaultView as Window & {
        MutationObserver?: typeof MutationObserver;
      } | null;
      const Observer = view?.MutationObserver ?? MutationObserver;
      if (!targetDoc.body) continue;
      const observer = new Observer((mutations: MutationRecord[]) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node: Node | null) => {
            if (!node || node.nodeType !== 1) return;
            const el = node as Element;
            if (el.matches?.(".selection-popup")) {
              hidePopup(el);
              guardLog("hid newly-inserted .selection-popup");
            }
            scanAndHide(el);
          });
        }
      });
      // Build options inside the target realm so Xray wrappers don't
      // strip the boolean properties (Firefox throws "must not be false"
      // when the wrapper drops the keys it can't see).
      const options = buildObserverOptions(view ?? targetDoc.defaultView);
      observer.observe(targetDoc.body, options);
      observers.push(observer);
      guardLog("MutationObserver attached", { url: safeDocUrl(targetDoc) });
    } catch (err) {
      guardLog("failed to attach observer", {
        url: safeDocUrl(targetDoc),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    destroy() {
      for (const targetDoc of docs) {
        targetDoc.documentElement?.classList.remove(
          SELECTION_POPUP_GUARD_CLASS,
        );
      }
      for (const observer of observers) observer.disconnect();
      guardLog("popup guard destroyed");
    },
  };
}

function buildObserverOptions(view: Window | null): MutationObserverInit {
  const fallback: MutationObserverInit = { childList: true, subtree: true };
  if (!view) return fallback;
  // Try Components.utils.cloneInto so the options object lives in the
  // target realm. Without this, Firefox's Xray wrapper can drop the boolean
  // keys, causing `MutationObserver.observe` to throw "must not be false".
  try {
    const Cu =
      (view as unknown as { Components?: { utils?: { cloneInto?: Function } } })
        .Components?.utils ??
      (globalThis as unknown as { Components?: { utils?: { cloneInto?: Function } } })
        .Components?.utils;
    if (typeof Cu?.cloneInto === "function") {
      return Cu.cloneInto(fallback, view) as MutationObserverInit;
    }
  } catch {
    /* fall through */
  }
  // Fallback: construct via the target realm's Object so properties
  // are owned by that compartment.
  try {
    const ViewObject = (view as unknown as { Object?: ObjectConstructor }).Object;
    if (ViewObject) {
      const obj = new ViewObject() as MutationObserverInit & Record<string, unknown>;
      obj.childList = true;
      obj.subtree = true;
      return obj;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function safeDocUrl(doc: Document): string {
  try {
    return doc.location?.href ?? "(no url)";
  } catch (err) {
    return `(threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function guardLog(message: string, extra?: Record<string, unknown>): void {
  logTranslateDebug("zai-translate-guard", message, extra);
}

function relatedDocuments(doc: Document): Document[] {
  const docs: Document[] = [];
  const add = (candidate: Document | null | undefined) => {
    try {
      if (candidate && !docs.includes(candidate)) docs.push(candidate);
    } catch {
      /* ignore */
    }
  };

  add(doc);
  let win: Window | null = null;
  try {
    win = doc.defaultView;
  } catch {
    return docs;
  }
  for (let i = 0; i < 4 && win; i++) {
    try {
      const parent: Window | null = win.parent;
      if (!parent || parent === win) break;
      let parentDoc: Document | null = null;
      try {
        parentDoc = parent.document;
      } catch {
        break; // cross-origin / chrome-privileged — stop walking
      }
      add(parentDoc);
      win = parent;
    } catch {
      break;
    }
  }
  return docs;
}

function ensureSelectionPopupGuardStyle(doc: Document): void {
  if (doc.getElementById(SELECTION_POPUP_GUARD_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SELECTION_POPUP_GUARD_STYLE_ID;
  style.textContent = `
.${SELECTION_POPUP_GUARD_CLASS} .selection-popup {
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  (doc.head ?? doc.documentElement)?.append(style);
}

function makeBtn(
  doc: Document,
  label: string,
  title: string,
  handler?: () => void,
  primary = false,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "zai-translate-overlay__btn";
  if (primary) b.classList.add("zai-translate-overlay__btn--primary");
  b.textContent = label;
  b.title = title;
  if (!handler) {
    b.disabled = true;
    return b;
  }
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handler();
  });
  return b;
}

function mountHighlights(
  doc: Document,
  pageEl: HTMLElement,
  rects: PdfRect[],
  pageContent: PdfPageContent,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const rect of rects) {
    const highlight = doc.createElement("div");
    highlight.className = "zai-translate-highlight";
    positionPdfRect(highlight, pageEl, rect, pageContent);
    pageEl.appendChild(highlight);
    out.push(highlight);
  }
  return out;
}

function positionOverlay(
  overlay: HTMLElement,
  pageEl: HTMLElement,
  rects: PdfRect[],
  pageContent: PdfPageContent,
  position: TranslateOverlayPosition,
  size: TranslateOverlaySize,
): void {
  guardLog("positionOverlay", {
    rectCount: rects.length,
    pageRect: (() => {
      try {
        const r = pageEl.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top, left: r.left };
      } catch {
        return null;
      }
    })(),
  });
  if (rects.length === 0) return;

  const xs = rects.map((r) => r[0]);
  const ys = rects.flatMap((r) => [r[1], r[3]]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  const pageRect = pageEl.getBoundingClientRect();
  const viewportRect = viewportRectForPdfRect(
    pageEl,
    [x0, y0, Math.max(...rects.map((r) => r[2])), y1],
    pageContent,
  );
  const cssLeft = viewportRect.left;
  const cssTopOfRect = viewportRect.top;
  const cssBottomOfRect = viewportRect.bottom;
  const win = overlay.ownerDocument?.defaultView ?? null;
  const viewportWidth = win?.innerWidth || pageRect.width || 1;
  const viewportHeight = win?.innerHeight || pageRect.height || 1;
  const margin = 8;
  const gap = 8;
  const bounds = visibleOverlayBounds(pageEl, pageRect, {
    width: viewportWidth,
    height: viewportHeight,
    margin,
  });
  const boundsWidth = Math.max(1, bounds.right - bounds.left);
  const targetWidth = size === "adaptive" ? 480 : 320;
  const minWidth = size === "adaptive" ? 280 : 220;
  const overlayWidth = Math.min(
    targetWidth,
    Math.max(minWidth, Math.min(pageRect.width, boundsWidth) - margin * 2),
  );
  const anchorLeft = pageRect.left + cssLeft;
  const rectTop = pageRect.top + cssTopOfRect;
  const rectBottom = pageRect.top + cssBottomOfRect;
  const left = clamp(
    anchorLeft,
    bounds.left,
    Math.max(bounds.left, bounds.right - overlayWidth),
  );

  overlay.style.position = "fixed";
  overlay.style.left = `${left}px`;
  overlay.style.width = `${overlayWidth}px`;
  overlay.style.right = "";
  overlay.style.bottom = "";
  const visibleHeight = Math.max(84, bounds.bottom - bounds.top);
  overlay.style.maxHeight = `${visibleHeight}px`;
  overlay.style.setProperty(
    "--zai-overlay-body-max-height",
    size === "adaptive" ? `${Math.max(110, visibleHeight - 64)}px` : "110px",
  );

  const naturalHeight = measureOverlayHeight(overlay);
  const availableAbove = rectTop - gap - bounds.top;
  const availableBelow = bounds.bottom - rectBottom - gap;
  const minUsableHeight = 132;
  let actualPosition = position;
  if (
    position === "below" &&
    (naturalHeight > availableBelow || availableBelow < minUsableHeight) &&
    availableAbove > availableBelow
  ) {
    actualPosition = "above";
  } else if (
    position === "above" &&
    (naturalHeight > availableAbove || availableAbove < minUsableHeight) &&
    availableBelow > availableAbove
  ) {
    actualPosition = "below";
  }

  const availableOnSide =
    actualPosition === "above" ? availableAbove : availableBelow;
  const maxHeight = Math.max(
    84,
    Math.min(
      naturalHeight,
      availableOnSide > 0 ? availableOnSide : visibleHeight,
      visibleHeight,
    ),
  );
  overlay.style.maxHeight = `${maxHeight}px`;
  fitOverlayBody(overlay, maxHeight);

  const overlayHeight = measureOverlayHeight(overlay);
  const preferredTop =
    actualPosition === "above"
      ? rectTop - overlayHeight - gap
      : rectBottom + gap;
  const top = clamp(
    preferredTop,
    bounds.top,
    Math.max(bounds.top, bounds.bottom - overlayHeight),
  );
  const arrowLeft = clamp(anchorLeft - left + 8, 18, overlayWidth - 18);

  overlay.setAttribute("data-position", actualPosition);
  overlay.style.setProperty("--zai-overlay-arrow-left", `${arrowLeft}px`);
  overlay.style.top = `${top}px`;
  overlay.style.zIndex = "2147483647";
  overlay.style.visibility = "visible";
  guardLog("positionOverlay applied", {
    visibility: overlay.style.visibility,
    left: overlay.style.left,
    top: overlay.style.top,
    width: overlay.style.width,
    zIndex: overlay.style.zIndex,
    inDom: overlay.isConnected,
    parentTag: overlay.parentElement?.tagName,
    parentId: overlay.parentElement?.id,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

interface OverlayViewport {
  width: number;
  height: number;
  margin: number;
}

interface OverlayBounds {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function visibleOverlayBounds(
  pageEl: HTMLElement,
  pageRect: DOMRect,
  viewport: OverlayViewport,
): OverlayBounds {
  let top = viewport.margin;
  let right = viewport.width - viewport.margin;
  let bottom = viewport.height - viewport.margin;
  let left = viewport.margin;

  // Keep the bubble inside the current PDF page. Zotero/PDF.js draws strong
  // separators between pages; crossing them makes the bottom controls unclickable.
  top = Math.max(top, pageRect.top + viewport.margin);
  right = Math.min(right, pageRect.right - viewport.margin);
  bottom = Math.min(bottom, pageRect.bottom - viewport.margin);
  left = Math.max(left, pageRect.left + viewport.margin);

  const clipBounds = nearestClipBounds(pageEl);
  if (clipBounds) {
    top = Math.max(top, clipBounds.top + viewport.margin);
    right = Math.min(right, clipBounds.right - viewport.margin);
    bottom = Math.min(bottom, clipBounds.bottom - viewport.margin);
    left = Math.max(left, clipBounds.left + viewport.margin);
  }

  if (right <= left) {
    left = viewport.margin;
    right = viewport.width - viewport.margin;
  }
  if (bottom <= top) {
    top = viewport.margin;
    bottom = viewport.height - viewport.margin;
  }
  return { top, right, bottom, left };
}

function nearestClipBounds(el: HTMLElement): OverlayBounds | null {
  const win = el.ownerDocument?.defaultView;
  if (!win) return null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (!style) continue;
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
    if (/(auto|scroll|hidden|clip)/.test(overflow)) {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.left + (node.clientWidth || rect.width),
        bottom: rect.top + (node.clientHeight || rect.height),
        left: rect.left,
      };
    }
    if (node === el.ownerDocument.body) break;
  }
  return null;
}

function measureOverlayHeight(overlay: HTMLElement): number {
  const rectHeight = overlay.getBoundingClientRect().height;
  return Math.max(1, rectHeight || overlay.offsetHeight || 120);
}

function fitOverlayBody(overlay: HTMLElement, maxHeight: number): void {
  const body = overlay.querySelector<HTMLElement>(".zai-translate-overlay__body");
  const meta = overlay.querySelector<HTMLElement>(".zai-translate-overlay__meta");
  const actions = overlay.querySelector<HTMLElement>(
    ".zai-translate-overlay__actions",
  );
  if (!body || !meta || !actions) return;
  const win = overlay.ownerDocument?.defaultView;
  const overlayStyle = win?.getComputedStyle(overlay);
  const bodyStyle = win?.getComputedStyle(body);
  const paddingY =
    px(overlayStyle?.paddingTop) + px(overlayStyle?.paddingBottom);
  const bodyMargins =
    px(bodyStyle?.marginTop) + px(bodyStyle?.marginBottom);
  const fixedHeight =
    measureOverlayHeight(meta) + measureOverlayHeight(actions) + paddingY;
  const bodyMax = Math.max(28, maxHeight - fixedHeight - bodyMargins - 4);
  overlay.style.setProperty(
    "--zai-overlay-body-max-height",
    `${Math.floor(bodyMax)}px`,
  );
}

function px(value: string | undefined): number {
  const n = value ? Number.parseFloat(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

function positionPdfRect(
  el: HTMLElement,
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): void {
  const pageRect = pageEl.getBoundingClientRect();
  const viewportRect = viewportRectForPdfRect(pageEl, rect, pageContent);
  el.style.position = "absolute";
  el.style.left = `${viewportRect.left}px`;
  el.style.top = `${viewportRect.top}px`;
  el.style.width = `${Math.max(1, viewportRect.right - viewportRect.left)}px`;
  el.style.height = `${Math.max(1, viewportRect.bottom - viewportRect.top)}px`;
}

interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function viewportRectForPdfRect(
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): ViewportRect {
  const viewport = pageEl.ownerDocument
    ? pdfPageViewport(pageEl.ownerDocument, pageContent.pageIndex)
    : null;
  if (viewport) {
    const [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    };
  }

  return fallbackViewportRectForPdfRect(pageEl, rect, pageContent);
}

function fallbackViewportRectForPdfRect(
  pageEl: HTMLElement,
  rect: PdfRect,
  pageContent: PdfPageContent,
): ViewportRect {
  const pageRect = pageEl.getBoundingClientRect();
  const viewBox = pageContent.viewBox;
  const x0 = viewBox?.[0] ?? 0;
  const y0 = viewBox?.[1] ?? 0;
  const x1 = viewBox?.[2] ?? (pageRect.width || 1);
  const y1 = viewBox?.[3] ?? (pageRect.height || 1);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  return {
    left: ((rect[0] - x0) / width) * pageRect.width,
    top: ((y1 - rect[3]) / height) * pageRect.height,
    right: ((rect[2] - x0) / width) * pageRect.width,
    bottom: ((y1 - rect[1]) / height) * pageRect.height,
  };
}

function pdfPageViewport(
  doc: Document,
  pageIndex: number,
): { convertToViewportPoint: (x: number, y: number) => [number, number] } | null {
  const win = doc.defaultView as
    | (Window & {
        PDFViewerApplication?: unknown;
        wrappedJSObject?: { PDFViewerApplication?: unknown };
      })
    | null;
  const app = win?.PDFViewerApplication ?? win?.wrappedJSObject?.PDFViewerApplication;
  const page = (app as { pdfViewer?: { _pages?: unknown[] } } | null)?.pdfViewer
    ?._pages?.[pageIndex] as { viewport?: unknown } | undefined;
  const viewport = page?.viewport as
    | { convertToViewportPoint?: (x: number, y: number) => [number, number] }
    | undefined;
  return typeof viewport?.convertToViewportPoint === "function"
    ? (viewport as { convertToViewportPoint: (x: number, y: number) => [number, number] })
    : null;
}

const SELECTION_POPUP_GUARD_CLASS = "zai-translate-hide-selection-popup";
const SELECTION_POPUP_GUARD_STYLE_ID = "zai-translate-selection-popup-guard";
const STYLE_ID = "zai-translate-style";

function ensureStyle(doc: Document): void {
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    (doc.head ?? doc.documentElement!).appendChild(style);
  }
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
}

const STYLE_TEXT = `
.zai-translate-highlight {
  background: rgba(255, 213, 79, 0.34);
  box-shadow: 0 0 0 1px rgba(255, 171, 0, 0.46) inset;
  border-radius: 2px;
  pointer-events: none;
  z-index: 19;
}
.zai-translate-overlay {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d8d8da;
  border-radius: 8px;
  padding: 8px 10px 6px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 12.5px;
  line-height: 1.5;
  color: #1d1d1f;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(255, 213, 79, 0.55);
  overflow: hidden;
  pointer-events: auto;
}
.zai-translate-overlay::before {
  content: "";
  position: absolute;
  left: var(--zai-overlay-arrow-left, 26px);
  width: 12px;
  height: 12px;
  background: #fff;
  transform: rotate(45deg);
}
.zai-translate-overlay[data-position="above"]::before {
  bottom: -7px;
  border-right: 1px solid #d8d8da;
  border-bottom: 1px solid #d8d8da;
}
.zai-translate-overlay[data-position="below"]::before {
  top: -7px;
  border-left: 1px solid #d8d8da;
  border-top: 1px solid #d8d8da;
}
.zai-translate-overlay__meta {
  display: flex;
  flex: 0 0 auto;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: #888;
  margin-bottom: 4px;
}
.zai-translate-overlay__lang {
  background: #f1f3f6;
  color: #555;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9.5px;
}
.zai-translate-overlay__body {
  flex: 1 1 auto;
  min-height: 0;
  white-space: pre-wrap;
  color: #1d1d1f;
  font-size: 13px;
  line-height: 1.55;
  margin-bottom: 7px;
  max-height: var(--zai-overlay-body-max-height, 110px);
  overflow-y: auto;
}
.zai-translate-overlay__body--status { color: #666; font-style: italic; }
.zai-translate-overlay--error .zai-translate-overlay__body { color: #b3261e; }
.zai-translate-overlay--error {
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(179, 38, 30, 0.42);
}
.zai-translate-overlay__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  align-items: center;
  min-width: 0;
}
.zai-translate-overlay__btn {
  background: #f5f5f7;
  border: 1px solid #e0e0e3;
  color: #333;
  border-radius: 5px;
  width: 26px;
  height: 24px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
}
.zai-translate-overlay__btn:hover:not(:disabled) {
  background: #ebebef;
}
.zai-translate-overlay__btn--primary {
  background: #4a8cf7;
  border-color: #4a8cf7;
  color: #fff;
}
.zai-translate-overlay__btn:disabled { opacity: 0.4; cursor: default; }
.zai-translate-overlay__hint {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #888;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;
