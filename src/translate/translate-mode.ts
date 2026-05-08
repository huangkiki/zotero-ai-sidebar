import { createPdfLocator, type PdfLocator } from "../context/pdf-locator";
import {
  detectSentenceAtPoint,
  detectSentenceFromSelection,
  type DetectedSentence,
} from "./sentence-detect";
import {
  mountOverlay,
  mountSelectionPopupGuard,
  type OverlayHandle,
} from "./overlay";
import { logTranslateDebug } from "./debug-log";
import { cleanTranslationOutput, translateSentence } from "./translator";
import { cacheKey, getCachedTranslation, setCachedTranslation } from "./cache";
import { loadTranslateSettings } from "./settings";
import { matchesKeybinding, parseKeybinding } from "./keybinding";
import { splitSentences } from "./sentence-splitter";
import {
  saveSelectionAnnotation,
  type SelectionAnnotationDraft,
} from "../context/agent-tools";
import type { ModelPreset } from "../settings/types";
import { loadPresets, type PrefsStore } from "../settings/storage";

interface ReaderLike {
  _internalReader?: {
    _primaryView?: { _iframeWindow?: Window };
    _secondaryView?: { _iframeWindow?: Window };
    _iframeWindow?: Window;
  };
  _iframeWindow?: Window;
}

export interface TranslateModeContext {
  prefs: PrefsStore;
  presets: ModelPreset[];
  reader: ReaderLike;
}

export class TranslateModeController {
  private overlay: OverlayHandle | null = null;
  private modePopupGuard: { destroy(): void } | null = null;
  private current: DetectedSentence | null = null;
  private locator: PdfLocator | null = null;
  private pointerDownHandler: ((ev: PointerEvent) => void) | null = null;
  private mouseDownHandler: ((ev: MouseEvent) => void) | null = null;
  private pointerUpHandler: ((ev: PointerEvent) => void) | null = null;
  private mouseUpHandler: ((ev: MouseEvent) => void) | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;
  private dblClickHandler: ((ev: MouseEvent) => void) | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private keyWindows: Window[] = [];
  private abortCtrl: AbortController | null = null;
  private boundWindow: Window | null = null;
  private pointerStart: { x: number; y: number } | null = null;
  private pendingDoubleClick: { at: number; x: number; y: number } | null = null;
  private lastActivation: { at: number; x: number; y: number } | null = null;
  private lastDoubleActivation: { at: number; x: number; y: number } | null = null;
  private active = false;

  constructor(private ctx: TranslateModeContext) {}

  isForReader(reader: ReaderLike): boolean {
    return this.ctx.reader === reader;
  }

  isEnabled(): boolean {
    return this.active && this.boundWindow !== null;
  }

  refreshPresets(presets: ModelPreset[]): void {
    this.ctx.presets = presets;
  }

  async enable(): Promise<void> {
    const win = readerWindow(this.ctx.reader);
    if (!win) throw new Error("No active PDF Reader window is available.");
    if (
      this.boundWindow === win &&
      this.pointerDownHandler &&
      this.pointerUpHandler &&
      this.clickHandler &&
      this.dblClickHandler &&
      this.keyHandler
    )
      return;
    if (this.boundWindow) this.disable();
    if (!this.locator) {
      this.locator = await createPdfLocator(this.ctx.reader);
    }

    this.boundWindow = win;
    this.active = true;
    ensureModeStyle(win.document);
    win.document.body?.classList.add("zai-translate-mode-on");
    // Hide Zotero's native selection popup throughout translate mode so it
    // can never cover or race the translation overlay. Without this, the
    // overlay can mount under the popup until something incidentally
    // dismisses the popup (focus change, screenshot tool, etc.).
    try {
      this.modePopupGuard = mountSelectionPopupGuard(win.document);
    } catch (err) {
      debugLog("mountSelectionPopupGuard threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      debugLog("translate mode enabled", {
        windowUrl: safeWindowUrl(win),
        hasParent: safeHasParent(win),
      });
    } catch {
      /* never let logging crash enable() */
    }
    this.pointerDownHandler = (ev) => {
      this.rememberPointerStart(ev);
    };
    this.mouseDownHandler = (ev) => {
      if (!("PointerEvent" in win)) this.rememberPointerStart(ev);
    };
    this.pointerUpHandler = (ev) => {
      this.handleTranslatePointerUp(ev);
    };
    this.mouseUpHandler = (ev) => {
      if ("PointerEvent" in win) return;
      this.handleTranslatePointerUp(ev);
    };
    this.clickHandler = (ev) => {
      debugLog("click", {
        mode: this.translateTriggerMode(),
        drag: !this.isClickWithoutDrag(ev),
        detail: ev.detail,
        button: ev.button,
      });
      if (this.translateTriggerMode() !== "single") return;
      if (ev.detail !== 1 || !this.isClickWithoutDrag(ev)) return;
      this.scheduleActivation(ev, false);
    };
    this.dblClickHandler = (ev) => {
      if (this.translateTriggerMode() !== "double") return;
      this.scheduleDoubleActivation(ev);
    };
    this.keyHandler = (ev) => {
      this.handleKey(ev);
    };
    win.addEventListener("pointerdown", this.pointerDownHandler, true);
    win.addEventListener("mousedown", this.mouseDownHandler, true);
    win.addEventListener("pointerup", this.pointerUpHandler, true);
    win.addEventListener("mouseup", this.mouseUpHandler, true);
    win.addEventListener("click", this.clickHandler, true);
    win.addEventListener("dblclick", this.dblClickHandler, true);
    this.keyWindows = keyEventWindows(win);
    for (const keyWin of this.keyWindows) {
      keyWin.addEventListener("keydown", this.keyHandler, true);
    }
  }

  disable(): void {
    this.active = false;
    if (this.boundWindow && this.pointerDownHandler) {
      this.boundWindow.removeEventListener("pointerdown", this.pointerDownHandler, true);
    }
    if (this.boundWindow && this.mouseDownHandler) {
      this.boundWindow.removeEventListener("mousedown", this.mouseDownHandler, true);
    }
    if (this.boundWindow && this.pointerUpHandler) {
      this.boundWindow.removeEventListener("pointerup", this.pointerUpHandler, true);
    }
    if (this.boundWindow && this.mouseUpHandler) {
      this.boundWindow.removeEventListener("mouseup", this.mouseUpHandler, true);
    }
    if (this.boundWindow && this.clickHandler) {
      this.boundWindow.removeEventListener("click", this.clickHandler, true);
    }
    if (this.boundWindow && this.dblClickHandler) {
      this.boundWindow.removeEventListener("dblclick", this.dblClickHandler, true);
    }
    if (this.keyHandler) {
      for (const keyWin of this.keyWindows) {
        keyWin.removeEventListener("keydown", this.keyHandler, true);
      }
    }
    this.boundWindow?.document.body?.classList.remove("zai-translate-mode-on");
    this.modePopupGuard?.destroy();
    this.modePopupGuard = null;
    this.boundWindow = null;
    this.pointerDownHandler = null;
    this.mouseDownHandler = null;
    this.pointerUpHandler = null;
    this.mouseUpHandler = null;
    this.clickHandler = null;
    this.dblClickHandler = null;
    this.keyHandler = null;
    this.keyWindows = [];
    this.pointerStart = null;
    this.pendingDoubleClick = null;
    this.lastActivation = null;
    this.lastDoubleActivation = null;
    this.dismissOverlay();
    this.locator?.dispose();
    this.locator = null;
  }

  private translateTriggerMode(): "single" | "double" {
    return loadTranslateSettings(this.ctx.prefs).triggerMode;
  }

  private rememberPointerStart(ev: MouseEvent): void {
    this.pointerStart =
      ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
  }

  private handleTranslatePointerUp(ev: MouseEvent): void {
    // Drag selections always activate translation regardless of triggerMode.
    // The trigger mode only governs how non-selection point gestures
    // (single vs double click) activate; the user's intent is unambiguous
    // when they finish a drag selection.
    const drag = !this.isClickWithoutDrag(ev);
    debugLog("pointerup", {
      mode: this.translateTriggerMode(),
      drag,
      detail: ev.detail,
    });
    if (drag) {
      this.pendingDoubleClick = null;
      if (ev.detail > 1) return;
      this.scheduleActivation(ev, true);
      return;
    }

    if (this.translateTriggerMode() === "single") {
      this.pendingDoubleClick = null;
      this.scheduleActivation(ev, false);
      return;
    }

    if (this.translateTriggerMode() === "double") {
      this.handleDoubleModePointerUp(ev);
    }
  }

  private handleDoubleModePointerUp(ev: MouseEvent): void {
    const now = Date.now();
    const current = { at: now, x: ev.clientX, y: ev.clientY };
    const previous = this.pendingDoubleClick;
    this.pendingDoubleClick = current;
    if (
      !previous ||
      now - previous.at > 450 ||
      distance(previous, current) > 8
    ) {
      return;
    }
    this.scheduleDoubleActivation(ev);
  }

  private scheduleDoubleActivation(ev: MouseEvent): void {
    if (!this.isClickWithoutDrag(ev)) return;
    if (this.isDuplicateDoubleActivation(ev)) return;
    this.scheduleActivation(ev, false);
  }

  private isClickWithoutDrag(ev: MouseEvent): boolean {
    if (!this.pointerStart) return true;
    return distance(this.pointerStart, { x: ev.clientX, y: ev.clientY }) <= 6;
  }

  private isDuplicateDoubleActivation(ev: MouseEvent): boolean {
    const now = Date.now();
    const last = this.lastDoubleActivation;
    if (
      last &&
      now - last.at < 350 &&
      distance(last, { x: ev.clientX, y: ev.clientY }) <= 6
    ) {
      return true;
    }
    this.lastDoubleActivation = { at: now, x: ev.clientX, y: ev.clientY };
    return false;
  }

  private scheduleActivation(
    ev: MouseEvent,
    preferSelection: boolean,
    delayMs = 0,
  ): void {
    if (ev.button !== 0) return;
    const target = ev.target as Node | null;
    if (closestElement(target, ".zai-translate-overlay")) return;
    const win = this.boundWindow;
    if (!this.isEnabled() || !win || !this.locator) return;
    if (!win.document.body?.classList.contains("zai-translate-mode-on")) {
      this.disable();
      return;
    }
    if (!eventHitsPage(win, ev.clientX, ev.clientY, target)) return;
    if (this.isDuplicateActivation(ev)) return;

    const clientX = ev.clientX;
    const clientY = ev.clientY;
    debugLog("scheduleActivation", {
      clientX,
      clientY,
      preferSelection,
      delayMs,
    });
    if (!preferSelection && delayMs <= 0) {
      void this.handleActivation(clientX, clientY, false);
      return;
    }
    win.setTimeout(() => {
      if (!this.isEnabled() || this.boundWindow !== win) return;
      void this.handleActivation(clientX, clientY, preferSelection);
    }, delayMs > 0 ? delayMs : SELECTION_STABILIZE_DELAY_MS);
  }

  private isDuplicateActivation(ev: MouseEvent): boolean {
    const now = Date.now();
    const last = this.lastActivation;
    if (
      last &&
      now - last.at < 250 &&
      distance(last, { x: ev.clientX, y: ev.clientY }) <= 6
    ) {
      debugLog("duplicateActivation", {
        ageMs: now - last.at,
        clientX: ev.clientX,
        clientY: ev.clientY,
      });
      return true;
    }
    this.lastActivation = { at: now, x: ev.clientX, y: ev.clientY };
    return false;
  }

  private async handleActivation(
    clientX: number,
    clientY: number,
    preferSelection: boolean,
  ): Promise<void> {
    if (!this.isEnabled() || !this.boundWindow || !this.locator) return;
    debugLog("handleActivation start", { clientX, clientY, preferSelection });

    let fromPoint: DetectedSentence | null = null;
    try {
      const fromSelection = preferSelection
        ? await detectSentenceFromSelection({
            iframeWindow: this.boundWindow as never,
            locator: this.locator,
          })
        : null;
      debugLog("detectSentenceFromSelection", {
        preferSelection,
        ok: !!fromSelection,
        text: fromSelection?.text?.slice(0, 60),
      });
      debugLog("detectSentenceAtPoint start", {
        skipped: !!fromSelection,
        clientX,
        clientY,
      });
      fromPoint =
        fromSelection ??
        (await detectSentenceAtPoint({
          iframeWindow: this.boundWindow as never,
          clientX,
          clientY,
          locator: this.locator,
        }));
      debugLog("detectSentenceAtPoint result", {
        ok: !!fromPoint,
        text: fromPoint?.text?.slice(0, 60),
        rectCount: fromPoint?.rects?.length ?? 0,
        pageIndex: fromPoint?.pageIndex,
      });
    } catch (err) {
      debugLog("detectSentence failed", { error: errorMessage(err) });
      return;
    }
    if (!fromPoint) {
      debugLog("handleActivation no detected sentence");
      return;
    }

    this.current = fromPoint;
    try {
      await this.renderForCurrent();
      debugLog("renderForCurrent finished");
    } catch (err) {
      debugLog("renderForCurrent threw", { error: errorMessage(err) });
      this.overlay?.setError(`翻译失败：${errorMessage(err)}`);
    }
  }

  private handleKey(ev: KeyboardEvent): void {
    if (!this.isEnabled()) return;
    if (!this.current) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const next = parseKeybinding(settings.nextSentenceKey);
    const prev = parseKeybinding(settings.prevSentenceKey);
    if (next && matchesKeybinding(ev, next)) {
      consumeKeyEvent(ev);
      void this.jump(+1);
    } else if (prev && matchesKeybinding(ev, prev)) {
      consumeKeyEvent(ev);
      void this.jump(-1);
    } else if (ev.key === "Escape") {
      consumeKeyEvent(ev);
      this.dismissOverlay();
    }
  }

  private async jump(delta: number): Promise<void> {
    if (!this.isEnabled()) return;
    const current = this.current;
    if (!current || !this.locator) return;
    const targetIndex = current.pageSentenceIndex + delta;
    if (targetIndex < 0 || targetIndex >= current.pageSentenceCount) return;

    if (this.locator.sentenceAtIndex) {
      const located = await this.locator.sentenceAtIndex(
        current.bundle.pageIndex,
        targetIndex,
      );
      if (!located) return;
      const bundle =
        located.pageIndex === current.bundle.pageIndex
          ? current.bundle
          : await this.locator.getPageContent(located.pageIndex);
      if (!bundle) return;
      this.current = { ...located, bundle };
      await this.renderForCurrent();
      return;
    }

    const all = splitSentences(current.bundle.normalizedText);
    const span = all[targetIndex];
    if (!span) return;
    const origStart = current.bundle.normalizedToOriginal[span.start] ?? -1;
    const origEnd =
      current.bundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
    if (origStart < 0 || origEnd < 0) return;
    const text = current.bundle.pageText.slice(origStart, origEnd + 1).trim();
    if (!text) return;
    const located = await this.locator.locate(text, {
      minConfidence: 0.6,
      pageIndex: current.bundle.pageIndex,
    });
    if (!located) return;
    this.current = {
      ...current,
      text,
      pageIndex: located.pageIndex,
      pageLabel: located.pageLabel,
      rects: located.rects,
      sortIndex: located.sortIndex,
      pageSentenceIndex: targetIndex,
    };
    await this.renderForCurrent();
  }

  private async renderForCurrent(forceRefresh = false): Promise<void> {
    const current = this.current;
    if (!this.isEnabled() || !current || !this.boundWindow) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    this.ctx.presets = loadPresets(this.ctx.prefs);
    const preset = pickOpenAiPreset(this.ctx.presets, settings.presetId);
    debugLog("renderForCurrent start", {
      forceRefresh,
      text: current.text.slice(0, 60),
      pageIndex: current.pageIndex,
      presetId: settings.presetId,
      model: settings.model || preset?.model || "",
    });

    const pageEl = this.boundWindow.document.querySelector(
      `.page[data-page-number="${current.pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) {
      debugLog("renderForCurrent missing pageEl", { pageIndex: current.pageIndex });
      return;
    }

    this.clearOverlay();
    this.abortCtrl = new AbortController();

    const model = settings.model || preset?.model || "";
    const hint = `${displayKey(settings.nextSentenceKey)} 下一句 · ${displayKey(settings.prevSentenceKey)} 上一句`;
    let latestTranslation = "";
    let translationDone = false;
    let overlay: OverlayHandle | null = null;
    overlay = mountOverlay({
      iframeDoc: this.boundWindow.document,
      pageEl,
      rects: current.rects,
      pageContent: current.bundle,
      position: settings.overlayPosition,
      size: settings.overlaySize,
      actions: {
        onClose: () => this.dismissOverlay(),
        onPrev: () => void this.jump(-1),
        onNext: () => void this.jump(+1),
        onRetry: () => void this.renderForCurrent(true),
        onSave: () => {
          if (!overlay) return;
          void this.saveTranslationAnnotation(
            current,
            overlay,
            latestTranslation,
            translationDone,
          );
        },
        hint,
      },
    });
    this.overlay = overlay;
    overlay.setStatus("正在翻译…");
    debugLog("overlay mounted", {
      connected: overlay.el.isConnected,
      position: settings.overlayPosition,
      size: settings.overlaySize,
    });

    if (!preset) {
      debugLog("renderForCurrent missing preset");
      overlay.setError("请先在设置中配置一个 GPT (openai) API。");
      return;
    }
    if (!model) {
      debugLog("renderForCurrent missing model");
      overlay.setError("请先为 GPT (openai) 配置选择模型。");
      return;
    }

    const key = cacheKey({
      sentence: current.text,
      target: "zh",
      endpoint: preset.baseUrl,
      model,
      thinking: settings.thinking,
      ctxLevel: settings.ctxLevel,
    });
    const cached = forceRefresh ? undefined : getCachedTranslation(this.ctx.prefs, key);
    if (cached) {
      debugLog("translation cache hit", {
        createdAt: cached.createdAt,
        model: cached.model,
      });
      latestTranslation = cleanTranslationOutput(cached.text);
      translationDone = true;
      overlay.setText(latestTranslation);
      return;
    }

    let buffer = "";
    let usageLabel = "";
    debugLog("translation request start", {
      model,
      thinking: settings.thinking,
      ctxLevel: settings.ctxLevel,
    });
    try {
      for await (const chunk of translateSentence({
        sentence: current.text,
        contextLabel: contextLabel(settings.ctxLevel),
        contextText: contextText(current, settings.ctxLevel),
        preset,
        model,
        thinking: settings.thinking,
        signal: this.abortCtrl.signal,
      })) {
        if (this.overlay !== overlay) {
          debugLog("translation abandoned: overlay changed");
          return;
        }
        if (chunk.type === "text" && chunk.text) {
          const text = cleanTranslationOutput(chunk.text);
          overlay.appendText(text);
          buffer += text;
          latestTranslation = buffer;
          debugLog("translation text chunk", {
            chars: text.length,
            totalChars: buffer.length,
          });
        } else if (chunk.type === "error" && chunk.message) {
          debugLog("translation chunk error", { message: chunk.message });
          overlay.setError(chunk.message);
        } else if (chunk.type === "usage") {
          usageLabel = formatUsageLabel(chunk.input, chunk.output, chunk.cacheRead);
          debugLog("translation usage", {
            input: chunk.input,
            output: chunk.output,
            cacheRead: chunk.cacheRead,
          });
        } else if (chunk.type === "done" && buffer) {
          setCachedTranslation(this.ctx.prefs, key, {
            text: buffer,
            model,
            createdAt: Date.now(),
          });
          latestTranslation = buffer;
          translationDone = true;
          if (usageLabel) overlay.setStatusLabel(`● 已完成 · ${usageLabel}`);
          else overlay.setDone();
          debugLog("translation done", { chars: buffer.length });
        } else if (chunk.type === "done") {
          debugLog("translation done empty");
          overlay.setError("模型没有返回译文。");
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      debugLog("translation threw", { error: message });
      if (this.overlay === overlay) overlay.setError(message);
    }
  }

  private async saveTranslationAnnotation(
    current: DetectedSentence,
    overlay: OverlayHandle,
    translation: string,
    done: boolean,
  ): Promise<void> {
    if (this.overlay !== overlay) return;
    const comment = translation.trim();
    if (!done || !comment) {
      overlay.setStatusLabel("● 完成后可保存");
      return;
    }
    if (!this.locator?.attachmentID) {
      overlay.setError("保存注释失败：未找到当前 PDF 附件。");
      return;
    }

    overlay.setStatusLabel("● 保存中…");
    try {
      const draft: SelectionAnnotationDraft = {
        text: current.text,
        attachmentID: this.locator.attachmentID,
        annotation: {
          text: current.text,
          color: "#ffd400",
          pageLabel: current.pageLabel,
          sortIndex: current.sortIndex,
          position: {
            pageIndex: current.pageIndex,
            rects: current.rects,
          },
        },
      };
      await saveSelectionAnnotation(draft, {
        comment,
        color: "#ffd400",
        type: "highlight",
      });
      if (this.overlay === overlay) overlay.setStatusLabel("● 已保存");
    } catch (err) {
      if (this.overlay === overlay) {
        overlay.setError(`保存注释失败：${errorMessage(err)}`);
      }
    }
  }

  private clearOverlay(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.overlay?.destroy();
    this.overlay = null;
  }

  private dismissOverlay(): void {
    this.clearOverlay();
    this.current = null;
  }
}


function keyEventWindows(win: Window): Window[] {
  const out: Window[] = [];
  let current: Window | null = win;
  for (let i = 0; i < 4 && current; i++) {
    if (!out.includes(current)) out.push(current);
    let parent: Window | null = null;
    try {
      parent = current.parent;
      if (!parent || parent === current) break;
      // Accessing document verifies we can install a listener in that realm.
      void parent.document;
    } catch {
      break;
    }
    current = parent;
  }
  return out;
}

function consumeKeyEvent(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation?.();
}

function readerWindow(reader: ReaderLike): Window | null {
  const r = reader as ReaderLike;
  return (
    r._internalReader?._primaryView?._iframeWindow ??
    r._internalReader?._secondaryView?._iframeWindow ??
    r._internalReader?._iframeWindow ??
    r._iframeWindow ??
    null
  );
}

function closestElement(node: Node | null, selector: string): Element | null {
  const start =
    node && node.nodeType === 1
      ? (node as Element)
      : ((node as { parentElement?: Element | null } | null)?.parentElement ??
        null);
  return typeof start?.closest === "function" ? start.closest(selector) : null;
}

function eventHitsPage(
  win: Window,
  clientX: number,
  clientY: number,
  target: Node | null,
): boolean {
  if (closestElement(target, ".page,[data-page-number]")) return true;

  // Zotero Reader resolves pointer hits with elementsFromPoint(), because the
  // event target can be a child overlay while the PDF page is underneath.
  const elements =
    typeof win.document.elementsFromPoint === "function"
      ? Array.from(win.document.elementsFromPoint(clientX, clientY))
      : [];
  return elements.some((el) => closestElement(el, ".page,[data-page-number]"));
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickOpenAiPreset(
  presets: ModelPreset[],
  desiredId: string,
): ModelPreset | null {
  const openai = presets.filter((p) => p.provider === "openai");
  if (!openai.length) return null;
  return openai.find((p) => p.id === desiredId) ?? openai[0]!;
}

function displayKey(formatted: string): string {
  return formatted.replace("Shift+Enter", "⇧↵").replace("Enter", "↵");
}

function contextLabel(level: string): string | undefined {
  if (level === "paragraph") return "上下文段落";
  if (level === "page") return "当前页上下文";
  return undefined;
}

function contextText(
  current: DetectedSentence,
  level: string,
): string | undefined {
  if (level === "paragraph") return current.paragraphContext;
  if (level === "page") return current.bundle.pageText;
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatUsageLabel(
  input: number | undefined,
  output: number | undefined,
  cacheRead: number | undefined,
): string {
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  const cacheTokens = cacheRead ?? 0;
  const cache = cacheTokens > 0 ? `，缓存 ${cacheTokens}` : "";
  return `token ${inputTokens}/${outputTokens}${cache}`;
}

function safeWindowUrl(win: Window): string {
  try {
    return win.location?.href ?? "(no location)";
  } catch (err) {
    return `(location threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function safeHasParent(win: Window): boolean | string {
  try {
    return win.parent !== win;
  } catch (err) {
    return `(parent threw: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function debugLog(message: string, extra?: Record<string, unknown>): void {
  logTranslateDebug("zai-translate-mode", message, extra);
}

// Zotero updates PDF text selections asynchronously after pointerup.
const SELECTION_STABILIZE_DELAY_MS = 80;
// Linux/Zotero PDF sometimes delivers pointerup without a reliable click event.
const CLICK_FALLBACK_DELAY_MS = 120;
const MODE_STYLE_ID = "zai-translate-mode-style";

function ensureModeStyle(doc: Document): void {
  if (doc.getElementById(MODE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = MODE_STYLE_ID;
  style.textContent = `
body.zai-translate-mode-on .page { cursor: crosshair !important; }
body.zai-translate-mode-on .textLayer span:hover {
  background: rgba(74, 140, 247, 0.10);
  border-radius: 2px;
}
`;
  (doc.head ?? doc.documentElement)?.append(style);
}
