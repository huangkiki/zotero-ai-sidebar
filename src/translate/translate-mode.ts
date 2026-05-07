import { createPdfLocator, type PdfLocator } from '../context/pdf-locator';
import { detectSentenceAtPoint, type DetectedSentence } from './sentence-detect';
import { mountOverlay, type OverlayHandle } from './overlay';
import { translateSentence } from './translator';
import { cacheKey, getCachedTranslation, setCachedTranslation } from './cache';
import { loadTranslateSettings } from './settings';
import { matchesKeybinding, parseKeybinding } from './keybinding';
import { splitSentences } from './sentence-splitter';
import type { ModelPreset } from '../settings/types';
import type { PrefsStore } from '../settings/storage';

interface ReaderLike {
  _internalReader?: {
    _primaryView?: { _iframeWindow?: Window };
  };
}

export interface TranslateModeContext {
  prefs: PrefsStore;
  presets: ModelPreset[];
  reader: ReaderLike;
}

export class TranslateModeController {
  private overlay: OverlayHandle | null = null;
  private current: DetectedSentence | null = null;
  private locator: PdfLocator | null = null;
  private clickHandler: ((ev: MouseEvent) => void) | null = null;
  private keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  private abortCtrl: AbortController | null = null;
  private boundWindow: Window | null = null;

  constructor(private ctx: TranslateModeContext) {}

  async enable(): Promise<void> {
    const win = this.ctx.reader._internalReader?._primaryView?._iframeWindow;
    if (!win) return;
    if (!this.locator) {
      this.locator = await createPdfLocator(this.ctx.reader);
    }

    this.boundWindow = win;
    this.clickHandler = (ev) => { void this.handleClick(ev); };
    this.keyHandler = (ev) => { this.handleKey(ev); };
    win.addEventListener('click', this.clickHandler, true);
    win.addEventListener('keydown', this.keyHandler, true);
  }

  disable(): void {
    if (this.boundWindow && this.clickHandler) {
      this.boundWindow.removeEventListener('click', this.clickHandler, true);
    }
    if (this.boundWindow && this.keyHandler) {
      this.boundWindow.removeEventListener('keydown', this.keyHandler, true);
    }
    this.boundWindow = null;
    this.clickHandler = null;
    this.keyHandler = null;
    this.dismissOverlay();
    this.locator?.dispose();
    this.locator = null;
  }

  private async handleClick(ev: MouseEvent): Promise<void> {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('.zai-translate-overlay')) return;
    if (!this.boundWindow || !this.locator) return;

    const detected = await detectSentenceAtPoint({
      iframeWindow: this.boundWindow as never,
      clientX: ev.clientX,
      clientY: ev.clientY,
      locator: this.locator,
    });
    if (!detected) return;

    ev.preventDefault();
    ev.stopPropagation();
    this.current = detected;
    await this.renderForCurrent();
  }

  private handleKey(ev: KeyboardEvent): void {
    if (!this.current) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const next = parseKeybinding(settings.nextSentenceKey);
    const prev = parseKeybinding(settings.prevSentenceKey);
    if (next && matchesKeybinding(ev, next)) {
      ev.preventDefault();
      void this.jump(+1);
    } else if (prev && matchesKeybinding(ev, prev)) {
      ev.preventDefault();
      void this.jump(-1);
    } else if (ev.key === 'Escape') {
      this.dismissOverlay();
    }
  }

  private async jump(delta: number): Promise<void> {
    if (!this.current || !this.locator) return;
    const targetIndex = this.current.pageSentenceIndex + delta;
    if (targetIndex < 0 || targetIndex >= this.current.pageSentenceCount) return;
    const all = splitSentences(this.current.bundle.normalizedText);
    const span = all[targetIndex];
    if (!span) return;
    const origStart = this.current.bundle.normalizedToOriginal[span.start] ?? -1;
    const origEnd = this.current.bundle.normalizedToOriginal[Math.max(0, span.end - 1)] ?? -1;
    if (origStart < 0 || origEnd < 0) return;
    const text = this.current.bundle.pageText.slice(origStart, origEnd + 1).trim();
    if (!text) return;
    const located = await this.locator.locate(text, { minConfidence: 0.6 });
    if (!located) return;
    this.current = {
      ...this.current,
      text,
      pageIndex: located.pageIndex,
      pageLabel: located.pageLabel,
      rects: located.rects,
      sortIndex: located.sortIndex,
      pageSentenceIndex: targetIndex,
    };
    await this.renderForCurrent();
  }

  private async renderForCurrent(): Promise<void> {
    if (!this.current || !this.boundWindow) return;
    const settings = loadTranslateSettings(this.ctx.prefs);
    const preset = pickOpenAiPreset(this.ctx.presets, settings.presetId);
    if (!preset) return;
    const model = settings.model || preset.model;

    const pageEl = this.boundWindow.document.querySelector(
      `.page[data-page-number="${this.current.pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return;

    this.dismissOverlay();
    this.abortCtrl = new AbortController();

    const key = cacheKey({
      sentence: this.current.text,
      target: 'zh',
      endpoint: preset.baseUrl,
      model,
      thinking: settings.thinking,
      ctxLevel: settings.ctxLevel,
    });
    const cached = getCachedTranslation(this.ctx.prefs, key);

    const hint = `S 存 · ${displayKey(settings.nextSentenceKey)} 下 · ${displayKey(settings.prevSentenceKey)} 上`;

    this.overlay = mountOverlay({
      iframeDoc: this.boundWindow.document,
      pageEl,
      rects: this.current.rects,
      pageContent: this.current.bundle,
      position: settings.overlayPosition,
      initialText: cached?.text,
      actions: {
        onClose: () => this.dismissOverlay(),
        onPrev: () => void this.jump(-1),
        onNext: () => void this.jump(+1),
        hint,
      },
    });

    if (cached) return;

    let buffer = '';
    for await (const chunk of translateSentence({
      sentence: this.current.text,
      paragraphContext: settings.ctxLevel === 'paragraph' ? this.current.paragraphContext : undefined,
      preset,
      model,
      thinking: settings.thinking,
      signal: this.abortCtrl.signal,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        this.overlay?.appendText(chunk.text);
        buffer += chunk.text;
      } else if (chunk.type === 'error' && chunk.message) {
        this.overlay?.setError(chunk.message);
      } else if (chunk.type === 'done' && buffer) {
        setCachedTranslation(this.ctx.prefs, key, {
          text: buffer,
          model,
          createdAt: Date.now(),
        });
      }
    }
  }

  private dismissOverlay(): void {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.current = null;
  }
}

function pickOpenAiPreset(presets: ModelPreset[], desiredId: string): ModelPreset | null {
  const openai = presets.filter((p) => p.provider === 'openai');
  if (!openai.length) return null;
  return openai.find((p) => p.id === desiredId) ?? openai[0]!;
}

function displayKey(formatted: string): string {
  return formatted
    .replace('Shift+Enter', '⇧↵')
    .replace('Enter', '↵');
}
