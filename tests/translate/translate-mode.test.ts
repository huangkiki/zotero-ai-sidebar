import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateModeController } from "../../src/translate/translate-mode";
import type { PrefsStore } from "../../src/settings/storage";
import type { ModelPreset } from "../../src/settings/types";
import { translateSentence } from "../../src/translate/translator";

vi.mock("../../src/translate/translator", () => ({
  cleanTranslationOutput: (text: string) => text,
  translateSentence: vi.fn(async function* () {
    yield { type: "text", text: "译文" };
    yield { type: "done" };
  }),
  translationNeedsRetry: () => false,
}));

function prefs(triggerMode: "single" | "double"): PrefsStore {
  return {
    get: (key) =>
      key.endsWith(".translateSettings")
        ? JSON.stringify({ triggerMode })
        : undefined,
    set: () => undefined,
  };
}

function prefsWithPresets(
  triggerMode: "single" | "double",
  presets: ModelPreset[],
  presetId: string,
): PrefsStore {
  return {
    get: (key) => {
      if (key.endsWith(".translateSettings")) {
        return JSON.stringify({ enabled: true, triggerMode, presetId });
      }
      if (key.endsWith(".presets")) return JSON.stringify(presets);
      return undefined;
    },
    set: () => undefined,
  };
}

function readyController(triggerMode: "single" | "double") {
  const ctrl = new TranslateModeController({
    prefs: prefs(triggerMode),
    presets: [],
    reader: {},
  }) as unknown as Record<string, any>;
  const page = document.createElement("div");
  page.className = "page";
  document.body.append(page);
  document.body.classList.add("zai-translate-mode-on");
  (document as Document & { elementsFromPoint?: unknown }).elementsFromPoint =
    () => [page];
  ctrl.active = true;
  ctrl.boundWindow = window;
  ctrl.locator = {};
  ctrl.pointerStart = { x: 10, y: 10 };
  ctrl.handleActivation = vi.fn();
  return { ctrl, page };
}

beforeEach(() => {
  vi.mocked(translateSentence).mockClear();
});

function mouseUpAt(x = 10, y = 10): MouseEvent {
  return new MouseEvent("mouseup", {
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
  });
}

describe("TranslateModeController trigger routing", () => {
  it("uses the selected Anthropic preset for paragraph translation", async () => {
    const anthropicPreset: ModelPreset = {
      id: "deepseek",
      label: "DeepSeek",
      provider: "anthropic",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-pro",
      maxTokens: 8192,
    };
    const translations: string[] = [];
    const ctrl = new TranslateModeController({
      prefs: prefsWithPresets("single", [anthropicPreset], "deepseek"),
      presets: [anthropicPreset],
      reader: {},
      showOverlay: false,
      onParagraphTranslation: (result) => translations.push(result.translation),
    }) as unknown as Record<string, any>;
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    document.body.append(page);
    ctrl.active = true;
    ctrl.boundWindow = window;
    ctrl.current = {
      text: "We describe a new model.",
      pageIndex: 0,
      pageLabel: "1",
      rects: [],
      sortIndex: 0,
      bundle: {
        pageIndex: 0,
        pageLabel: "1",
        pageText: "We describe a new model.",
      },
    };

    await ctrl.renderForCurrent();

    expect(translateSentence).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: expect.objectContaining({ provider: "anthropic" }),
        model: "deepseek-v4-pro",
      }),
    );
    expect(translations).toEqual(["译文"]);
    page.remove();
  });

  it("activates immediately on pointerup in single-click mode", () => {
    const { ctrl, page } = readyController("single");
    const ev = mouseUpAt();
    page.dispatchEvent(ev);

    ctrl.handleTranslatePointerUp(ev);

    expect(ctrl.handleActivation).toHaveBeenCalledTimes(1);
    expect(ctrl.handleActivation).toHaveBeenCalledWith(10, 10, false);
    page.remove();
  });

  it("waits for the second pointerup in double-click mode", () => {
    const { ctrl, page } = readyController("double");
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

  it("routes Enter and Shift+Enter to next and previous paragraph", () => {
    const { ctrl, page } = readyController("single");
    ctrl.current = { pageSentenceIndex: 1, pageSentenceCount: 3 };
    ctrl.jump = vi.fn();

    const next = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
    });
    ctrl.handleKey(next);
    expect(ctrl.jump).toHaveBeenCalledWith(1);
    expect(next.defaultPrevented).toBe(true);

    const prev = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      cancelable: true,
    });
    ctrl.handleKey(prev);
    expect(ctrl.jump).toHaveBeenCalledWith(-1);
    expect(prev.defaultPrevented).toBe(true);
    page.remove();
  });

  it("does not treat the translate toolbar button as a page click", () => {
    const { ctrl, page } = readyController("single");
    const button = document.createElement("button");
    button.className = "zai-reader-translate-button";
    document.body.append(button);
    ctrl.handleActivation = vi.fn();

    const ev = mouseUpAt();
    Object.defineProperty(ev, "target", { value: button });
    ctrl.scheduleActivation(ev, false);

    expect(ctrl.handleActivation).not.toHaveBeenCalled();
    button.remove();
    page.remove();
  });

  it("jumps using the locator paragraph index from the original PDF chars", async () => {
    const { ctrl, page } = readyController("single");
    const bundle = {
      pageIndex: 0,
      pageLabel: "1",
      pageText: "First. Second.",
      normalizedText: "first. second.",
      normalizedToOriginal: Array.from({ length: 14 }, (_, index) => index),
    };
    const located = {
      text: "Second.",
      pageIndex: 0,
      pageLabel: "1",
      rects: [[10, 10, 50, 20]],
      sortIndex: "00000|000007|00010",
      pageSentenceIndex: 1,
      pageSentenceCount: 2,
      paragraphContext: "First. Second.",
    };
    ctrl.current = {
      text: "First.",
      pageIndex: 0,
      pageLabel: "1",
      rects: [[0, 10, 40, 20]],
      sortIndex: "00000|000000|00010",
      pageSentenceIndex: 0,
      pageSentenceCount: 2,
      paragraphContext: "First. Second.",
      bundle,
    };
    ctrl.locator = {
      paragraphAtIndex: vi.fn(async () => located),
      getPageContent: vi.fn(async () => bundle),
    };
    ctrl.renderForCurrent = vi.fn();

    await ctrl.jump(1);

    expect(ctrl.locator.paragraphAtIndex).toHaveBeenCalledWith(0, 1);
    expect(ctrl.current.text).toBe("Second.");
    expect(ctrl.current.bundle).toBe(bundle);
    expect(ctrl.renderForCurrent).toHaveBeenCalledTimes(1);
    page.remove();
  });
});
