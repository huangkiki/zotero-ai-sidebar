import { describe, expect, it, vi } from 'vitest';
import { TranslateModeController } from '../../src/translate/translate-mode';
import type { PrefsStore } from '../../src/settings/storage';

function prefs(triggerMode: 'single' | 'double'): PrefsStore {
  return {
    get: (key) => key.endsWith('.translateSettings')
      ? JSON.stringify({ triggerMode })
      : undefined,
    set: () => undefined,
  };
}

function readyController(triggerMode: 'single' | 'double') {
  const ctrl = new TranslateModeController({
    prefs: prefs(triggerMode),
    presets: [],
    reader: {},
  }) as unknown as Record<string, any>;
  const page = document.createElement('div');
  page.className = 'page';
  document.body.append(page);
  document.body.classList.add('zai-translate-mode-on');
  (document as Document & { elementsFromPoint?: unknown }).elementsFromPoint = () => [page];
  ctrl.active = true;
  ctrl.boundWindow = window;
  ctrl.locator = {};
  ctrl.pointerStart = { x: 10, y: 10 };
  ctrl.handleActivation = vi.fn();
  return { ctrl, page };
}

function mouseUpAt(x = 10, y = 10): MouseEvent {
  return new MouseEvent('mouseup', {
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
  });
}

describe('TranslateModeController trigger routing', () => {
  it('activates immediately on pointerup in single-click mode', () => {
    const { ctrl, page } = readyController('single');
    const ev = mouseUpAt();
    page.dispatchEvent(ev);

    ctrl.handleTranslatePointerUp(ev);

    expect(ctrl.handleActivation).toHaveBeenCalledTimes(1);
    expect(ctrl.handleActivation).toHaveBeenCalledWith(10, 10, false);
    page.remove();
  });

  it('waits for the second pointerup in double-click mode', () => {
    const { ctrl, page } = readyController('double');
    const first = mouseUpAt();
    page.dispatchEvent(first);
    ctrl.handleTranslatePointerUp(first);
    expect(ctrl.handleActivation).not.toHaveBeenCalled();

    const second = mouseUpAt();
    page.dispatchEvent(second);
    ctrl.handleTranslatePointerUp(second);

    expect(ctrl.handleActivation).toHaveBeenCalledTimes(1);
    expect(ctrl.handleActivation).toHaveBeenCalledWith(10, 10, false);
    page.remove();
  });

  it('routes Enter and Shift+Enter to next and previous sentence', () => {
    const { ctrl, page } = readyController('single');
    ctrl.current = { pageSentenceIndex: 1, pageSentenceCount: 3 };
    ctrl.jump = vi.fn();

    const next = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    ctrl.handleKey(next);
    expect(ctrl.jump).toHaveBeenCalledWith(1);
    expect(next.defaultPrevented).toBe(true);

    const prev = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      cancelable: true,
    });
    ctrl.handleKey(prev);
    expect(ctrl.jump).toHaveBeenCalledWith(-1);
    expect(prev.defaultPrevented).toBe(true);
    page.remove();
  });

  it('jumps using the locator sentence index from the original PDF chars', async () => {
    const { ctrl, page } = readyController('single');
    const bundle = {
      pageIndex: 0,
      pageLabel: '1',
      pageText: 'First. Second.',
      normalizedText: 'first. second.',
      normalizedToOriginal: Array.from({ length: 14 }, (_, index) => index),
    };
    const located = {
      text: 'Second.',
      pageIndex: 0,
      pageLabel: '1',
      rects: [[10, 10, 50, 20]],
      sortIndex: '00000|000007|00010',
      pageSentenceIndex: 1,
      pageSentenceCount: 2,
      paragraphContext: 'First. Second.',
    };
    ctrl.current = {
      text: 'First.',
      pageIndex: 0,
      pageLabel: '1',
      rects: [[0, 10, 40, 20]],
      sortIndex: '00000|000000|00010',
      pageSentenceIndex: 0,
      pageSentenceCount: 2,
      paragraphContext: 'First. Second.',
      bundle,
    };
    ctrl.locator = {
      sentenceAtIndex: vi.fn(async () => located),
      getPageContent: vi.fn(async () => bundle),
    };
    ctrl.renderForCurrent = vi.fn();

    await ctrl.jump(1);

    expect(ctrl.locator.sentenceAtIndex).toHaveBeenCalledWith(0, 1);
    expect(ctrl.current.text).toBe('Second.');
    expect(ctrl.current.bundle).toBe(bundle);
    expect(ctrl.renderForCurrent).toHaveBeenCalledTimes(1);
    page.remove();
  });
});
