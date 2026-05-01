import { buildContext } from "../context/builder";
import {
  createZoteroAgentToolSession,
  saveSelectionAnnotation,
  type SelectionAnnotationDraft,
  type ZoteroAgentToolSession,
} from "../context/agent-tools";
import { parseAnnotationSuggestion } from "../context/annotation-draft";
import {
  contextSummaryLine,
  formatContextMarkdown,
  formatContextLedger,
  formatUserMessageForApi,
  retainedContextStats,
  toApiMessages,
} from "../context/message-format";
import { DEFAULT_CONTEXT_POLICY } from "../context/policy";
import { zoteroContextSource } from "../context/zotero-source";
import { getProvider } from "../providers/factory";
import type { AssistantAnnotationDraft, Message } from "../providers/types";
import { loadChatMessages, saveChatMessages } from "../settings/chat-history";
import { loadPresets, savePresets, zoteroPrefs } from "../settings/storage";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  MODEL_SUGGESTIONS,
  REASONING_EFFORT_OPTIONS,
  REASONING_SUMMARY_OPTIONS,
  type AgentPermissionMode,
  type ModelPreset,
  type ProviderKind,
  type ReasoningEffort,
  type ReasoningSummary,
} from "../settings/types";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const COLUMN_ID = "zai-column";
const SPLITTER_ID = "zai-column-splitter";
const ROOT_ID = "zai-root";
const TOGGLE_BUTTON_ID = "zai-toggle-button";
const FLOATING_TOGGLE_ID = "zai-floating-toggle";
const contextPolicy = DEFAULT_CONTEXT_POLICY;
const IMAGE_PROMPT_MAX_DIMENSION = 2048;
// "Annotate this paper" preset prompt.
//
// This is the user-facing instruction injected when the user clicks the
// quick prompt for full-text highlighting. It pairs with the
// `fullTextHighlight: true` tool-set in agent-tools.ts (which restricts
// writes to `zotero_annotate_passage` and removes the selection-based
// write tool).
//
// Each numbered step matches a harness contract:
//   1-2. Read the full PDF; if the harness truncates due to
//        `policy.fullPdfTokenBudget`, top up via `zotero_read_pdf_range`.
//   3.   Limit to 5-10 highlights so we don't blow `maxFullTextHighlights`
//        (default 10). Anti-noise guidance ("avoid summary spans,
//        equations") matches what users actually want highlighted.
//   4.   `text` must be VERBATIM — pdf-locator's exact-match path is fast,
//        the fuzzy fallback (≥0.85 confidence) handles minor OCR drift.
//        80-char comment cap matches `maxFullTextHighlightCommentChars`.
//   5.   Forces a final summary turn so the model exits the tool loop.
//
// The retry-with-rewrite hint addresses the locator's known weakness on
// dehyphenation / column-break artifacts; rewrites preserving ≥80% of the
// original text usually push fuzzy-match confidence past threshold.
const FULL_TEXT_HIGHLIGHT_PROMPT = [
  "请执行以下流程，对当前 PDF 标注重点：",
  "",
  "1. 调用 zotero_get_full_pdf 一次，读取当前 PDF 文本。",
  "2. 如果工具输出显示全文被截断（Truncated: yes / sent chars < total chars），请用 zotero_read_pdf_range 补读未覆盖的关键范围，尽量覆盖全文后再选择重点。",
  "3. 通读后，从中选出 5–10 条最值得标注的重点句（论点、关键定义、核心结果、关键限制、贡献点等），避免标摘要性的整段、避免标公式。",
  "4. 对每一条调用 zotero_annotate_passage：",
  "   - text 字段必须是 PDF 中的逐字原文，不要改写、不要翻译、不要省略标点。",
  "   - comment 字段用中文，简洁说明“这句话为什么重要”，≤ 80 字。",
  "   - color 字段不传，使用默认色。",
  "5. 全部标注完成后，再用一段中文总结：标了哪几句、整体读后感、可能漏掉的角度。",
  "",
  "注意：",
  "- 不要调用其它写工具。",
  "- 本轮工具环境只允许 zotero_annotate_passage 这个批量写工具；如果达到工具返回的 highlight limit，请停止写入并总结已保存内容。",
  '- 如果某句调用 zotero_annotate_passage 返回 "Passage not found"，可以稍微改写后重试（保持原句 80% 以上文字不变）；连续两次都找不到就放弃这句、继续下一条。',
].join("\n");

let registered = false;

interface WindowSidebarState {
  column: Element;
  splitter: Element;
  mount: HTMLElement;
  toggleButton?: Element;
  floatingButton?: HTMLElement;
  selectionMonitorID?: number;
  originalItemSelected?: (...args: unknown[]) => unknown;
  patchedItemSelected?: (...args: unknown[]) => unknown;
}

const windowSidebars = new WeakMap<Window, WindowSidebarState>();
const mountedWindows = new Set<Window>();
const selectedTextByItem = new Map<number, string>();
const selectedAnnotationByItem = new Map<number, SelectionAnnotationDraft>();
const ignoredSelectedTextByItem = new Map<number, string>();
let readerSelectionHandler: ((event: unknown) => void) | null = null;
const SELECTION_MONITOR_MS = 60;

interface PasteBlock {
  id: number;
  marker: string;
  text: string;
  lineCount: number;
}

interface DraftImage {
  id: string;
  marker: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
}

interface PanelState {
  itemID: number | null;
  presets: ModelPreset[];
  selectedId: string | null;
  editing: boolean;
  messages: Message[];
  historyLoaded: boolean;
  sending: boolean;
  scrollToBottom?: boolean;
  focusInput?: boolean;
  draftText: string;
  draftSelectionStart: number;
  draftSelectionEnd: number;
  draftHadFocus: boolean;
  messagesScrollTop: number;
  autoFollowMessages: boolean;
  skipNextDraftCapture?: boolean;
  activeAssistantIndex?: number;
  activeAssistantStage?: AssistantProgressStage;
  agentPermissionMode: AgentPermissionMode;
  pasteBlocks: PasteBlock[];
  draftImages: DraftImage[];
  nextPasteID: number;
  abort?: AbortController;
}

// Panel-state survival
// =====================================================================
// Each rendered sidebar mount carries a PanelState in this WeakMap. The
// mount is the GC root: when the Zotero window closes, the mount drops
// out, and the WeakMap entry goes with it (no manual cleanup needed).
//
// INVARIANT: rendering is FULL-REPLACE — `renderPanel` calls
// `mount.replaceChildren()` and rebuilds. WHY full replace (not diff):
// the sidebar is small, full replace is simpler than reconciliation, and
// it's the same pattern as Zotero's own ItemPane sub-panels. The cost
// (lost draft text + scroll position on every render) is paid by
// `capturePanelState` (saves into `state` BEFORE replace) and then
// `restoreMessagesScroll` + `restoreChatInput` (reapplied AFTER replace).
const states = new WeakMap<Element, PanelState>();

type AssistantProgressStage =
  | "starting"
  | "building_context"
  | "waiting_model"
  | "thinking"
  | "using_tool"
  | "writing";

// Entry point per Zotero item selection.
// Two paths:
//   - itemID changed (or first render): allocate fresh PanelState and
//     kick off async history load. Old state is DROPPED — switching items
//     means switching threads.
//   - same itemID: reload presets (user may have edited them in the
//     editor overlay) and reuse existing messages/draft/scroll state.
function renderMount(mount: HTMLElement, itemID: number | null) {
  let state = states.get(mount);
  if (!state || state.itemID !== itemID) {
    const presets = loadPresets(zoteroPrefs());
    state = {
      itemID,
      presets,
      selectedId: presets[0]?.id ?? null,
      editing: presets.length === 0,
      messages: [],
      historyLoaded: false,
      sending: false,
      draftText: "",
      draftSelectionStart: 0,
      draftSelectionEnd: 0,
      draftHadFocus: false,
      messagesScrollTop: 0,
      autoFollowMessages: true,
      agentPermissionMode: agentPermissionMode(presets[0]),
      pasteBlocks: [],
      draftImages: [],
      nextPasteID: 1,
    };
    states.set(mount, state);
    void loadPersistedMessages(mount, state);
  } else {
    state.presets = loadPresets(zoteroPrefs());
    if (
      state.selectedId &&
      !state.presets.find((p) => p.id === state!.selectedId)
    ) {
      state.selectedId = state.presets[0]?.id ?? null;
    }
    if (state.presets.length === 0) state.editing = true;
    state.agentPermissionMode = agentPermissionMode(
      selectedChatPreset(state) ?? selectedPreset(state),
    );
  }

  renderPanel(mount, state);
}

function renderPanel(mount: HTMLElement, state: PanelState) {
  const doc = mount.ownerDocument!;
  capturePanelState(mount, state);
  refreshActiveReaderSelection(doc.defaultView, state.itemID, false);
  mount.replaceChildren();

  const panel = el(doc, "div", "zai-app native-panel");
  panel.append(renderToolbar(doc, mount, state));
  if (state.editing || state.presets.length === 0) {
    panel.append(renderPresetEditor(doc, mount, state));
  }
  panel.append(renderContextCard(doc, state.itemID));
  panel.append(renderMessages(doc, mount, state));
  panel.append(renderInput(doc, mount, state));

  mount.append(panel);
  const shouldScroll = state.scrollToBottom;
  const shouldFocus = state.focusInput;
  state.scrollToBottom = false;
  state.focusInput = false;
  afterRender(mount, () => {
    restoreMessagesScroll(mount, state, !!shouldScroll);
    restoreChatInput(mount, state, !!shouldFocus);
  });
}

// Captures DOM-resident state into PanelState BEFORE renderPanel wipes
// the DOM. Two pieces of survival:
//   1. Draft textarea content + selection range (so the user's typing
//      survives streaming re-renders).
//   2. Messages list scrollTop (so the auto-follow-vs-pinned-scroll
//      decision in restoreMessagesScroll has accurate state).
//
// `skipNextDraftCapture` is the one-shot flag set by sendMessage AFTER
// it clears the draft. WHY: the textarea DOM still holds the just-sent
// text on the next render (until `restoreChatInput` reapplies the empty
// state.draftText). Without this flag, capture would copy the still-
// rendered old text back into state, undoing the clear.
function capturePanelState(mount: HTMLElement, state: PanelState) {
  if (!state.skipNextDraftCapture) {
    const input = mount.querySelector(
      ".input-row textarea",
    ) as HTMLTextAreaElement | null;
    if (input) {
      captureDraftFromInput(input, state);
    }
  }
  state.skipNextDraftCapture = false;

  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (messages) {
    state.messagesScrollTop = messages.scrollTop;
  }
}

function captureDraftFromInput(
  input: HTMLTextAreaElement,
  state: PanelState,
  captureFocus = true,
) {
  state.draftText = input.value;
  state.draftSelectionStart = clampOffset(
    input.selectionStart ?? input.value.length,
    input.value,
  );
  state.draftSelectionEnd = clampOffset(
    input.selectionEnd ?? state.draftSelectionStart,
    input.value,
  );
  if (captureFocus) {
    state.draftHadFocus = input.ownerDocument?.activeElement === input;
  }
}

function renderToolbar(doc: Document, mount: HTMLElement, state: PanelState) {
  const toolbarPresets = state.editing
    ? state.presets
    : configuredPresets(state);
  const selectedForToolbar = state.editing
    ? selectedPreset(state)
    : selectedChatPreset(state);
  const bar = el(
    doc,
    "div",
    toolbarPresets.length ? "preset-switcher" : "preset-empty",
  );
  const title = el(doc, "strong", "", "AI 对话");
  bar.append(title);

  if (toolbarPresets.length === 0) {
    bar.append(el(doc, "span", "", "未配置模型"));
    const button = buttonEl(doc, "添加模型");
    button.addEventListener("click", () => {
      state.editing = true;
      renderPanel(mount, state);
    });
    bar.append(button);
    return bar;
  }

  const select = doc.createElement("select");
  select.value = selectedForToolbar?.id ?? "";
  for (const preset of toolbarPresets) {
    const option = doc.createElement("option");
    option.value = preset.id;
    option.textContent = `${preset.label} (${preset.provider} · ${preset.model || "no model"})`;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.selectedId = select.value;
    state.editing = false;
    state.agentPermissionMode = agentPermissionMode(
      selectedChatPreset(state) ?? selectedPreset(state),
    );
    renderPanel(mount, state);
  });
  bar.append(select);

  const settings = buttonEl(doc, state.editing ? "收起" : "设置");
  settings.addEventListener("click", () => {
    state.editing = !state.editing;
    renderPanel(mount, state);
  });
  if (state.messages.length > 0) {
    const copyAll = buttonEl(doc, "复制MD");
    copyAll.title = "复制当前对话为 Markdown";
    copyAll.addEventListener("click", () => {
      void copyToClipboard(doc, formatConversationMarkdown(state));
      flashButton(copyAll, "已复制");
    });
    bar.append(copyAll);

    const clear = buttonEl(doc, "清空");
    clear.disabled = state.sending;
    clear.title = "清空并保存当前条目的聊天记录";
    clear.addEventListener("click", () => {
      state.messages = [];
      void saveChatMessages(state.itemID, state.messages);
      renderPanel(mount, state);
    });
    bar.append(clear);
  }
  bar.append(settings);
  const hide = buttonEl(doc, "隐藏");
  hide.title = "隐藏 AI 对话列";
  hide.addEventListener("click", () => hideCurrentSidebar(mount));
  bar.append(hide);
  return bar;
}

function renderPresetEditor(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
) {
  let current = selectedPreset(state);
  if (!current) {
    current = makePreset("openai");
    state.presets = [...state.presets, current];
    state.selectedId = current.id;
  }
  const draft = current;
  const box = el(doc, "div", "preset-edit native-preset-edit");

  const provider = selectEl(doc, [
    ["openai", "OpenAI 兼容"],
    ["anthropic", "Anthropic"],
  ]);
  provider.value = draft.provider;
  const label = inputEl(doc, draft.label);
  const apiKey = inputEl(doc, draft.apiKey, "password");
  const baseUrl = inputEl(
    doc,
    draft.baseUrl || DEFAULT_BASE_URLS[draft.provider],
  );
  const model = inputEl(doc, draft.model || DEFAULT_MODELS[draft.provider]);
  const modelListId = `zai-models-${makeId()}`;
  model.setAttribute("list", modelListId);
  const maxTokens = inputEl(doc, String(draft.maxTokens || 8192), "number");
  const reasoningEffort = selectEl(doc, REASONING_EFFORT_OPTIONS);
  reasoningEffort.value =
    draft.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  reasoningEffort.disabled = draft.provider !== "openai";
  const reasoningSummary = selectEl(doc, REASONING_SUMMARY_OPTIONS);
  reasoningSummary.value =
    draft.extras?.reasoningSummary ?? DEFAULT_REASONING_SUMMARY;
  reasoningSummary.disabled = draft.provider !== "openai";
  const modelList = doc.createElement("datalist");
  modelList.id = modelListId;
  for (const suggestion of MODEL_SUGGESTIONS[draft.provider]) {
    const option = doc.createElement("option");
    option.value = suggestion;
    modelList.append(option);
  }

  const readDraft = (): ModelPreset => {
    const providerKind = provider.value as ProviderKind;
    return {
      id: current.id,
      provider: providerKind,
      label:
        label.value.trim() || (providerKind === "anthropic" ? "Claude" : "GPT"),
      apiKey: apiKey.value.trim(),
      baseUrl: baseUrl.value.trim() || DEFAULT_BASE_URLS[providerKind],
      model: model.value.trim() || DEFAULT_MODELS[providerKind],
      maxTokens: parseInt(maxTokens.value, 10) || 8192,
      extras:
        providerKind === "openai"
          ? {
              reasoningEffort: reasoningEffort.value as ReasoningEffort,
              reasoningSummary: reasoningSummary.value as ReasoningSummary,
              agentPermissionMode: agentPermissionMode(current),
            }
          : {
              agentPermissionMode: agentPermissionMode(current),
            },
    };
  };

  const syncDraft = () => {
    const next = readDraft();
    upsertPreset(state, next);
    state.selectedId = next.id;
    persist(state);
    updateToolbarOption(mount, next);
    updateSendControls(mount, state);
  };

  provider.addEventListener("change", () => {
    const nextProvider = provider.value as ProviderKind;
    label.value =
      label.value || (nextProvider === "anthropic" ? "Claude" : "GPT");
    if (
      !baseUrl.value ||
      Object.values(DEFAULT_BASE_URLS).includes(baseUrl.value)
    ) {
      baseUrl.value = DEFAULT_BASE_URLS[nextProvider];
    }
    if (!model.value || Object.values(DEFAULT_MODELS).includes(model.value)) {
      model.value = DEFAULT_MODELS[nextProvider];
    }
    reasoningEffort.disabled = nextProvider !== "openai";
    reasoningSummary.disabled = nextProvider !== "openai";
    if (nextProvider === "openai" && !reasoningEffort.value) {
      reasoningEffort.value = DEFAULT_REASONING_EFFORT;
    }
    if (nextProvider === "openai" && !reasoningSummary.value) {
      reasoningSummary.value = DEFAULT_REASONING_SUMMARY;
    }
    modelList.replaceChildren();
    for (const suggestion of MODEL_SUGGESTIONS[nextProvider]) {
      const option = doc.createElement("option");
      option.value = suggestion;
      modelList.append(option);
    }
    syncDraft();
  });

  for (const control of [label, apiKey, baseUrl, model, maxTokens]) {
    control.addEventListener("input", syncDraft);
  }
  reasoningEffort.addEventListener("change", syncDraft);
  reasoningSummary.addEventListener("change", syncDraft);

  box.append(
    field(doc, "Provider", provider),
    field(doc, "名称", label),
    field(doc, "API Key", apiKey),
    field(doc, "Base URL", baseUrl),
    field(doc, "Model ID", model),
    field(doc, "Max tokens", maxTokens),
    field(doc, "Reasoning", reasoningEffort),
    field(doc, "Summary", reasoningSummary),
    modelList,
  );

  const buttons = el(doc, "div", "add-buttons");
  const save = buttonEl(doc, "保存预设");
  save.addEventListener("click", () => {
    syncDraft();
    state.editing = false;
    renderPanel(mount, state);
  });
  buttons.append(save);

  for (const kind of ["openai", "anthropic"] as ProviderKind[]) {
    const add = buttonEl(doc, kind === "openai" ? "+ OpenAI" : "+ Anthropic");
    add.addEventListener("click", () => {
      const preset = makePreset(kind);
      state.presets = [...state.presets, preset];
      state.selectedId = preset.id;
      state.editing = true;
      renderPanel(mount, state);
    });
    buttons.append(add);
  }

  if (current) {
    const remove = buttonEl(doc, "删除当前");
    remove.addEventListener("click", () => {
      state.presets = state.presets.filter((p) => p.id !== current.id);
      state.selectedId = state.presets[0]?.id ?? null;
      state.editing = state.presets.length === 0;
      persist(state);
      renderPanel(mount, state);
    });
    buttons.append(remove);
  }
  box.append(buttons);
  return box;
}

function renderContextCard(doc: Document, itemID: number | null) {
  const item = itemID == null ? null : Zotero.Items.get(itemID);
  const title = item?.getField("title") || "未选择条目";
  const card = el(doc, "div", "ctx-card");
  card.append(
    el(doc, "div", "ctx-title", title),
    el(doc, "div", "ctx-meta", `Item ID: ${itemID ?? "none"}`),
  );
  return card;
}

function renderQuickPrompts(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
) {
  const selectedText = getStoredSelectedText(state.itemID);
  const preset = selectedChatPreset(state);
  const fullTextHighlightDisabled = fullTextHighlightDisabledReason(
    doc.defaultView,
    state,
    preset,
  );
  const prompts: Array<{
    label: string;
    prompt: string;
    disabled: boolean;
    disabledTitle?: string;
    explainSelection?: boolean;
    fullTextHighlight?: boolean;
  }> = [
    {
      label: "总结论文",
      prompt:
        "请用中文总结这篇论文，包含：研究背景与问题、核心方法流程、关键公式或算法步骤、主要贡献和创新点、实验结果与主要结论、适用场景、局限性、可能反例与后续改进方向，最后给出一句话概括。",
      disabled: false,
    },
    {
      label: "🔖 全文重点",
      prompt: FULL_TEXT_HIGHLIGHT_PROMPT,
      disabled: !!fullTextHighlightDisabled,
      disabledTitle: fullTextHighlightDisabled,
      fullTextHighlight: true,
    },
    {
      label: "解释选区",
      prompt:
        "请根据当前 PDF 选区，先用中文解释这段话：它在说什么、与上下文的关系、为什么值得关注。不要调用任何 Zotero 工具。\n\n在解释正文之后，另起一段，以 `建议注释：` 开头，下面用 `- ` 列出 1-3 条简短要点（每条 ≤ 80 字），可以直接贴到 PDF 上当注释。如果当前没有可用 PDF 选区，请提示我先选中文本，并省略 `建议注释：` 段。",
      disabled: !selectedText,
      disabledTitle: "请先在 PDF 中选中需要注释的句子",
      explainSelection: true,
    },
  ];
  const box = el(doc, "div", "quick-prompts");
  for (const {
    label,
    prompt,
    disabled,
    disabledTitle,
    explainSelection,
    fullTextHighlight,
  } of prompts) {
    const button = buttonEl(doc, label);
    button.disabled = state.sending || disabled;
    if (disabled && disabledTitle) button.title = disabledTitle;
    button.addEventListener("click", () => {
      void sendMessage(mount, state, prompt, {
        explainSelection,
        fullTextHighlight,
      });
    });
    box.append(button);
  }
  return box;
}

function fullTextHighlightDisabledReason(
  win: Window | null,
  state: PanelState,
  preset: ModelPreset | null,
): string {
  if (!preset) return "请先配置并选择一个 OpenAI 模型";
  if (preset.provider !== "openai") return "全文重点 v1 仅支持 OpenAI 工具循环";
  if (state.agentPermissionMode !== "yolo")
    return "批量写注释需要先开启 YOLO 模式";
  if (!getActiveReaderForItem(win, state.itemID))
    return "请先在 Reader 中打开此 PDF";
  return "";
}

function renderMessages(doc: Document, mount: HTMLElement, state: PanelState) {
  const messages = el(doc, "div", "messages");
  messages.addEventListener("scroll", () => {
    state.messagesScrollTop = messages.scrollTop;
    state.autoFollowMessages = isMessagesElementNearBottom(messages);
  });
  if (state.messages.length === 0) {
    const hint = el(doc, "div", "bubble bubble-assistant bubble-hint");
    hint.append(
      el(doc, "div", "bubble-role", "AI"),
      el(
        doc,
        "div",
        "bubble-body",
        "已就绪。配置模型预设后，可以直接询问当前 Zotero 条目或 PDF 内容。",
      ),
    );
    messages.append(hint);
    return messages;
  }

  state.messages.forEach((message, index) =>
    messages.append(bubble(doc, mount, state, message, index)),
  );
  return messages;
}

function renderInput(doc: Document, mount: HTMLElement, state: PanelState) {
  const composer = el(doc, "div", "composer");
  const row = el(doc, "div", "input-row");
  const input = doc.createElement("textarea");
  input.rows = 3;
  const status = el(doc, "div", "composer-status");

  const preset = selectedChatPreset(state);
  const ready = !!preset?.apiKey && !!preset.model && !state.sending;
  input.placeholder = preset
    ? state.sending
      ? "可以先写下一条，当前回复结束后再发送"
      : "问点什么... (Enter 发送，Shift+Enter 换行)"
    : "先添加一个模型预设。";
  input.disabled = !preset;
  input.value = state.draftText;
  input.style.height = "auto";

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    const shouldSend =
      !state.sending &&
      event.key === "Enter" &&
      !event.isComposing &&
      (!event.shiftKey || event.ctrlKey || event.metaKey);
    if (shouldSend) {
      event.preventDefault();
      void sendMessage(mount, state, expandPasteMarkers(input.value, state));
    }
  });

  const updateStatus = (captureFocus = true) => {
    captureDraftFromInput(input, state, captureFocus);
    autoResizeInput(input);
    renderInputStatus(status, input, state);
  };
  for (const event of ["input", "select", "click", "keyup", "focus"]) {
    input.addEventListener(event, () => updateStatus());
  }
  input.addEventListener("paste", (event: ClipboardEvent) => {
    const imageFiles = pastedImageFiles(event);
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addDraftImages(input.ownerDocument!, state, imageFiles, input).then(
        () => {
          updateStatus(false);
          renderPanel(mount, state);
        },
      );
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!shouldCompactPastedText(text)) return;
    event.preventDefault();
    insertPastedTextMarker(input, state, text);
    updateStatus();
  });
  updateStatus(false);
  afterRender(mount, () => updateStatus(false));

  const inputStack = el(doc, "div", "input-stack");
  inputStack.append(renderDraftImages(doc, mount, state, input), input);
  row.append(inputStack);
  const imageAttach = renderImageAttachButton(
    doc,
    mount,
    state,
    input,
    updateStatus,
  );
  const screenshotAttach = renderScreenshotAttachButton(
    doc,
    mount,
    state,
    input,
    updateStatus,
    status,
  );

  if (state.sending) {
    const stop = buttonEl(doc, "停止");
    stop.className = "stop-btn";
    stop.addEventListener("click", () => {
      state.abort?.abort();
      state.sending = false;
      renderPanel(mount, state);
    });
    row.append(stop, renderSelectionBadge(doc, mount, state));
    composer.append(
      renderQuickPrompts(doc, mount, state),
      row,
      renderComposerFooter(
        doc,
        mount,
        state,
        status,
        screenshotAttach,
        imageAttach,
      ),
    );
    return composer;
  }

  const send = buttonEl(doc, "↑");
  send.className = "send-btn";
  send.disabled = !ready;
  send.title = preset && !ready ? "请先填写 API Key 和 Model ID" : "发送";
  send.setAttribute("aria-label", "发送");
  send.addEventListener(
    "click",
    () =>
      void sendMessage(mount, state, expandPasteMarkers(input.value, state)),
  );
  row.append(send, renderSelectionBadge(doc, mount, state));
  composer.append(
    renderQuickPrompts(doc, mount, state),
    row,
    renderComposerFooter(
      doc,
      mount,
      state,
      status,
      screenshotAttach,
      imageAttach,
    ),
  );
  return composer;
}

function renderImageAttachButton(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  input: HTMLTextAreaElement,
  updateStatus: (captureFocus?: boolean) => void,
): HTMLElement {
  const control = el(doc, "span", "image-attach-control");
  const fileInput = doc.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.className = "image-attach-input";

  const button = buttonEl(doc, "图片");
  button.type = "button";
  button.className = "image-attach-btn";
  button.disabled = !selectedChatPreset(state);
  button.title = "系统截图后可直接 Ctrl+V 粘贴；也可以点击选择图片文件";
  button.addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length === 0) return;
    captureDraftFromInput(input, state);
    void addDraftImages(doc, state, files, input).then(() => {
      fileInput.value = "";
      updateStatus(false);
      renderPanel(mount, state);
    });
  });

  control.append(button, fileInput);
  return control;
}

function renderScreenshotAttachButton(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  input: HTMLTextAreaElement,
  updateStatus: (captureFocus?: boolean) => void,
  status: HTMLElement,
): HTMLElement {
  const button = buttonEl(doc, "截图");
  button.type = "button";
  button.className = "screenshot-attach-btn";
  button.disabled = !selectedChatPreset(state);
  button.title =
    "选择屏幕/窗口截图；如果系统不支持，请用系统截图后 Ctrl+V 粘贴";
  button.addEventListener("click", () => {
    void attachScreenshotImage(doc, mount, state, input, updateStatus, status);
  });
  return button;
}

async function attachScreenshotImage(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  input: HTMLTextAreaElement,
  updateStatus: (captureFocus?: boolean) => void,
  status: HTMLElement,
) {
  captureDraftFromInput(input, state);
  setComposerTransientStatus(status, "请拖拽框选要截图的区域…");
  const file = await captureScreenImage(doc);
  if (!file) {
    input.focus();
    setComposerTransientStatus(
      status,
      "当前环境不能直接截图；请用系统截图复制后 Ctrl+V 粘贴",
    );
    return;
  }
  await addDraftImages(doc, state, [file], input);
  updateStatus(false);
  renderPanel(mount, state);
}

function setComposerTransientStatus(status: HTMLElement, text: string) {
  const node = status.ownerDocument!.createElement("span");
  node.className = "composer-status-badge composer-status-badge-image";
  node.textContent = text;
  status.replaceChildren(node);
}

function renderSelectionBadge(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const selectedText = getStoredSelectedText(state.itemID);
  const badge = doc.createElement("button");
  badge.className = selectedText
    ? "selection-badge"
    : "selection-badge is-empty";
  badge.type = "button";
  if (!selectedText) return badge;

  const lineCount = selectedLineCount(selectedText);
  badge.textContent =
    lineCount > 1
      ? `${lineCount} lines selected`
      : `${selectedText.length} chars selected`;
  badge.title = `本轮会带入 PDF 选区。点击取消。\n\n${selectedText}`;
  badge.addEventListener("click", () => {
    ignoreSelectedTextForPrompt(mount, state.itemID);
    updateSelectionIndicators(mount, state.itemID);
  });
  return badge;
}

function renderDraftImages(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  input: HTMLTextAreaElement,
): HTMLElement {
  const tray = el(
    doc,
    "div",
    state.draftImages.length ? "draft-images" : "draft-images is-empty",
  );
  for (const image of state.draftImages) {
    const item = el(doc, "div", "draft-image");
    const img = doc.createElement("img");
    img.src = image.dataUrl;
    img.alt = image.name;
    const label = el(doc, "span", "draft-image-label", image.marker);
    label.title = image.name;
    const remove = buttonEl(doc, "×");
    remove.title = "移除截图";
    remove.addEventListener("click", () => {
      removeDraftImage(state, input, image);
      renderPanel(mount, state);
    });
    item.append(img, label, remove);
    tray.append(item);
  }
  return tray;
}

function removeDraftImage(
  state: PanelState,
  input: HTMLTextAreaElement,
  image: DraftImage,
) {
  input.value = removeImageMarkerFromText(input.value, image.marker);
  state.draftImages = state.draftImages.filter(
    (candidate) => candidate.id !== image.id,
  );
  relabelDraftImages(state, input);
  captureDraftFromInput(input, state);
}

function renderComposerFooter(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  status: HTMLElement,
  screenshotAttach: HTMLElement,
  imageAttach: HTMLElement,
): HTMLElement {
  const footer = el(doc, "div", "composer-footer");
  const actions = el(doc, "div", "composer-footer-actions");
  actions.append(
    screenshotAttach,
    imageAttach,
    renderYoloToggle(doc, mount, state),
  );
  footer.append(status, actions);
  return footer;
}

function renderYoloToggle(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const label = el(doc, "label", "yolo-toggle");
  const input = doc.createElement("input");
  input.type = "checkbox";
  input.checked = state.agentPermissionMode === "yolo";
  input.addEventListener("change", () => {
    state.agentPermissionMode = input.checked ? "yolo" : "default";
    const preset = selectedPreset(state);
    if (preset) {
      upsertPreset(
        state,
        withAgentPermissionMode(preset, state.agentPermissionMode),
      );
      persist(state);
    }
    renderPanel(mount, state);
  });
  label.append(
    el(doc, "span", "yolo-toggle-text", "YOLO"),
    input,
    el(doc, "span", "yolo-toggle-track"),
  );
  label.title =
    state.agentPermissionMode === "yolo"
      ? "YOLO：本地工具无需审批直接执行"
      : "Default：需要审批的本地工具会被拦截";
  return label;
}

interface InputStatusPart {
  text: string;
  className?: string;
}

function renderInputStatus(
  status: HTMLElement,
  input: HTMLTextAreaElement,
  state: PanelState,
) {
  const parts = composeInputStatus(input, state);
  const doc = input.ownerDocument!;
  status.replaceChildren();
  for (const part of parts) {
    const node = doc.createElement("span");
    if (part.className) node.className = part.className;
    node.textContent = part.text;
    status.append(node);
  }
}

function composeInputStatus(
  input: HTMLTextAreaElement,
  state: PanelState,
): InputStatusPart[] {
  const cursor = cursorPosition(input.value, input.selectionStart ?? 0);
  const selected = Math.abs(
    (input.selectionEnd ?? 0) - (input.selectionStart ?? 0),
  );
  const parts: InputStatusPart[] = [
    { text: `Ln ${cursor.line}, Col ${cursor.column}` },
  ];
  if (selected > 0) {
    parts.push({
      text: `${selected} selected`,
      className: "composer-status-badge",
    });
  }
  if (state.pasteBlocks.length > 0) {
    const lines = state.pasteBlocks.reduce(
      (sum, block) => sum + block.lineCount,
      0,
    );
    parts.push({
      text: `Pasted ${state.pasteBlocks.length} (+${lines} lines)`,
      className: "composer-status-badge",
    });
  }
  if (state.draftImages.length > 0) {
    parts.push({
      text: `Images ${state.draftImages.length}`,
      className: "composer-status-badge composer-status-badge-image",
    });
  }
  return parts;
}

function cursorPosition(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function clampOffset(offset: number, text: string): number {
  return Math.max(0, Math.min(offset, text.length));
}

function autoResizeInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  const maxHeight = 180;
  const next = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Paste compaction
// =====================================================================
// Long pastes are stored OUT-OF-BAND in `state.pasteBlocks` and replaced
// in the textarea with a short marker like `[Pasted #1 +42 lines]`. The
// marker preserves: (a) sidebar UI doesn't fight 1000-line paste with
// scroll; (b) the textarea remains snappy for editing the prompt around
// the paste. `expandPasteMarkers` rejoins the real content at SEND TIME
// so the user can move/delete the marker without re-pasting.
//
// Threshold tuned by feel: 5 lines or 900 chars. Smaller pastes inline.
function shouldCompactPastedText(text: string): boolean {
  return countLines(text) > 5 || text.length > 900;
}

function insertPastedTextMarker(
  input: HTMLTextAreaElement,
  state: PanelState,
  text: string,
) {
  const id = state.nextPasteID++;
  const lineCount = countLines(text);
  const marker = `[Pasted text #${id} +${lineCount} lines]`;
  state.pasteBlocks.push({ id, marker, text, lineCount });

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";
  input.value = `${before}${prefix}${marker}${suffix}${after}`;
  const cursor = before.length + prefix.length + marker.length;
  input.selectionStart = cursor;
  input.selectionEnd = cursor;
}

function expandPasteMarkers(text: string, state: PanelState): string {
  let expanded = text;
  for (const block of state.pasteBlocks) {
    expanded = expanded.replace(
      block.marker,
      `${block.marker}\n\n${block.text}`,
    );
  }
  return expanded;
}

function pastedImageFiles(event: ClipboardEvent): File[] {
  const files: File[] = [];
  const items = event.clipboardData?.items;
  if (!items) return files;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item.type || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function addDraftImages(
  doc: Document,
  state: PanelState,
  files: File[],
  input?: HTMLTextAreaElement,
) {
  for (const file of files) {
    const imageData = await fileToPromptImageData(doc, file);
    const marker = nextImageMarker(state);
    const image: DraftImage = {
      id: `image-${Date.now()}-${state.nextPasteID++}`,
      marker,
      name: file.name || `Screenshot ${state.draftImages.length + 1}`,
      mediaType: imageData.mediaType,
      dataUrl: imageData.dataUrl,
      size: imageData.size,
    };
    state.draftImages.push(image);
    if (input) insertImageMarker(input, marker);
  }
  if (input) captureDraftFromInput(input, state);
}

function nextImageMarker(state: PanelState): string {
  return `[Image #${state.draftImages.length + 1}]`;
}

function insertImageMarker(input: HTMLTextAreaElement, marker: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? "\n" : "";
  const suffix = after && !/^\s/.test(after) ? "\n" : "";
  input.value = `${before}${prefix}${marker}${suffix}${after}`;
  const cursor = before.length + prefix.length + marker.length;
  input.selectionStart = cursor;
  input.selectionEnd = cursor;
}

function removeImageMarkerFromText(text: string, marker: string): string {
  const index = text.indexOf(marker);
  if (index < 0) return text;
  const before = text.slice(0, index);
  const after = text.slice(index + marker.length);
  return `${before}${after}`
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function relabelDraftImages(state: PanelState, input: HTMLTextAreaElement) {
  let text = input.value;
  state.draftImages.forEach((image, index) => {
    const marker = `[Image #${index + 1}]`;
    if (image.marker === marker) return;
    text = text.split(image.marker).join(marker);
    image.marker = marker;
  });
  input.value = text;
}

interface PromptImageData {
  dataUrl: string;
  mediaType: string;
  size: number;
}

async function fileToPromptImageData(
  doc: Document,
  file: File,
): Promise<PromptImageData> {
  const originalDataUrl = await blobToDataUrl(doc, file);
  const mediaType = promptSafeImageType(file.type);
  if (!mediaType)
    return rasterizeImageDataUrl(doc, originalDataUrl, "image/png");

  const image = await decodeImage(doc, originalDataUrl).catch(() => null);
  if (!image) {
    return {
      dataUrl: originalDataUrl,
      mediaType,
      size: file.size,
    };
  }

  if (
    image.naturalWidth <= IMAGE_PROMPT_MAX_DIMENSION &&
    image.naturalHeight <= IMAGE_PROMPT_MAX_DIMENSION
  ) {
    return {
      dataUrl: originalDataUrl,
      mediaType,
      size: file.size,
    };
  }

  return rasterizeImageElement(doc, image, mediaType);
}

function promptSafeImageType(mediaType: string): string | null {
  switch (mediaType) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return mediaType;
    default:
      return null;
  }
}

async function rasterizeImageDataUrl(
  doc: Document,
  dataUrl: string,
  outputType: string,
): Promise<PromptImageData> {
  const image = await decodeImage(doc, dataUrl);
  return rasterizeImageElement(doc, image, outputType);
}

// Downscale + transcode for multimodal API uploads.
// WHY 2048px ceiling (IMAGE_PROMPT_MAX_DIMENSION): both OpenAI Responses
// and Anthropic image inputs cap effective resolution near here; sending
// larger costs more tokens with no quality gain on either provider.
// `Math.min(1, ...)` keeps small images at their native size — never
// upscales (no benefit, just bloats the data URL).
//
// Two graceful-degradation paths return the ORIGINAL image bytes:
//   - canvas getContext fails (rare; XUL window may have GPU init issues)
//   - canvas-to-blob conversion fails
// In both cases we still send the image; only the resize is lost. NOT a
// silent failure — the size mismatch is observable to the caller via the
// returned `size` field which still reflects the data URL byte count.
async function rasterizeImageElement(
  doc: Document,
  image: HTMLImageElement,
  outputType: string,
): Promise<PromptImageData> {
  const scale = Math.min(
    1,
    IMAGE_PROMPT_MAX_DIMENSION / image.naturalWidth,
    IMAGE_PROMPT_MAX_DIMENSION / image.naturalHeight,
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!context) {
    return {
      dataUrl: image.src,
      mediaType: outputType,
      size: dataUrlByteSize(image.src),
    };
  }
  context.drawImage(image, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, outputType);
  if (!blob) {
    return {
      dataUrl: image.src,
      mediaType: outputType,
      size: dataUrlByteSize(image.src),
    };
  }
  return {
    dataUrl: await blobToDataUrl(doc, blob),
    mediaType: blob.type || outputType,
    size: blob.size,
  };
}

function decodeImage(
  doc: Document,
  dataUrl: string,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = doc.createElement("img");
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Failed to decode image")),
      { once: true },
    );
    image.src = dataUrl;
  });
}

// FileReader#readAsDataURL wrapped in a promise.
// WHY pull FileReader off `doc.defaultView`: tests run with a synthesized
// document; Zotero's XUL window has its own FileReader constructor
// distinct from the global one. `File` extends `Blob`, so this single
// helper serves both image-paste and canvas-blob paths.
function blobToDataUrl(doc: Document, blob: Blob): Promise<string> {
  const Reader = doc.defaultView?.FileReader ?? FileReader;
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read image blob")),
    );
    reader.readAsDataURL(blob);
  });
}

function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(payload.length * 0.75);
}

async function captureScreenImage(doc: Document): Promise<File | null> {
  return (
    (await captureScreenImageWithExternalTool(doc)) ??
    (await captureScreenImageWithDisplayMedia(doc))
  );
}

// Two-tier screenshot capture.
// Tier 1 — `getDisplayMedia` (this function): the standard browser screen
// capture API. The user gets the OS screen-picker dialog; we draw a
// single frame onto a canvas and convert to PNG. Works in modern Zotero
// XUL builds and is the preferred path.
// Tier 2 — `captureScreenImageWithExternalTool` (fallback): on Linux,
// some Zotero builds don't expose getDisplayMedia in the XUL window. We
// shell out to `gnome-screenshot` / `flameshot` / ImageMagick `import`
// and read the file back. Each tool exits non-zero if cancelled.
// INVARIANT: caller (`captureScreenImage`) tries Tier 1 first; Tier 2
// only runs if Tier 1 returns null. NEVER both — would prompt the user
// twice.
async function captureScreenImageWithDisplayMedia(
  doc: Document,
): Promise<File | null> {
  const win = doc.defaultView;
  const mediaDevices = win?.navigator?.mediaDevices;
  if (!win || typeof mediaDevices?.getDisplayMedia !== "function") return null;

  let stream: MediaStream | null = null;
  try {
    stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = doc.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await waitForVideoMetadata(video);
    await video.play().catch(() => undefined);

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, "image/png");
    if (!blob) return null;
    const FileCtor = win.File ?? File;
    return new FileCtor([blob], `Screenshot ${timestampForFileName()}.png`, {
      type: "image/png",
    });
  } catch (err) {
    Zotero.debug(
      `[Zotero AI Sidebar] screenshot capture failed: ${String(err)}`,
    );
    return null;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

async function captureScreenImageWithExternalTool(
  doc: Document,
): Promise<File | null> {
  const Z = Zotero as any;
  const exec = Z?.Utilities?.Internal?.exec;
  const getBinary = Z?.File?.getBinaryContentsAsync;
  const removeIfExists = Z?.File?.removeIfExists;
  if (typeof exec !== "function" || typeof getBinary !== "function")
    return null;

  // Tools tried in order of "least disruptive UX first":
  //   gnome-screenshot -a   — area-select, native GNOME UI
  //   flameshot gui -p      — area-select, modern annotation overlay
  //   ImageMagick `import`  — fullscreen capture, last resort
  // `-p path` / `-f path` write to a fixed temp file we read back. We
  // remove the temp file on success AND failure (best-effort cleanup).
  const path = `/tmp/zotero-ai-sidebar-screenshot-${Date.now()}.png`;
  const commands: Array<[string, string[]]> = [
    ["/usr/bin/gnome-screenshot", ["-a", "-f", path]],
    ["/usr/bin/flameshot", ["gui", "-p", path]],
    ["/usr/bin/import", [path]],
  ];

  for (const [cmd, args] of commands) {
    try {
      const result = await exec(cmd, args);
      if (result !== true) continue;
      const file = await imageFileFromPath(doc, path, "Screenshot");
      if (file) {
        try {
          await removeIfExists?.(path);
        } catch (_err) {
          // Best-effort cleanup only.
        }
        return file;
      }
    } catch (err) {
      Zotero.debug(
        `[Zotero AI Sidebar] screenshot command failed (${cmd}): ${String(err)}`,
      );
    }
  }
  try {
    await removeIfExists?.(path);
  } catch (_err) {
    // Best-effort cleanup only.
  }
  return null;
}

async function imageFileFromPath(
  doc: Document,
  path: string,
  fallbackName: string,
): Promise<File | null> {
  try {
    const binary: string = await (Zotero as any).File.getBinaryContentsAsync(
      path,
    );
    if (!binary) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }
    const name = path.split("/").pop() || `${fallbackName}.png`;
    const FileCtor = doc.defaultView?.File ?? File;
    return new FileCtor([bytes], name, { type: "image/png" });
  } catch (err) {
    Zotero.debug(
      `[Zotero AI Sidebar] screenshot file read failed: ${String(err)}`,
    );
    return null;
  }
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  const win = video.ownerDocument?.defaultView;
  return new Promise((resolve, reject) => {
    if (!win) {
      reject(new Error("Missing window for screen capture"));
      return;
    }
    const timeoutID = win.setTimeout(
      () => reject(new Error("Timed out waiting for screen capture")),
      5000,
    );
    video.addEventListener(
      "loadedmetadata",
      () => {
        win.clearTimeout(timeoutID);
        resolve();
      },
      { once: true },
    );
    video.addEventListener(
      "error",
      () => {
        win.clearTimeout(timeoutID);
        reject(new Error("Failed to load screen capture"));
      },
      { once: true },
    );
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function selectedLineCount(text: string): number {
  if (!text) return 0;
  const byBreak = countLines(text);
  if (byBreak > 1) return byBreak;
  return Math.max(1, Math.ceil(text.length / 90));
}

interface SendMessageOptions {
  explainSelection?: boolean;
  fullTextHighlight?: boolean;
}

// User-message → wire-message pipeline.
// Responsibilities (in order, each one matters):
//   1. Trim & filter draft images (only images whose marker survives in
//      the final text are sent — the user can delete a marker mid-edit).
//   2. Skip if not configured: open the preset editor instead of erroring.
//   3. Capture the SELECTED PDF TEXT exactly once at send time. WHY: the
//      user may type their question after selecting; locking selection
//      here makes the wire content match what the chip showed.
//   4. Snapshot the annotation draft for explainSelection flows BEFORE we
//      append user message — `attachAnnotationDraft` will use the snapshot
//      regardless of how selection state evolves during streaming.
//   5. Reset draft state (text/images/scroll-anchor) to fresh defaults.
//   6. Persist BEFORE streaming so the user message is durable even if the
//      provider request errors out.
async function sendMessage(
  mount: HTMLElement,
  state: PanelState,
  text: string,
  options: SendMessageOptions = {},
) {
  const content = text.trim();
  const preset = selectedChatPreset(state);
  const images = state.draftImages
    .filter((image) => text.includes(image.marker))
    .map((image) => ({ ...image }));
  if ((!content && images.length === 0) || !preset || state.sending) return;
  await ensureHistoryLoaded(mount, state);
  if (states.get(mount) !== state) return;
  if (!preset.apiKey || !preset.model) {
    state.editing = true;
    renderPanel(mount, state);
    return;
  }

  const history = state.messages.slice();
  const selectedText = options.fullTextHighlight
    ? ""
    : getSelectedTextForPrompt(mount, state.itemID);
  const userMessage: Message = {
    role: "user",
    content,
    ...(images.length ? { images } : {}),
    ...(selectedText ? { context: { selectedText } } : {}),
  };
  const snapshot = options.explainSelection
    ? cloneSelectionAnnotationDraft(getStoredSelectionAnnotation(state.itemID))
    : null;
  state.messages.push(userMessage);
  state.draftText = "";
  state.draftSelectionStart = 0;
  state.draftSelectionEnd = 0;
  state.draftHadFocus = true;
  state.skipNextDraftCapture = true;
  state.pasteBlocks = [];
  state.draftImages = [];
  state.autoFollowMessages = true;
  state.scrollToBottom = true;
  void saveChatMessages(state.itemID, state.messages);
  await streamAssistant(mount, state, history, userMessage, {
    annotationSnapshot: snapshot,
    fullTextHighlight: options.fullTextHighlight,
  });
}

function cloneSelectionAnnotationDraft(
  draft: SelectionAnnotationDraft | null,
): SelectionAnnotationDraft | null {
  if (!draft) return null;
  return {
    text: draft.text,
    attachmentID: draft.attachmentID,
    annotation: { ...draft.annotation },
  };
}

interface StreamAssistantOptions {
  annotationSnapshot?: SelectionAnnotationDraft | null;
  fullTextHighlight?: boolean;
}

// streamAssistant: the project's OUTER loop wrapping the provider's inner
// tool loop. Codex parallel: this is where the Zotero plugin sits in the
// place of Codex's `runner` — owning tool sessions, chunk dispatch, UI
// state transitions, and persistence.
//
// Stage state machine on `activeAssistantStage`:
//   building_context → waiting_model → using_tool ⇄ waiting_model →
//   thinking ⇄ writing → (cleared on finish/error)
// Each transition triggers a re-render so the user sees what's happening.
//
// INVARIANT: `void saveChatMessages(...)` fires on every tool_call chunk.
// WHY persist mid-stream: if Zotero crashes during a long tool loop, the
// thread still has the user message + tool traces accumulated so far.
// (CLAUDE.md "Show Zotero tool-call traces visibly in the conversation".)
//
// INVARIANT: `toolSession.dispose()` MUST run in the finally block —
// the locator session holds a memoized PdfLocator that pins page bundles
// in memory. Skipping dispose leaks across turns.
async function streamAssistant(
  mount: HTMLElement,
  state: PanelState,
  history: Message[],
  userMessage: Message,
  options: StreamAssistantOptions = {},
) {
  const preset = selectedChatPreset(state);
  if (!preset || state.sending) return;

  state.sending = true;
  state.autoFollowMessages = true;
  state.scrollToBottom = true;
  state.focusInput = true;
  renderPanel(mount, state);
  const assistantIndex = state.messages.length;
  const assistant: Message = { role: "assistant", content: "" };
  state.messages.push(assistant);
  state.activeAssistantIndex = assistantIndex;
  state.activeAssistantStage = "building_context";
  state.scrollToBottom = true;
  state.focusInput = true;
  renderPanel(mount, state);

  const controllerCtor = mount.ownerDocument!.defaultView!.AbortController;
  const controller = new controllerCtor();
  state.abort = controller;
  let toolSession: ZoteroAgentToolSession | null = null;

  try {
    const contextLedger = formatContextLedger(history);
    if (userMessage.context?.selectedText) {
      userMessage.context = {
        ...userMessage.context,
        planMode: "selected_text",
        plannerSource: "selected",
        planReason: "用户当前选中了 PDF 文本，直接作为显式上下文发送",
      };
    }
    const retainedStats = retainedContextStats(
      [...history, userMessage],
      userMessage,
      contextPolicy,
    );
    if (retainedStats.count > 0) {
      userMessage.context = {
        ...userMessage.context,
        retainedContextCount: retainedStats.count,
        retainedContextChars: retainedStats.chars,
      };
    }
    const baseContext = await buildSystemContextOnly(
      state.itemID,
      contextLedger,
    );
    // Build a fresh tool session per turn. WHY per-turn (not cached):
    // - Reader's PDF.js text layer can change between turns (user opens a
    //   different attachment); a stale locator would point at the wrong PDF.
    // - `selectionAnnotation` is a getter, so the tool sees the snapshot
    //   that's CURRENT when the model invokes the write tool, not at
    //   session-creation time.
    toolSession = createZoteroAgentToolSession({
      source: zoteroContextSource,
      itemID: state.itemID,
      policy: contextPolicy,
      selectionAnnotation: () => getStoredSelectionAnnotation(state.itemID),
      fullTextHighlight: options.fullTextHighlight,
      getActiveReader: () =>
        getActiveReaderForItem(mount.ownerDocument!.defaultView, state.itemID),
    });
    state.scrollToBottom = state.autoFollowMessages;
    state.activeAssistantStage = "waiting_model";
    renderPanel(mount, state);

    const messagesForApi: Message[] = toApiMessages(
      [...history, userMessage],
      {
        message: userMessage,
      },
      contextPolicy,
    );

    for await (const chunk of getProvider(preset).stream(
      messagesForApi,
      baseContext.systemPrompt,
      preset,
      controller.signal,
      {
        tools: toolSession.tools,
        maxToolIterations: contextPolicy.maxToolIterations,
        permissionMode: state.agentPermissionMode,
      },
    )) {
      if (chunk.type === "text_delta") {
        state.activeAssistantStage = "writing";
        assistant.content += chunk.text;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === "thinking_delta") {
        state.activeAssistantStage = "thinking";
        assistant.thinking = `${assistant.thinking ?? ""}${chunk.text}`;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === "tool_call") {
        state.activeAssistantStage =
          chunk.status === "started" ? "using_tool" : "waiting_model";
        recordToolCall(userMessage, chunk);
        void saveChatMessages(state.itemID, state.messages);
        state.scrollToBottom = state.autoFollowMessages;
        renderPanel(mount, state);
      } else if (chunk.type === "error") {
        assistant.content += `\n[Error] ${chunk.message}`;
        updateMessageBubble(mount, assistantIndex, assistant);
        break;
      }
    }
  } catch (err) {
    assistant.content += `\n[Error] ${err instanceof Error ? err.message : String(err)}`;
    updateMessageBubble(mount, assistantIndex, assistant);
  } finally {
    toolSession?.dispose();
    if (options.annotationSnapshot) {
      attachAnnotationDraft(assistant, options.annotationSnapshot);
    }
    state.sending = false;
    state.abort = undefined;
    state.activeAssistantIndex = undefined;
    state.activeAssistantStage = undefined;
    void saveChatMessages(state.itemID, state.messages);
    state.scrollToBottom = state.autoFollowMessages;
    state.focusInput = true;
    renderPanel(mount, state);
  }
}

// Splits the assistant's text into (body, annotationDraft) using the
// `建议注释` parser. The marker block is REMOVED from `assistant.content`
// (assigned to `parsed.body`) so the chat bubble doesn't show the
// suggestion text twice — once in the prose, once in the suggestion
// card. The `snapshot` carries the PDF anchor that was live when the
// turn started; we deep-copy `annotation` so the saved draft is
// invariant under later selection changes.
function attachAnnotationDraft(
  assistant: Message,
  snapshot: SelectionAnnotationDraft,
) {
  const parsed = parseAnnotationSuggestion(assistant.content);
  if (!parsed.comment) return;
  assistant.content = parsed.body;
  assistant.annotationDraft = {
    comment: parsed.comment,
    snapshot: {
      text: snapshot.text,
      attachmentID: snapshot.attachmentID,
      annotation: { ...snapshot.annotation },
    },
    state: { kind: "idle" },
  };
}

async function buildSystemContextOnly(
  itemID: number | null,
  contextLedger: string,
): Promise<{ systemPrompt: string }> {
  const ctx = await buildContext(zoteroContextSource, itemID, 0);
  return {
    systemPrompt: contextAwareSystemPrompt(ctx.systemPrompt, contextLedger),
  };
}

// Builds the system prompt sent to the model each turn.
// Three sections, in order:
//   1. Item-metadata block (from buildContext): title/authors/year/abstract.
//   2. "Agent policy" block: tells the model what tools exist and that the
//      harness — not the model — enforces budgets. Plain English so we
//      don't hide tool semantics in JSON schema alone.
//   3. Ledger: machine-readable record of past turns' context (chars
//      sent, tool calls, plan modes). Marked "not currently attached"
//      so the model treats it as memory, not source material.
// REF: docs/HARNESS_ENGINEERING.md "Prompt Assembly".
function contextAwareSystemPrompt(
  systemPrompt: string,
  contextLedger: string,
): string {
  return `${systemPrompt}\n\nAgent policy: You can call local Zotero tools to read the current item metadata, PDF annotations, targeted PDF passages, exact PDF ranges, or the full PDF. You can also call permission-aware Zotero write tools when the user explicitly asks to save a note or annotation. Decide which tool is needed; the local harness only executes tools and enforces budgets. Use only currently attached context or tool output for paper-specific claims. The ledger below records previous Zotero context that may no longer be visible; do not treat it as available source text.\n\nPreviously sent context ledger (not currently attached):\n${contextLedger}`;
}

// Tool-trace upsert. Each chunk that comes from the provider stream is
// either status="started" (push a new trace) or "completed"/"error"
// (replace the most recent `started` trace with the same name).
//
// INVARIANT: this works because OpenAI is configured with
// `parallel_tool_calls: false` — at most ONE in-flight tool per name at a
// time. If we ever enable parallel calls, this needs a call_id key.
//
// `chunk.context` is also merged into the user message's context so the
// MessageContext for that turn accumulates plan-mode/range/passages from
// every tool the model invoked. The user-message context is the "fact
// sheet" shown in the assistant-process collapsible.
function recordToolCall(
  message: Message,
  chunk: {
    name: string;
    status: "started" | "completed" | "error";
    summary?: string;
    context?: Message["context"];
  },
) {
  const previousTools = message.context?.toolCalls ?? [];
  const nextTools = previousTools.slice();
  const trace = {
    name: chunk.name,
    status: chunk.status,
    summary: chunk.summary,
  };

  let replaced = false;
  if (chunk.status !== "started") {
    for (let index = nextTools.length - 1; index >= 0; index--) {
      const tool = nextTools[index];
      if (tool.name === chunk.name && tool.status === "started") {
        nextTools[index] = trace;
        replaced = true;
        break;
      }
    }
  }
  if (!replaced) nextTools.push(trace);

  message.context = {
    ...message.context,
    ...chunk.context,
    toolCalls: nextTools,
  };
}

// Retry the last assistant turn. INVARIANT: we REUSE the existing user
// message (with its captured selection/context) — re-deriving selection
// from the live Reader at retry time would silently change what the
// model sees vs the original turn. The user expects "retry" to give a
// new answer to the SAME question, not re-trigger context capture.
//
// Carries the previous assistant's `annotationDraft.snapshot` forward as
// `annotationSnapshot`. WHY: if the original turn was an explainSelection
// flow, the regenerated answer should still be anchored to the same PDF
// passage so the new "建议注释" suggestion can be saved at the same spot.
async function regenerateLastResponse(mount: HTMLElement, state: PanelState) {
  if (state.sending) return;
  await ensureHistoryLoaded(mount, state);
  if (states.get(mount) !== state) return;

  const assistantIndex = findLastAssistantIndex(state.messages);
  if (assistantIndex < 0) return;
  const userIndex = findPreviousUserIndex(state.messages, assistantIndex);
  if (userIndex < 0) return;

  const userMessage = state.messages[userIndex];
  const previousAssistant = state.messages[assistantIndex];
  const carriedSnapshot = previousAssistant.annotationDraft?.snapshot ?? null;
  const history = state.messages.slice(0, userIndex);
  state.messages = [...history, userMessage];
  void saveChatMessages(state.itemID, state.messages);
  await streamAssistant(mount, state, history, userMessage, {
    annotationSnapshot: carriedSnapshot
      ? {
          text: carriedSnapshot.text,
          attachmentID: carriedSnapshot.attachmentID,
          annotation: { ...carriedSnapshot.annotation },
        }
      : null,
  });
}

async function loadPersistedMessages(mount: HTMLElement, state: PanelState) {
  if (state.historyLoaded) return;
  const messages = await loadChatMessages(state.itemID);
  if (states.get(mount) !== state || state.sending) return;
  state.messages = messages;
  state.historyLoaded = true;
  state.scrollToBottom = true;
  renderPanel(mount, state);
}

async function ensureHistoryLoaded(mount: HTMLElement, state: PanelState) {
  if (state.historyLoaded) return;
  await loadPersistedMessages(mount, state);
}

// Selection state machine
// =====================================================================
// Three concurrent maps track PDF text selection per Zotero item ID:
//   selectedTextByItem        — current selection text from the Reader.
//   selectedAnnotationByItem  — Zotero annotation snapshot (for the write
//                                tool zotero_add_annotation_to_selection).
//   ignoredSelectedTextByItem — text the user dismissed via the chip's
//                                "x" button. Stored so the polling monitor
//                                doesn't immediately re-arm the same text.
//
// Sources of selection updates:
//   1. Zotero `renderTextSelectionPopup` event → `rememberReaderSelection`
//      (event-driven, fires when the user finishes a drag-select).
//   2. SELECTION_MONITOR_MS poll → `refreshActiveReaderSelection`
//      (catches keyboard-driven selection and selection-clear).
// Hybrid because Reader doesn't fire a clear event when a selection ends.
//
// INVARIANT: an item is keyed by parent-item-id where possible (see
// `readerItemIDs`); the same selection appears under both parent and
// attachment IDs so the chip survives switching between them.

function getSelectedTextForPrompt(
  mount: HTMLElement,
  itemID: number | null,
): string {
  const win = mount.ownerDocument?.defaultView;
  return (
    refreshActiveReaderSelection(win, itemID, false) ||
    getStoredSelectedText(itemID)
  );
}

function getStoredSelectedText(itemID: number | null): string {
  if (itemID == null) return "";
  const text = selectedTextByItem.get(itemID) ?? "";
  return text && ignoredSelectedTextByItem.get(itemID) !== text ? text : "";
}

function getStoredSelectionAnnotation(
  itemID: number | null,
): SelectionAnnotationDraft | null {
  if (itemID == null) return null;
  const draft = selectedAnnotationByItem.get(itemID) ?? null;
  return draft && ignoredSelectedTextByItem.get(itemID) !== draft.text
    ? draft
    : null;
}

// `clearWhenEmpty` distinguishes the two callers:
// - Polling monitor (focusInSidebar=false ⇒ true): if the Reader has no
//   live selection AND the user is interacting with the sidebar, clear
//   stored selection so the chip disappears once the user starts typing.
// - Send-time read (false): keep the stored selection so a click on the
//   composer doesn't drop the selection chip the user just made.
function refreshActiveReaderSelection(
  win: Window | null | undefined,
  itemID: number | null,
  clearWhenEmpty: boolean,
): string {
  const reader = getActiveReader(win);
  const text = getActiveReaderSelection(reader);
  const ids = readerItemIDs(reader, itemID);
  if (text) {
    rememberReaderSelection(reader, itemID, text);
    return shouldIgnoreSelectedText(ids, text) ? "" : text;
  }
  if (clearWhenEmpty) {
    clearStoredSelectedText(ids);
    return "";
  }
  return firstUsableStoredSelectedText(ids);
}

function getActiveReaderSelection(reader: unknown): string {
  const r = reader as any;
  return firstText([
    safeSelectionText(r?._internalReader?._primaryView?._iframeWindow),
    safeSelectionText(r?._internalReader?._secondaryView?._iframeWindow),
    safeSelectionText(r?._iframeWindow),
  ]);
}

// Hooks Zotero's Reader event so we capture the annotation snapshot at
// the same time the selection popup renders. WHY at popup-render time:
// that's when Zotero has a fully-formed annotation candidate (with
// position/sortIndex) — we keep a copy so the write tool can save it
// later without re-deriving coordinates.
// REF: Zotero source `chrome/content/zotero/reader.js`
//      registerEventListener("renderTextSelectionPopup", ...).
function registerReaderSelectionCapture() {
  const readerAPI = (Zotero as any).Reader;
  if (readerSelectionHandler || !readerAPI?.registerEventListener) return;

  readerSelectionHandler = (event: unknown) => {
    const e = event as {
      reader?: unknown;
      params?: { annotation?: { text?: string } & Record<string, unknown> };
    };
    const text = normalizeSelectedText(e.params?.annotation?.text);
    if (!text) return;
    rememberReaderSelection(e.reader, null, text, e.params?.annotation);
    for (const win of mountedWindows) {
      const sidebar = windowSidebars.get(win);
      if (sidebar)
        updateSelectionIndicators(sidebar.mount, getSelectedItemID(win));
    }
  };
  readerAPI.registerEventListener(
    "renderTextSelectionPopup",
    readerSelectionHandler,
    addon.data.config.addonID,
  );
}

function unregisterReaderSelectionCapture() {
  const readerAPI = (Zotero as any).Reader;
  if (!readerSelectionHandler || !readerAPI?.unregisterEventListener) return;
  readerAPI.unregisterEventListener(
    "renderTextSelectionPopup",
    readerSelectionHandler,
  );
  readerSelectionHandler = null;
}

function startSelectionMonitor(win: Window, sidebar: WindowSidebarState) {
  if (sidebar.selectionMonitorID != null) return;
  sidebar.selectionMonitorID = win.setInterval(() => {
    const itemID = getSelectedItemID(win);
    const before = getStoredSelectedText(itemID);
    const focusInSidebar = isFocusInside(sidebar.mount);
    const after = refreshActiveReaderSelection(win, itemID, !focusInSidebar);
    if (before !== after) {
      updateSelectionIndicators(sidebar.mount, itemID);
    }
  }, SELECTION_MONITOR_MS);
}

function stopSelectionMonitor(win: Window, sidebar: WindowSidebarState) {
  if (sidebar.selectionMonitorID == null) return;
  win.clearInterval(sidebar.selectionMonitorID);
  sidebar.selectionMonitorID = undefined;
}

function updateSelectionIndicators(mount: HTMLElement, _itemID: number | null) {
  const state = states.get(mount);
  const prompts = mount.querySelector(".quick-prompts") as HTMLElement | null;
  if (state && prompts) {
    prompts.replaceWith(renderQuickPrompts(mount.ownerDocument!, mount, state));
  }
  const badge = mount.querySelector(".selection-badge") as HTMLElement | null;
  if (state && badge) {
    badge.replaceWith(renderSelectionBadge(mount.ownerDocument!, mount, state));
  }
  const input = mount.querySelector(
    ".input-row textarea",
  ) as HTMLTextAreaElement | null;
  const status = mount.querySelector(".composer-status") as HTMLElement | null;
  if (state && input && status) {
    renderInputStatus(status, input, state);
  }
}

function isFocusInside(root: HTMLElement): boolean {
  const active = root.ownerDocument?.activeElement;
  return !!active && root.contains(active);
}

function rememberReaderSelection(
  reader: unknown,
  fallbackItemID: number | null,
  text: string,
  annotation?: Record<string, unknown>,
) {
  const normalized = normalizeSelectedText(text);
  if (!normalized) return;
  const ids = readerItemIDs(reader, fallbackItemID);
  const attachmentID = readerAttachmentID(reader);
  for (const id of ids) {
    if (ignoredSelectedTextByItem.get(id) === normalized) {
      continue;
    }
    ignoredSelectedTextByItem.delete(id);
    selectedTextByItem.set(id, normalized);
    if (annotation && attachmentID != null) {
      selectedAnnotationByItem.set(id, {
        text: normalized,
        annotation: { ...annotation },
        attachmentID,
      });
    }
  }
}

// Two near-twin lookups — DELIBERATE, do not merge:
// - `firstStoredSelectedText` returns whatever is in storage IGNORING the
//   ignored-by-user flag. Used by `ignoreSelectedTextForPrompt` which
//   needs to look up the text it's about to mark as ignored.
// - `firstUsableStoredSelectedText` filters out ignored entries. Used by
//   the polling monitor and any "should we show the chip?" path.
function firstStoredSelectedText(ids: number[]): string {
  for (const id of ids) {
    const text = selectedTextByItem.get(id);
    if (text) return text;
  }
  return "";
}

function firstUsableStoredSelectedText(ids: number[]): string {
  for (const id of ids) {
    const text = selectedTextByItem.get(id);
    if (text && ignoredSelectedTextByItem.get(id) !== text) return text;
  }
  return "";
}

function shouldIgnoreSelectedText(ids: number[], text: string): boolean {
  return ids.some((id) => ignoredSelectedTextByItem.get(id) === text);
}

function clearStoredSelectedText(ids: number[]) {
  for (const id of ids) {
    selectedTextByItem.delete(id);
    selectedAnnotationByItem.delete(id);
    ignoredSelectedTextByItem.delete(id);
  }
}

// User clicked the "x" on the selection chip. INVARIANT: we both DELETE
// the active selection AND record it in `ignoredSelectedTextByItem`, so
// the next polling tick doesn't re-arm the same text. The ignore record
// is cleared in `rememberReaderSelection` only when a *different* text is
// selected — a fresh selection re-enables the chip.
function ignoreSelectedTextForPrompt(
  mount: HTMLElement,
  itemID: number | null,
) {
  const reader = getActiveReader(mount.ownerDocument?.defaultView);
  const ids = readerItemIDs(reader, itemID);
  const text = firstStoredSelectedText(ids);
  for (const id of ids) {
    if (text) ignoredSelectedTextByItem.set(id, text);
    selectedTextByItem.delete(id);
    selectedAnnotationByItem.delete(id);
  }
}

// Returns BOTH the parent item ID and the attachment ID for a Reader-open
// PDF, deduped. WHY both: the user may switch between viewing the parent
// in the items pane and the attachment via Reader; storing the selection
// under both IDs keeps the chip visible across that switch.
function readerItemIDs(
  reader: unknown,
  fallbackItemID: number | null,
): number[] {
  const r = reader as {
    itemID?: number;
    _item?: { id?: number; parentID?: number };
  } | null;
  const ids = [
    fallbackItemID,
    r?._item?.id,
    r?._item?.parentID,
    r?.itemID,
  ].filter((id): id is number => typeof id === "number");
  return [...new Set(ids)];
}

function readerAttachmentID(reader: unknown): number | null {
  const r = reader as {
    itemID?: number;
    _item?: { id?: number };
  } | null;
  return typeof r?._item?.id === "number"
    ? r._item.id
    : typeof r?.itemID === "number"
      ? r.itemID
      : null;
}

// Active Reader = the reader instance for the foreground Zotero tab.
// REF: Zotero source `chrome/content/zotero/elements/zoteroTabs.js` for
//      Zotero_Tabs.selectedID; `chrome/content/zotero/reader.js` for
//      Reader.getByTabID. The chain optionals defend against the user
//      having no Reader tab open.
function getActiveReader(win: Window | null | undefined): any {
  const tabID = (win as any)?.Zotero_Tabs?.selectedID;
  return tabID ? (Zotero as any).Reader?.getByTabID?.(tabID) : null;
}

// Returns the active Reader ONLY IF it's open on the same paper as the
// current chat thread. WHY this guard: agent tools that need PDF.js text
// (the highlight-write tool) must operate on the SAME paper the user is
// chatting about — otherwise we'd write a highlight to the wrong PDF.
// `activeReaderConversationItemID` walks attachment→parent so the match
// works whether the Reader is on the parent or the attachment.
function getActiveReaderForItem(
  win: Window | null | undefined,
  itemID: number | null,
): any {
  if (!win || itemID == null) return null;
  const reader = getActiveReader(win);
  if (!reader) return null;
  return activeReaderConversationItemID(win) === itemID ? reader : null;
}

function safeSelectionText(win: unknown): string {
  try {
    return normalizeSelectedText(
      (win as Window | undefined)?.getSelection?.()?.toString(),
    );
  } catch {
    return "";
  }
}

function firstText(values: string[]): string {
  return values.find(Boolean) ?? "";
}

function normalizeSelectedText(text: unknown): string {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > contextPolicy.maxSelectedTextChars
    ? normalized.slice(0, contextPolicy.maxSelectedTextChars)
    : normalized;
}

function updateMessageBubble(
  mount: HTMLElement,
  index: number,
  message: Message,
) {
  const root = mount.querySelector(
    `[data-message-index="${index}"]`,
  ) as HTMLElement | null;
  const body = root?.querySelector(".bubble-body") as HTMLElement | null;
  if (!root || !body) return;
  const state = states.get(mount);
  const shouldStickToBottom =
    state?.autoFollowMessages ?? isMessagesNearBottom(mount);
  if (state) {
    updateAssistantProgress(
      root,
      body,
      assistantProgressFor(state, index, message),
    );
  }

  if (message.thinking) {
    renderMarkdownInto(ensureThinkingBody(root, body), message.thinking);
  }
  renderMarkdownInto(
    body,
    message.content || (state?.activeAssistantIndex === index ? " " : ""),
  );
  if (shouldStickToBottom) {
    scrollMessagesToBottom(mount);
  } else {
    restoreSavedMessagesScroll(mount);
  }
  syncMessagesScrollState(mount);
}

function updateAssistantProgress(
  root: HTMLElement,
  before: HTMLElement,
  progress: AssistantProgress | null,
) {
  const existing = root.querySelector(
    ".assistant-live-progress",
  ) as HTMLElement | null;
  if (!progress) {
    existing?.remove();
    return;
  }
  const next = renderAssistantProgress(root.ownerDocument!, progress);
  if (existing) existing.replaceWith(next);
  else root.insertBefore(next, before);
}

function ensureThinkingBody(
  root: HTMLElement,
  before: HTMLElement,
): HTMLElement {
  const existing = root.querySelector(
    ".bubble-thinking-body",
  ) as HTMLElement | null;
  if (existing) return existing;

  const doc = root.ownerDocument!;
  const details = doc.createElement("details");
  details.className = "bubble-thinking";
  details.open = true;
  const summary = doc.createElement("summary");
  summary.textContent = "思考过程";
  const body = doc.createElement("div");
  body.className = "bubble-thinking-body";
  details.append(summary, body);
  root.insertBefore(details, before);
  return body;
}

function afterRender(mount: HTMLElement, callback: () => void) {
  const win = mount.ownerDocument?.defaultView;
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(() => callback());
  } else if (win?.setTimeout) {
    win.setTimeout(callback, 0);
  } else {
    callback();
  }
}

// Scroll preservation
// =====================================================================
// CLAUDE.md rule: streaming output should auto-scroll only when the user
// is already near the bottom; if they've scrolled up, preserve their
// position while new chunks arrive.
//
// State lives in `state.messagesScrollTop` so it survives re-renders
// (every chunk triggers `renderPanel`). `state.autoFollowMessages` toggles
// based on near-bottom detection — once the user scrolls up, we don't
// re-engage auto-follow until they scroll back to the bottom themselves.

function scrollMessagesToBottom(mount: HTMLElement) {
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) return;
  messages.scrollTop = messages.scrollHeight;
  syncMessagesScrollState(mount);
}

function syncMessagesScrollState(mount: HTMLElement) {
  const state = states.get(mount);
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (state && messages) {
    state.messagesScrollTop = messages.scrollTop;
  }
}

function isMessagesNearBottom(mount: HTMLElement): boolean {
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) return true;
  return isMessagesElementNearBottom(messages);
}

// 40px = roughly one body line of slack. Below this we treat the user as
// "at the bottom" and re-engage auto-follow. Tuned by hand: large enough
// to absorb sub-pixel scroll snap, small enough that scrolling up by one
// full message disengages follow mode.
function isMessagesElementNearBottom(messages: HTMLElement): boolean {
  return (
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40
  );
}

function restoreSavedMessagesScroll(mount: HTMLElement) {
  const state = states.get(mount);
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!state || !messages) return;
  messages.scrollTop = state.messagesScrollTop;
}

function restoreMessagesScroll(
  mount: HTMLElement,
  state: PanelState,
  scrollToBottom: boolean,
) {
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) return;
  if (scrollToBottom) {
    messages.scrollTop = messages.scrollHeight;
    state.messagesScrollTop = messages.scrollTop;
    return;
  }
  messages.scrollTop = state.messagesScrollTop;
}

function restoreChatInput(
  mount: HTMLElement,
  state: PanelState,
  forceFocus: boolean,
) {
  const input = mount.querySelector(
    ".input-row textarea",
  ) as HTMLTextAreaElement | null;
  if (!input || input.disabled) return;
  input.value = state.draftText;
  const start = clampOffset(state.draftSelectionStart, input.value);
  const end = clampOffset(state.draftSelectionEnd, input.value);
  input.selectionStart = start;
  input.selectionEnd = end;
  autoResizeInput(input);

  const status = mount.querySelector(".composer-status") as HTMLElement | null;
  if (status) {
    renderInputStatus(status, input, state);
  }

  if (!forceFocus && !state.draftHadFocus) return;
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

function bubble(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  message: Message,
  index: number,
) {
  const root = el(doc, "div", `bubble bubble-${message.role}`);
  root.dataset.messageIndex = String(index);
  const head = el(doc, "div", "bubble-head");
  head.append(
    el(doc, "div", "bubble-role", message.role === "user" ? "You" : "AI"),
  );

  const actions = el(doc, "div", "bubble-actions");
  const copy = buttonEl(doc, "复制");
  copy.addEventListener("click", () => {
    void copyToClipboard(doc, messageToClipboard(message));
    flashButton(copy, "已复制");
  });
  actions.append(copy);

  // Retry button only appears on the LATEST assistant message. WHY: the
  // regenerate path drops the last assistant message and re-streams from
  // the prior user turn — meaningful only for the latest exchange. Older
  // assistant messages get only copy/delete actions.
  if (
    message.role === "assistant" &&
    index === findLastAssistantIndex(state.messages)
  ) {
    const retry = buttonEl(doc, "重试");
    retry.disabled = state.sending;
    retry.addEventListener(
      "click",
      () => void regenerateLastResponse(mount, state),
    );
    actions.append(retry);
  }

  const del = buttonEl(doc, "删除");
  del.disabled = state.sending;
  del.addEventListener("click", () => {
    state.messages = state.messages.filter((_, i) => i !== index);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
  });
  actions.append(del);
  head.append(actions);

  root.append(head);
  if (message.role === "user") {
    renderMessageImages(doc, root, message.images);
  }
  if (message.role === "assistant") {
    renderAssistantProcess(
      doc,
      root,
      state.messages[findPreviousUserIndex(state.messages, index)],
    );
  }
  const progress = assistantProgressFor(state, index, message);
  if (progress) {
    root.append(renderAssistantProgress(doc, progress));
  }
  if (message.role === "assistant" && message.thinking) {
    const details = el(doc, "details", "bubble-thinking") as HTMLDetailsElement;
    details.open = true;
    details.append(el(doc, "summary", "", "思考过程"));
    const thinkingBody = el(doc, "div", "bubble-thinking-body");
    renderMarkdownInto(thinkingBody, message.thinking);
    details.append(thinkingBody);
    root.append(details);
  }
  const body = el(doc, "div", "bubble-body");
  renderMarkdownInto(body, message.content || (progress ? " " : ""));
  root.append(body);
  if (message.role === "assistant" && message.annotationDraft) {
    root.append(
      renderAnnotationSuggestion(
        doc,
        mount,
        state,
        index,
        message.annotationDraft,
      ),
    );
  }
  return root;
}

// Render the assistant's "建议注释" block (parsed by annotation-draft.ts).
// READ-ONLY display until the user clicks "保存". INVARIANT: this is NOT a
// hidden write — saving requires a button click and routes through
// `saveAnnotationDraftFromBubble`, which goes through the same Zotero
// annotation API as a manual annotation. CLAUDE.md "No hidden Zotero writes".
function renderAnnotationSuggestion(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  index: number,
  draft: AssistantAnnotationDraft,
): HTMLElement {
  const box = el(doc, "div", "annotation-suggestion");
  const head = el(doc, "div", "annotation-suggestion-head");
  head.append(el(doc, "span", "annotation-suggestion-icon", "📌"));
  head.append(el(doc, "span", "annotation-suggestion-title", "建议注释"));
  const preview = previewSelection(draft.snapshot.text);
  if (preview) {
    const ctx = el(
      doc,
      "span",
      "annotation-suggestion-context",
      `基于：「${preview}」`,
    );
    ctx.title = draft.snapshot.text;
    head.append(ctx);
  }
  box.append(head);

  const body = el(doc, "div", "annotation-suggestion-body");
  renderMarkdownInto(body, draft.comment);
  box.append(body);

  box.append(
    renderAnnotationSuggestionActions(doc, mount, state, index, draft),
  );
  return box;
}

function renderAnnotationSuggestionActions(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  index: number,
  draft: AssistantAnnotationDraft,
): HTMLElement {
  const actions = el(doc, "div", "annotation-suggestion-actions");
  const button = buttonEl(doc, "");
  button.classList.add("annotation-save");
  applyAnnotationButtonState(button, draft);
  button.addEventListener("click", () => {
    void saveAnnotationDraftFromBubble(mount, state, index);
  });
  actions.append(button);

  if (draft.state.kind === "failed") {
    const err = el(
      doc,
      "div",
      "annotation-suggestion-error",
      draft.state.error,
    );
    actions.append(err);
  }
  return actions;
}

function applyAnnotationButtonState(
  button: HTMLButtonElement,
  draft: AssistantAnnotationDraft,
) {
  switch (draft.state.kind) {
    case "idle":
      button.textContent = "💾 保存为注释";
      button.disabled = false;
      button.title = "将这条建议作为注释写入当前 PDF 选区";
      return;
    case "saving":
      button.textContent = "保存中…";
      button.disabled = true;
      button.title = "";
      return;
    case "saved":
      button.textContent = "✓ 已保存";
      button.disabled = true;
      button.title = `Zotero annotation #${draft.state.annotationID}`;
      return;
    case "failed":
      button.textContent = "↻ 重试";
      button.disabled = false;
      button.title = draft.state.error;
      return;
  }
}

function previewSelection(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 60)}…`;
}

interface AssistantProgress {
  label: string;
  detail: string;
}

function assistantProgressFor(
  state: PanelState,
  index: number,
  message: Message,
): AssistantProgress | null {
  if (message.role !== "assistant" || state.activeAssistantIndex !== index)
    return null;
  if (!state.sending) return null;

  const sourceUser =
    state.messages[findPreviousUserIndex(state.messages, index)];
  const latestTool = latestToolTrace(sourceUser);
  if (latestTool?.status === "started") {
    return {
      label: "正在调用 Zotero 工具",
      detail: latestTool.summary || latestTool.name,
    };
  }

  const stage = state.activeAssistantStage ?? "starting";
  const hasThinking = !!message.thinking?.trim();
  const hasContent = !!message.content.trim();
  const selectedText = sourceUser?.context?.selectedText;

  switch (stage) {
    case "building_context":
      return {
        label: "正在整理上下文",
        detail: selectedText
          ? `已带入 PDF 选区 ${selectedText.length} 字`
          : "正在准备系统提示和可用 Zotero 工具",
      };
    case "waiting_model":
      return {
        label: hasThinking ? "模型仍在思考" : "等待模型响应",
        detail: latestTool?.summary || "请求已发送，等待首个流式事件",
      };
    case "thinking":
      return {
        label: "模型正在思考",
        detail:
          "进度正在更新；可见思考取决于当前模型/API 是否返回 reasoning summary",
      };
    case "using_tool":
      return {
        label: "正在使用工具",
        detail: latestTool?.summary || "等待 Zotero 工具返回",
      };
    case "writing":
      return {
        label: hasContent ? "正在生成回答" : "正在开始回答",
        detail: hasThinking
          ? "已收到思考过程，正在输出正文"
          : "正在流式输出正文",
      };
    case "starting":
    default:
      return {
        label: "准备发送给模型",
        detail: "正在初始化本轮回复",
      };
  }
}

function latestToolTrace(message: Message | undefined) {
  const tools = message?.context?.toolCalls;
  return Array.isArray(tools) && tools.length ? tools[tools.length - 1] : null;
}

function renderAssistantProgress(
  doc: Document,
  progress: AssistantProgress,
): HTMLElement {
  const row = el(doc, "div", "assistant-live-progress");
  row.append(
    el(doc, "span", "assistant-live-spinner"),
    el(doc, "span", "assistant-live-label", progress.label),
    el(doc, "span", "assistant-live-detail", progress.detail),
  );
  return row;
}

async function saveAnnotationDraftFromBubble(
  mount: HTMLElement,
  state: PanelState,
  index: number,
) {
  const message = state.messages[index];
  const draft = message?.annotationDraft;
  if (!message || !draft) return;
  if (draft.state.kind === "saving" || draft.state.kind === "saved") return;

  draft.state = { kind: "saving" };
  refreshAnnotationSuggestion(mount, index);
  try {
    const { id } = await saveSelectionAnnotation(draft.snapshot, {
      comment: draft.comment,
    });
    draft.state = { kind: "saved", annotationID: id, savedAt: Date.now() };
  } catch (err) {
    draft.state = {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  void saveChatMessages(state.itemID, state.messages);
  refreshAnnotationSuggestion(mount, index);
}

function refreshAnnotationSuggestion(mount: HTMLElement, index: number) {
  const state = states.get(mount);
  if (!state) return;
  const message = state.messages[index];
  if (!message?.annotationDraft) return;
  const root = mount.querySelector(
    `[data-message-index="${index}"]`,
  ) as HTMLElement | null;
  if (!root) return;
  const existing = root.querySelector(
    ".annotation-suggestion",
  ) as HTMLElement | null;
  const next = renderAnnotationSuggestion(
    root.ownerDocument!,
    mount,
    state,
    index,
    message.annotationDraft,
  );
  if (existing) existing.replaceWith(next);
  else root.append(next);
}

// Renders the "思考与上下文" collapsible block above an assistant bubble.
// IMPORTANT: pulls context from the PREVIOUS USER turn, NOT the assistant
// itself. WHY: context (selectedText / passages / tool calls) is recorded
// on the user message — that's the turn that triggered the model. The
// assistant message is just the response, with no context of its own.
// Matches Claudian's pattern of pinning the context card to the question
// that triggered the answer.
function renderAssistantProcess(
  doc: Document,
  root: HTMLElement,
  sourceUser: Message | undefined,
) {
  if (!sourceUser?.context) return;

  const summary = contextSummaryLine(sourceUser);
  const tools = sourceUser.context.toolCalls;
  if (!summary && !tools?.length) return;

  const details = el(doc, "details", "assistant-process") as HTMLDetailsElement;
  details.open = true;
  details.append(
    el(
      doc,
      "summary",
      "",
      summary ? `思考与上下文 · ${summary}` : "思考与上下文",
    ),
  );

  const body = el(doc, "div", "assistant-process-body");
  if (summary) {
    const chip = el(doc, "div", "bubble-context-chip", summary);
    if (sourceUser.context.planReason)
      chip.title = sourceUser.context.planReason;
    body.append(chip);
  }
  renderToolTrace(doc, body, tools);
  details.append(body);
  root.append(details);
}

function renderMessageImages(
  doc: Document,
  root: HTMLElement,
  images: Message["images"] | undefined,
) {
  if (!images?.length) return;
  const tray = el(doc, "div", "message-images");
  for (const image of images) {
    const figure = el(doc, "figure", "message-image");
    const img = doc.createElement("img");
    img.src = image.dataUrl;
    img.alt = image.name;
    const caption = el(doc, "figcaption", "", image.name);
    figure.append(img, caption);
    tray.append(figure);
  }
  root.append(tray);
}

function renderToolTrace(
  doc: Document,
  root: HTMLElement,
  tools: NonNullable<Message["context"]>["toolCalls"] | undefined,
) {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const box = el(doc, "div", "bubble-tool-trace");
  for (const tool of tools) {
    const row = el(doc, "div", `bubble-tool-row tool-${tool.status}`);
    row.append(
      el(doc, "span", "bubble-tool-dot"),
      el(doc, "span", "bubble-tool-name", tool.name),
    );
    if (tool.summary)
      row.append(el(doc, "span", "bubble-tool-summary", tool.summary));
    box.append(row);
  }
  root.append(box);
}

// Hand-rolled Markdown block parser.
// =====================================================================
// WHY hand-rolled (not a library):
//   1. SECURITY — model output runs in the privileged Zotero XUL context.
//      Every text node is created via `createTextNode` / `textContent` so
//      a prompt-injected `<script>` or `<iframe>` cannot execute. A
//      general-purpose Markdown lib would need a sanitizer pass and we'd
//      still be one library upgrade away from a regression.
//   2. STREAMING — open delimiters (e.g. unclosed `**`) fall back to
//      literal text rather than corrupting subsequent chunks. The
//      renderer is called repeatedly during streaming with growing
//      content; partial syntax must never produce broken DOM.
//   3. BUNDLE SIZE — Zotero plugin loads in a XUL window; we want zero
//      external runtime cost for chat rendering.
//
// Supported subset (block):
//   #/##/###/#### headings, ordered+unordered lists (no nesting),
//   ```fence``` code blocks, > blockquote, paragraphs.
// NOT supported: tables, HR, image syntax, nested lists, setext headings.
// REF: Claudian's MessageRenderer (similar minimal subset for the same
//      streaming reasons); CommonMark spec we deliberately don't follow.
function renderMarkdownInto(target: HTMLElement, markdown: string) {
  const doc = target.ownerDocument!;
  target.replaceChildren();
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  let paragraph: string[] = [];
  let list: HTMLElement | null = null;
  let codeLines: string[] | null = null;
  let codeLanguage = "";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = doc.createElement("p");
    appendInlineMarkdown(p, paragraph.join(" "));
    target.append(p);
    paragraph = [];
  };

  const flushList = () => {
    list = null;
  };

  const appendListItem = (text: string, ordered: boolean) => {
    flushParagraph();
    const tag = ordered ? "ol" : "ul";
    if (!list || list.tagName.toLowerCase() !== tag) {
      list = doc.createElement(tag);
      target.append(list);
    }
    const li = doc.createElement("li");
    appendInlineMarkdown(li, text);
    list.append(li);
  };

  // INVARIANT: code body uses `textContent`, NOT innerHTML — prompt
  // injection inside fenced code stays as displayed text. Class name uses
  // `language-${lang}` for any future syntax-highlighting CSS hook.
  const flushCode = () => {
    if (codeLines == null) return;
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    if (codeLanguage) code.className = `language-${codeLanguage}`;
    code.textContent = codeLines.join("\n");
    pre.append(code);
    target.append(pre);
    codeLines = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeLines == null) {
        flushParagraph();
        flushList();
        codeLines = [];
        codeLanguage = line.slice(3).trim();
      } else {
        flushCode();
      }
      continue;
    }

    if (codeLines != null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingLevel = markdownHeadingLevel(line);
    if (headingLevel > 0) {
      flushParagraph();
      flushList();
      const heading = doc.createElement(`h${headingLevel}`);
      appendInlineMarkdown(heading, line.slice(headingLevel + 1).trim());
      target.append(heading);
      continue;
    }

    const unordered = unorderedListText(line);
    if (unordered != null) {
      appendListItem(unordered, false);
      continue;
    }

    const ordered = orderedListText(line);
    if (ordered != null) {
      appendListItem(ordered, true);
      continue;
    }

    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      const quote = doc.createElement("blockquote");
      appendInlineMarkdown(quote, line.slice(2));
      target.append(quote);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
}

// Inline markdown: `code`, **bold**, [label](url).
// Streaming-safe pattern: at each step we look for the EARLIEST opening
// delimiter; if its closing partner is not yet in the buffer, we emit the
// rest as literal text and return. WHY: during streaming, the next chunk
// may bring the closing delimiter — but until then, NEVER half-render a
// `<strong>` or `<a>` (those would have to be unwound on the next call).
// INVARIANT: every emitted node is either createTextNode or createElement
// with textContent; no innerHTML on any path.
function appendInlineMarkdown(parent: HTMLElement, text: string) {
  const doc = parent.ownerDocument!;
  let cursor = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf("`", cursor);
    const boldStart = text.indexOf("**", cursor);
    const linkStart = text.indexOf("[", cursor);
    const starts = [codeStart, boldStart, linkStart].filter(
      (index) => index >= 0,
    );
    const next = starts.length ? Math.min(...starts) : -1;

    if (next < 0) {
      parent.append(doc.createTextNode(text.slice(cursor)));
      return;
    }
    if (next > cursor) {
      parent.append(doc.createTextNode(text.slice(cursor, next)));
    }

    if (next === codeStart) {
      const end = text.indexOf("`", next + 1);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const code = doc.createElement("code");
      code.textContent = text.slice(next + 1, end);
      parent.append(code);
      cursor = end + 1;
      continue;
    }

    if (next === boldStart) {
      const end = text.indexOf("**", next + 2);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const strong = doc.createElement("strong");
      appendInlineMarkdown(strong, text.slice(next + 2, end));
      parent.append(strong);
      cursor = end + 2;
      continue;
    }

    const link = parseMarkdownLink(text, next);
    if (!link) {
      parent.append(doc.createTextNode(text[next]));
      cursor = next + 1;
      continue;
    }
    // GOTCHA: `target=_blank` + `rel=noreferrer` is required for any link
    // rendered from model output. Without rel=noreferrer, Firefox would
    // pass the Zotero XUL window's referrer to the opened page.
    const anchor = doc.createElement("a");
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    appendInlineMarkdown(anchor, link.label);
    parent.append(anchor);
    cursor = link.end;
  }
}

function markdownHeadingLevel(line: string): number {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  return level > 0 && level <= 4 && line[level] === " " ? level : 0;
}

function unorderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  if (trimmed.startsWith("- ") || trimmed.startsWith("* "))
    return trimmed.slice(2).trim();
  return null;
}

function orderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  let index = 0;
  while (index < trimmed.length && isDigit(trimmed[index])) index++;
  if (index === 0 || trimmed[index] !== "." || trimmed[index + 1] !== " ")
    return null;
  return trimmed.slice(index + 2).trim();
}

function trimListIndent(line: string): string {
  let index = 0;
  while (line[index] === " " || line[index] === "\t") index++;
  return line.slice(index);
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function parseMarkdownLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  const closeLabel = text.indexOf("]", start + 1);
  if (closeLabel < 0 || text[closeLabel + 1] !== "(") return null;
  const closeHref = text.indexOf(")", closeLabel + 2);
  if (closeHref < 0) return null;
  const href = text.slice(closeLabel + 2, closeHref).trim();
  if (!href) return null;
  return {
    label: text.slice(start + 1, closeLabel),
    href,
    end: closeHref + 1,
  };
}

function findLastAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

function findPreviousUserIndex(messages: Message[], fromIndex: number): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

async function copyToClipboard(doc: Document, text: string) {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const root = doc.body ?? doc.documentElement;
  if (!root) return;
  root.append(textarea);
  textarea.select();
  doc.execCommand("copy");
  textarea.remove();
}

function flashButton(button: HTMLButtonElement, text: string) {
  const original = button.textContent || "";
  button.textContent = text;
  button.disabled = true;
  button.ownerDocument?.defaultView?.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 900);
}

function messageToClipboard(message: Message): string {
  if (message.role === "user") {
    return [
      formatUserMessageForApi(message),
      formatImageAttachmentSummary(message),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (!message.thinking) return message.content;
  return `## 思考过程\n${message.thinking}\n\n## 回答\n${message.content}`;
}

function formatConversationMarkdown(state: PanelState): string {
  const item = state.itemID == null ? null : Zotero.Items.get(state.itemID);
  const title = item?.getField("title") || "未选择条目";
  const lines = [
    `# Zotero AI Chat - ${title}`,
    "",
    `- Item ID: ${state.itemID ?? "none"}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
  ];

  for (const message of state.messages) {
    lines.push(`## ${message.role === "user" ? "You" : "AI"}`, "");
    lines.push(...formatContextMarkdown(message));
    const imageSummary = formatImageAttachmentSummary(message);
    if (imageSummary) lines.push(imageSummary, "");
    if (message.thinking) {
      lines.push("### 思考过程", "", message.thinking, "");
    }
    lines.push(message.content, "");
  }

  return lines.join("\n");
}

function formatImageAttachmentSummary(message: Message): string {
  if (!message.images?.length) return "";
  const lines = ["### 截图附件"];
  message.images.forEach((image, index) => {
    lines.push(
      `- ${index + 1}. ${image.name} (${image.mediaType}, ${formatBytes(image.size)})`,
    );
  });
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function selectedPreset(state: PanelState): ModelPreset | null {
  return (
    state.presets.find((p) => p.id === state.selectedId) ??
    state.presets[0] ??
    null
  );
}

function selectedChatPreset(state: PanelState): ModelPreset | null {
  const presets = configuredPresets(state);
  return presets.find((p) => p.id === state.selectedId) ?? presets[0] ?? null;
}

function configuredPresets(state: PanelState): ModelPreset[] {
  return state.presets.filter(isPresetConfigured);
}

function isPresetConfigured(preset: ModelPreset): boolean {
  return !!preset.apiKey.trim() && !!preset.model.trim();
}

function agentPermissionMode(
  preset: ModelPreset | null | undefined,
): AgentPermissionMode {
  return preset?.extras?.agentPermissionMode === "yolo" ? "yolo" : "default";
}

function withAgentPermissionMode(
  preset: ModelPreset,
  mode: AgentPermissionMode,
): ModelPreset {
  return {
    ...preset,
    extras: {
      ...preset.extras,
      agentPermissionMode: mode,
    },
  };
}

function persist(state: PanelState) {
  savePresets(zoteroPrefs(), state.presets);
}

function upsertPreset(state: PanelState, next: ModelPreset) {
  const index = state.presets.findIndex((p) => p.id === next.id);
  state.presets =
    index >= 0
      ? state.presets.map((p) => (p.id === next.id ? next : p))
      : [...state.presets, next];
}

function updateToolbarOption(mount: HTMLElement, preset: ModelPreset) {
  const option = Array.from(
    mount.querySelectorAll(".preset-switcher option"),
  ).find((node) => (node as HTMLOptionElement).value === preset.id) as
    | HTMLOptionElement
    | undefined;
  if (option) {
    option.textContent = `${preset.label} (${preset.provider} · ${preset.model || "no model"})`;
  }
}

function updateSendControls(mount: HTMLElement, state: PanelState) {
  const preset = selectedChatPreset(state);
  const ready = !!preset?.apiKey && !!preset.model && !state.sending;
  const textarea = mount.querySelector(
    ".input-row textarea",
  ) as HTMLTextAreaElement | null;
  const button = mount.querySelector(
    ".input-row button",
  ) as HTMLButtonElement | null;
  if (textarea) {
    textarea.disabled = !preset;
  }
  if (button && button.textContent === "发送") {
    button.disabled = !ready;
    button.title = preset && !ready ? "请先填写 API Key 和 Model ID" : "";
  }
}

function makePreset(provider: ProviderKind): ModelPreset {
  return {
    id: makeId(),
    provider,
    label: provider === "anthropic" ? "Claude" : "GPT",
    apiKey: "",
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: DEFAULT_MODELS[provider],
    maxTokens: 8192,
    extras:
      provider === "openai"
        ? {
            reasoningEffort: DEFAULT_REASONING_EFFORT,
            reasoningSummary: DEFAULT_REASONING_SUMMARY,
            agentPermissionMode: "default",
          }
        : {
            agentPermissionMode: "default",
          },
  };
}

function makeId(): string {
  return `preset-${Date.now()}-${Zotero.Utilities.randomString(6)}`;
}

function el(
  doc: Document,
  tag: string,
  className = "",
  text?: string,
): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buttonEl(doc: Document, text: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.textContent = text;
  return button;
}

function inputEl(
  doc: Document,
  value: string,
  type = "text",
): HTMLInputElement {
  const input = doc.createElement("input");
  input.type = type;
  input.value = value;
  return input;
}

function selectEl(
  doc: Document,
  options: Array<[string, string]>,
): HTMLSelectElement {
  const select = doc.createElement("select");
  for (const [value, label] of options) {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  return select;
}

function field(doc: Document, label: string, control: HTMLElement) {
  const wrapper = el(doc, "label", "prefs-field");
  wrapper.append(el(doc, "span", "", label), control);
  return wrapper;
}

// Plugin lifecycle entry.
// `registerSidebar` runs once on bootstrap; `registerSidebarForWindow`
// runs for each Zotero main window (Zotero supports multiple windows).
// INVARIANT: must be idempotent — `registered` flag and per-window
// `windowSidebars` Map dedupe re-entries.
export function registerSidebar() {
  registered = true;
  registerReaderSelectionCapture();
  for (const win of Zotero.getMainWindows()) {
    registerSidebarForWindow(win);
  }
}

export function registerSidebarForWindow(win: Window) {
  if (!registered || windowSidebars.has(win)) return;

  const doc = win.document;
  const contextPane = doc.getElementById("zotero-context-pane");
  const parent = contextPane?.parentElement;
  if (!contextPane || !parent) {
    Zotero.debug("[Zotero AI Sidebar] Could not find Zotero pane container");
    return;
  }

  doc.getElementById(SPLITTER_ID)?.remove();
  doc.getElementById(COLUMN_ID)?.remove();

  // XUL splitter + vbox: native Zotero column rather than a React mount.
  // WHY native DOM (not React): Zotero 7+'s ItemPane DOES NOT recover
  // gracefully from a React tree crash inside its custom-element column.
  // CLAUDE.md: "avoid reintroducing React UI in the Zotero pane unless
  // crash behavior has been revalidated."
  // `zotero-persist=width` lets Zotero remember the user's column width
  // across restarts. The wheel-stopPropagation prevents scroll events from
  // bleeding through to the items pane underneath.
  const splitter = doc.createXULElement("splitter");
  splitter.id = SPLITTER_ID;
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");
  splitter.setAttribute("collapse", "after");
  splitter.setAttribute("orient", "horizontal");
  splitter.append(doc.createXULElement("grippy"));

  const column = doc.createXULElement("vbox");
  column.id = COLUMN_ID;
  column.setAttribute("class", "zai-column");
  column.setAttribute("width", "380");
  column.setAttribute("zotero-persist", "width");
  column.addEventListener("wheel", (event: Event) => event.stopPropagation(), {
    passive: true,
  });

  const link = doc.createElementNS(XHTML_NS, "link") as HTMLLinkElement;
  link.rel = "stylesheet";
  link.href = `chrome://${addon.data.config.addonRef}/content/sidebar.css`;

  const mount = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  mount.id = ROOT_ID;
  mount.className = "zai-root-independent";

  column.append(link, mount);
  parent.insertBefore(splitter, contextPane.nextSibling);
  parent.insertBefore(column, splitter.nextSibling);

  const state: WindowSidebarState = { column, splitter, mount };
  splitter.addEventListener("command", () => updateToggleButton(state));
  splitter.addEventListener("mouseup", () => updateToggleButton(state));
  windowSidebars.set(win, state);
  mountedWindows.add(win);
  installToggleButton(win, state);
  installFloatingToggle(win, state);
  patchItemSelection(win, state);
  startSelectionMonitor(win, state);
  renderWindowSidebar(win);
}

export function unregisterSidebarForWindow(win: Window) {
  const state = windowSidebars.get(win);
  if (!state) return;

  const pane = (win as any).ZoteroPane;
  if (
    state.originalItemSelected &&
    state.patchedItemSelected &&
    pane?.itemSelected === state.patchedItemSelected
  ) {
    pane.itemSelected = state.originalItemSelected;
  }

  state.splitter.remove();
  state.column.remove();
  state.toggleButton?.remove();
  state.floatingButton?.remove();
  stopSelectionMonitor(win, state);
  mountedWindows.delete(win);
  windowSidebars.delete(win);
}

export function unregisterSidebar() {
  registered = false;
  unregisterReaderSelectionCapture();
  for (const win of Array.from(mountedWindows)) {
    unregisterSidebarForWindow(win);
  }
}

function renderWindowSidebar(win: Window) {
  const state = windowSidebars.get(win);
  if (!state) return;

  const itemID = getSelectedItemID(win);
  const panelState = states.get(state.mount);
  if (panelState?.sending) {
    updateSelectionIndicators(state.mount, panelState.itemID);
    updateToggleButton(state);
    return;
  }

  renderMount(state.mount, itemID);
  updateToggleButton(state);
}

function installToggleButton(win: Window, state: WindowSidebarState) {
  const doc = win.document;
  const toolbar = doc.getElementById("zotero-items-toolbar");
  if (!toolbar) return;

  doc.getElementById(TOGGLE_BUTTON_ID)?.remove();

  const button = doc.createXULElement("toolbarbutton");
  button.id = TOGGLE_BUTTON_ID;
  button.setAttribute("class", "zotero-tb-button zai-toggle-button");
  button.setAttribute("label", "AI");
  button.setAttribute("tooltiptext", "显示/隐藏 AI 对话");
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/ai-chat.svg`;
  button.setAttribute("image", icon);
  button.setAttribute("style", `list-style-image: url("${icon}");`);
  button.addEventListener("command", () => {
    setColumnCollapsed(win, state, !isColumnCollapsed(state));
  });

  const spacer = toolbar.querySelector('spacer[flex="1"]');
  toolbar.insertBefore(button, spacer ?? null);
  state.toggleButton = button;
  updateToggleButton(state);
}

function installFloatingToggle(win: Window, state: WindowSidebarState) {
  const doc = win.document;
  const stack = doc.getElementById("zotero-pane-stack") ?? doc.documentElement;
  if (!stack) return;
  doc.getElementById(FLOATING_TOGGLE_ID)?.remove();

  const button = doc.createElementNS(XHTML_NS, "button") as HTMLButtonElement;
  button.id = FLOATING_TOGGLE_ID;
  button.className = "zai-floating-toggle";
  button.type = "button";
  button.title = "打开/隐藏 AI 对话";

  const icon = doc.createElementNS(XHTML_NS, "img") as HTMLImageElement;
  icon.src = `chrome://${addon.data.config.addonRef}/content/icons/ai-chat.svg`;
  icon.alt = "";
  const label = doc.createElementNS(XHTML_NS, "span");
  label.textContent = "AI";
  button.append(icon, label);

  button.addEventListener("click", () => {
    setColumnCollapsed(win, state, !isColumnCollapsed(state));
  });

  stack.append(button);
  state.floatingButton = button;
  updateToggleButton(state);
}

function setColumnCollapsed(
  win: Window,
  state: WindowSidebarState,
  collapsed: boolean,
) {
  const column = state.column as Element & { collapsed?: boolean };
  const splitter = state.splitter as Element & { hidden?: boolean };
  if (collapsed) {
    column.collapsed = true;
    splitter.hidden = true;
    state.column.setAttribute("collapsed", "true");
    state.splitter.setAttribute("hidden", "true");
  } else {
    column.collapsed = false;
    splitter.hidden = false;
    state.column.removeAttribute("collapsed");
    state.column.removeAttribute("hidden");
    state.splitter.removeAttribute("hidden");
    state.splitter.removeAttribute("state");
    if (!state.column.getAttribute("width")) {
      state.column.setAttribute("width", "380");
    }
    renderWindowSidebar(win);
  }
  updateToggleButton(state);
}

function hideCurrentSidebar(mount: HTMLElement) {
  for (const win of mountedWindows) {
    const state = windowSidebars.get(win);
    if (state?.mount === mount) {
      setColumnCollapsed(win, state, true);
      return;
    }
  }
}

function isColumnCollapsed(state: WindowSidebarState): boolean {
  const column = state.column as Element & {
    collapsed?: boolean;
    hidden?: boolean;
  };
  return (
    column.collapsed === true ||
    column.hidden === true ||
    state.splitter.getAttribute("state") === "collapsed" ||
    state.column.getAttribute("collapsed") === "true" ||
    state.column.getAttribute("hidden") === "true"
  );
}

function updateToggleButton(state: WindowSidebarState) {
  const collapsed = isColumnCollapsed(state);
  for (const button of [state.toggleButton, state.floatingButton]) {
    if (!button) continue;
    const tooltip = collapsed ? "打开 AI 对话" : "隐藏 AI 对话";
    button.setAttribute("tooltiptext", tooltip);
    button.setAttribute("title", tooltip);
    button.setAttribute("aria-pressed", collapsed ? "false" : "true");
    button.toggleAttribute("checked", !collapsed);
    button.classList.toggle("is-open", !collapsed);
    if (button === state.floatingButton) {
      button.toggleAttribute("hidden", !collapsed);
    }
  }
}

// Monkey-patches `ZoteroPane.itemSelected` so we re-render after the user
// selects an item. WHY patch (not just a setInterval): item selection is
// the single trigger we MUST react to to swap chat threads, and Zotero
// doesn't expose a clean event for it on every supported version.
// INVARIANT: `unregisterSidebarForWindow` only restores the original if
// our patched function is still installed — defends against another
// plugin patching after us (we'd otherwise undo their patch).
// REF: Zotero source `chrome/content/zotero/zoteroPane.js` ZoteroPane.itemSelected.
function patchItemSelection(win: Window, state: WindowSidebarState) {
  const pane = (win as any).ZoteroPane;
  if (typeof pane?.itemSelected !== "function") return;

  const original = pane.itemSelected;
  const patched = function patchedItemSelected(
    this: unknown,
    ...args: unknown[]
  ) {
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      renderWindowSidebar(win);
      throw err;
    }

    Promise.resolve(result).finally(() => renderWindowSidebar(win));
    return result;
  };

  state.originalItemSelected = original;
  state.patchedItemSelected = patched;
  pane.itemSelected = patched;
}

function getSelectedItemID(win: Window): number | null {
  const readerID = activeReaderConversationItemID(win);
  if (readerID != null) return readerID;

  const pane = (win as any).ZoteroPane;
  const selected = pane?.getSelectedItems?.();
  const item = Array.isArray(selected) ? selected[0] : null;
  return conversationItemID(item);
}

// "Conversation item ID" = the parent regular item, NOT the PDF
// attachment. WHY: a chat thread is keyed by the bibliographic item so
// the same conversation persists across opening different attachments
// (e.g. paper PDF vs supplementary PDF). When the Reader is on the
// attachment, walk up to its parent.
function activeReaderConversationItemID(win: Window): number | null {
  const reader = getActiveReader(win);
  const r = reader as {
    itemID?: number;
    _item?: { id?: number; parentID?: number };
  } | null;
  return typeof r?._item?.parentID === "number"
    ? r._item.parentID
    : typeof r?._item?.id === "number"
      ? itemIDToParentID(r._item.id)
      : itemIDToParentID(r?.itemID);
}

function conversationItemID(item: unknown): number | null {
  const i = item as {
    id?: number;
    parentID?: number;
    isAttachment?: () => boolean;
  } | null;
  if (!i) return null;
  if (typeof i.parentID === "number") return i.parentID;
  const id = i.id;
  return typeof id === "number" ? id : null;
}

function itemIDToParentID(itemID: unknown): number | null {
  if (typeof itemID !== "number") return null;
  try {
    const item = Zotero.Items.get(itemID) as {
      id?: number;
      parentID?: number;
    } | null;
    return conversationItemID(item);
  } catch {
    return itemID;
  }
}

declare global {
  interface Document {
    createXULElement(tagName: string): Element;
  }
}
