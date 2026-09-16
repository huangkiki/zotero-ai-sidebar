import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localizeUiTree, uiText } from "../../src/i18n";
import {
  DEFAULT_UI_LANGUAGE,
  loadUiLanguage,
  saveUiLanguage,
} from "../../src/settings/language";
import type { PrefsStore } from "../../src/settings/storage";
import {
  REASONING_EFFORT_OPTIONS,
  REASONING_SUMMARY_OPTIONS,
} from "../../src/settings/types";
import {
  DEFAULT_SUMMARY_PROMPT_EN,
  loadQuickPromptSettings,
} from "../../src/settings/quick-prompts";
import {
  DEFAULT_ANNOTATION_COLOR_GUIDE,
  DEFAULT_ANNOTATION_COLOR_GUIDE_EN,
  loadToolSettings,
} from "../../src/settings/tool-settings";

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe("interface language", () => {
  afterEach(() => {
    delete (globalThis as { Zotero?: unknown }).Zotero;
  });

  it("defaults to Chinese and persists a validated English choice", () => {
    const prefs = memPrefs();
    expect(loadUiLanguage(prefs)).toBe(DEFAULT_UI_LANGUAGE);
    saveUiLanguage(prefs, "en-US");
    expect(loadUiLanguage(prefs)).toBe("en-US");
  });

  it("translates labels, tooltips, placeholders, and dynamic labels", () => {
    expect(uiText("设置", "en-US")).toBe("Settings");
    expect(uiText("隐藏", "en-US")).toBe("Hide");
    expect(uiText("没有打开的对话", "en-US")).toBe("No chat is open");
    expect(
      uiText("选择已有对话，或新建一个对话后再输入。", "en-US"),
    ).toBe("Select an existing chat, or create a new one before typing.");
    expect(uiText("批量译(3)", "en-US")).toBe("Translate all (3)");
    expect(uiText("复制MD", "en-US")).toBe("Copy Markdown");
    expect(uiText("字号", "en-US")).toBe("Font size");
    expect(uiText("13px 默认", "en-US")).toBe("13px default");
    expect(uiText("调试", "en-US")).toBe("Debug");
    expect(uiText("🔖 全文重点", "en-US")).toBe(
      "🔖 Highlight key passages",
    );
    expect(uiText("截图", "en-US")).toBe("Screenshot");
    expect(uiText("图片", "en-US")).toBe("Image");
    expect(uiText("Auto - 由模型决定", "en-US")).toBe(
      "Auto — decided by the model",
    );
    expect(
      uiText(
        "未找到本机 Codex。请安装 ChatGPT/Codex 桌面应用或 Codex CLI，并先通过 ChatGPT 账号登录。",
        "en-US",
      ),
    ).toBe(
      "Could not find Codex on this computer. Install the ChatGPT/Codex desktop app or Codex CLI, then sign in with your ChatGPT account.",
    );
    expect(
      uiText(
        "已就绪。这个对话已绑定到当前论文，可以直接询问 Zotero 条目或 PDF 内容。",
        "en-US",
      ),
    ).toBe(
      "Ready. This chat is linked to the current paper; ask about the Zotero item or PDF directly.",
    );
    expect(
      uiText(
        "已就绪。这个对话未绑定论文；选中论文后点输入框上方的 + 可为该论文新建对话。",
        "en-US",
      ),
    ).toBe(
      "Ready. This chat is not linked to a paper. Select a paper and use the + above the composer to create a paper chat.",
    );
    expect(uiText("设置", "zh-CN")).toBe("设置");

    const root = document.createElement("div");
    root.innerHTML = '<button title="隐藏 AI 对话">设置</button>';
    const input = document.createElement("input");
    input.placeholder = "例如：t";
    root.append(input);
    const composer = document.createElement("textarea");
    composer.value = "保留用户输入";
    composer.placeholder = "问点什么... (Enter 发送，Shift+Enter 换行)";
    root.append(composer);
    localizeUiTree(root, "en-US");
    expect(root.querySelector("button")?.textContent).toBe("Settings");
    expect(root.querySelector("button")?.title).toBe("Hide AI chat");
    expect(input.placeholder).toBe("For example: T");
    expect(composer.value).toBe("保留用户输入");
    expect(composer.placeholder).toBe(
      "Ask anything… (Enter to send, Shift+Enter for a new line)",
    );

    localizeUiTree(root, "zh-CN");
    expect(root.querySelector("button")?.textContent).toBe("设置");
    expect(root.querySelector("button")?.title).toBe("隐藏 AI 对话");
    expect(input.placeholder).toBe("例如：t");
    expect(composer.value).toBe("保留用户输入");
    expect(composer.placeholder).toBe(
      "问点什么... (Enter 发送，Shift+Enter 换行)",
    );
  });

  it("uses English built-in prompts without translating custom user prompts", () => {
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => "en-US" },
    };
    const prefs = memPrefs();
    const defaults = loadQuickPromptSettings(prefs);
    expect(defaults.builtIns.summary).toBe(DEFAULT_SUMMARY_PROMPT_EN);

    prefs.set(
      "extensions.zotero-ai-sidebar.quickPrompts",
      JSON.stringify({
        builtIns: {
          summary: "My custom summary prompt",
          fullTextHighlight: "My highlight prompt",
          explainSelection: "My explanation prompt",
        },
        customButtons: [
          { id: "mine", label: "我的按钮", prompt: "保留我的原文" },
        ],
      }),
    );
    const customized = loadQuickPromptSettings(prefs);
    expect(customized.builtIns.summary).toBe("My custom summary prompt");
    expect(customized.customButtons[0]).toMatchObject({
      label: "我的按钮",
      prompt: "保留我的原文",
    });
  });

  it("localizes only the built-in annotation color guide", () => {
    (globalThis as { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => "en-US" },
    };
    const prefs = memPrefs();
    prefs.set(
      "extensions.zotero-ai-sidebar.toolSettings",
      JSON.stringify({ annotationColorGuide: DEFAULT_ANNOTATION_COLOR_GUIDE }),
    );
    expect(loadToolSettings(prefs).annotationColorGuide).toBe(
      DEFAULT_ANNOTATION_COLOR_GUIDE_EN,
    );

    prefs.set(
      "extensions.zotero-ai-sidebar.toolSettings",
      JSON.stringify({ annotationColorGuide: "我的自定义颜色说明" }),
    );
    expect(loadToolSettings(prefs).annotationColorGuide).toBe(
      "我的自定义颜色说明",
    );
  });

  it("covers every static preference-pane label and tooltip", () => {
    const source = readFileSync(
      join(process.cwd(), "addon/content/preferences.xhtml"),
      "utf8",
    );
    const root = document.createElement("div");
    root.innerHTML = source;
    localizeUiTree(root, "en-US");

    const visible = [root.textContent ?? ""];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      for (const attribute of ["title", "tooltiptext", "placeholder", "aria-label"]) {
        visible.push(element.getAttribute(attribute) ?? "");
      }
    }
    expect(visible.join("\n")).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("covers every dynamic reasoning option in the settings UI", () => {
    for (const [, label] of [
      ...REASONING_EFFORT_OPTIONS,
      ...REASONING_SUMMARY_OPTIONS,
    ]) {
      expect(uiText(label, "en-US")).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });
});
