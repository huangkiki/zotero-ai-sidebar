import { buildContext } from "../context/builder";
import {
  createZoteroAgentToolSession,
  saveSelectionAnnotation,
  saveTextAnnotationNearSelection,
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
import { createPdfLocator } from "../context/pdf-locator";
import { extractPdfRange, searchPdfPassages } from "../context/retrieval";
import { zoteroContextSource } from "../context/zotero-source";
import { getProvider } from "../providers/factory";
import type {
  AssistantAnnotationDraft,
  ChatTaskMeta,
  Message,
  PdfSelectionLocator,
} from "../providers/types";
import { loadChatMessages, saveChatMessages } from "../settings/chat-history";
import { loadQuickPromptSettings } from "../settings/quick-prompts";
import { loadPresets, savePresets, zoteroPrefs } from "../settings/storage";
import {
  DEFAULT_LOCAL_UI_SETTINGS,
  loadLocalUiSettings,
  normalizeLocalUiSettings,
  saveLocalUiSettings,
  type LocalUiSettings,
} from "../settings/local-ui-settings";
import {
  loadToolSettings,
  saveToolSettings,
  type WebSearchMode,
} from "../settings/tool-settings";
import {
  loadUiSettings,
  type ChatProfileSettings,
  type UiSettings,
} from "../settings/ui-settings";
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  REASONING_EFFORT_OPTIONS,
  REASONING_SUMMARY_OPTIONS,
  type AgentPermissionMode,
  type ModelPreset,
  type ProviderKind,
  type ReasoningEffort,
  type ReasoningSummary,
} from "../settings/types";
import {
  expandSlashCommandMessage,
  matchingSlashCommands,
  type SlashCommand,
} from "../ui/slash-commands";
import {
  findNextMathRegion,
  renderMathInto,
  type MathRenderMode,
} from "../ui/math";
import { serializeSelectionAsMarkdown } from "../ui/selection-serialize";
import { TranslateModeController } from "../translate/translate-mode";

const translateControllers = new WeakMap<Window, TranslateModeController>();

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const COLUMN_ID = "zai-column";
const SPLITTER_ID = "zai-column-splitter";
const NOTE_COLUMN_ID = "zai-note-column";
const NOTE_SPLITTER_ID = "zai-note-column-splitter";
const NOTE_ROOT_ID = "zai-note-root";
const ROOT_ID = "zai-root";
const TOGGLE_BUTTON_ID = "zai-toggle-button";
const FLOATING_TOGGLE_ID = "zai-floating-toggle";
const READER_TRANSLATE_GROUP_ID = "zai-reader-translate-group";
const READER_TRANSLATE_STYLE_ID = "zai-reader-translate-style";
const contextPolicy = DEFAULT_CONTEXT_POLICY;
const IMAGE_PROMPT_MAX_DIMENSION = 2048;
const SELECTION_CONTEXT_RADIUS_CHARS = 2500;
const SELECTION_CONTEXT_QUERY_CHARS = 500;
const OPENAI_QUICK_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
];
// Tool guidance injected into each turn. This documents available choices;
// the model still decides which tool, if any, to call.
const ZOTERO_TOOL_MANUAL = [
  "Zotero tool manual:",
  "- The model, not the local UI, decides which Zotero tool to call. The local harness only validates arguments, enforces budgets/permissions, executes tools, and returns visible tool traces.",
  "- Use zotero_get_current_item for title, authors, year, tags, and abstract. Prefer it before whole-paper summaries, contribution analysis, or full-paper annotation planning.",
  "- Context-size selection is part of the model's tool planning: choose metadata, search hits, exact ranges, or the full PDF according to the current question instead of relying on local intent routing.",
  "- The ledger includes prior source identity, ranges, and tool summaries. Use it as structured memory to distinguish the current Zotero item from remote papers named by URLs and to choose the needed context size.",
  "- Use chat_get_previous_context when the ledger says relevant snippets were already attached in this chat and the raw text is needed again. This is a read-only chat-history tool; it does not fetch Zotero, arXiv, or web content.",
  "- Use zotero_get_full_pdf when the model decides the whole current Zotero PDF is needed for reading, summary, review, comparison, or analysis. Prior full-PDF sends appear in the ledger as source/range metadata so the model can choose between current history, targeted ranges, fresh full text, or asking the user for a resend.",
  "- Use zotero_search_pdf for targeted concepts, figures, experiments, equations, claims, definitions, section/chapter headings, and local evidence; use zotero_read_pdf_range only to expand cache-based ranges from prior tool output or the ledger.",
  "- Use zotero_get_annotations when the user asks about existing Zotero highlights, notes, comments, annotations, or reading marks.",
  "- Use zotero_get_current_pdf_selection when the user asks to inspect, print, translate, explain, or reason about the current PDF selection and [Selected PDF text] was not already supplied. This is read-only and follows the Zotero Reader selection snapshot used by annotation creation.",
  "- Use zotero_get_reader_pdf_text when the user explicitly asks to write PDF highlights/annotations or annotate the whole paper. Copy zotero_annotate_passage.text verbatim from zotero_get_reader_pdf_text output so the passage can be located in the Reader text layer.",
  "- Use zotero_add_text_annotation_to_selection when the user explicitly asks to place visible text directly on the PDF page like Zotero's T text tool. This creates a text-box annotation, not a highlight comment.",
  "- Use zotero_add_annotation_to_selection only when the user explicitly asks to save a note/comment on the current PDF selection.",
  "- Use zotero_annotate_passage only when the user explicitly asks to write highlights/annotations into the PDF. Do not use write tools for ordinary requests like summarizing key points unless the user asks to write/highlight/annotate in Zotero.",
  "- PDF modification requires approval or YOLO mode. If a write tool is blocked, explain that the user must enable YOLO or approve the write, and do not pretend the PDF was modified.",
  "- For paper-specific claims, rely on current context, prior assistant answers when the user is asking a continuation, chat_get_previous_context, or fresh Zotero/arXiv tool outputs. If you have only caption/text and not an image, say so explicitly for visual questions.",
].join("\n");

let registered = false;

interface WindowSidebarState {
  column: Element;
  splitter: Element;
  mount: HTMLElement;
  noteColumn: Element;
  noteSplitter: Element;
  noteMount: HTMLElement;
  noteItemID?: number;
  noteAutosaveTimer?: number;
  noteAutosavePromise?: Promise<void>;
  noteEditorCleanup?: () => void;
  copyHandlerCleanup?: () => void;
  selectionMenuCleanup?: () => void;
  promptShortcutCleanup?: () => void;
  readerTranslateToolbarCleanup?: () => void;
  initialRefreshCleanup?: () => void;
  lastCopySelection?: { text: string; updatedAt: number };
  toggleButton?: Element;
  floatingButton?: HTMLElement;
  selectionMonitorID?: number;
  originalItemSelected?: (...args: unknown[]) => unknown;
  patchedItemSelected?: (...args: unknown[]) => unknown;
}

const windowSidebars = new WeakMap<Window, WindowSidebarState>();
const windowRegisterRetries = new WeakMap<Window, number>();
const mountedWindows = new Set<Window>();
const selectedTextByItem = new Map<number, string>();
const selectedAnnotationByItem = new Map<number, SelectionAnnotationDraft>();
const ignoredSelectedTextByItem = new Map<number, string>();
const readerByAttachmentID = new Map<number, unknown>();
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
  activeAssistantDetail?: string;
  agentPermissionMode: AgentPermissionMode;
  copyDebugContext: boolean;
  uiSettings: UiSettings;
  pasteBlocks: PasteBlock[];
  draftImages: DraftImage[];
  nextPasteID: number;
  localUiSettings: LocalUiSettings;
  abort?: AbortController;
  messagesScrollLock?: MessagesScrollLock;
  activeTaskID?: string;
  cancellingTaskID?: string;
  queueOpen?: boolean;
  processingQueuedTask?: boolean;
  renderRecoveryAttempts?: number;
}

interface MessagesScrollSnapshot {
  top: number;
  atBottom: boolean;
}

interface MessagesScrollLock {
  snapshot: MessagesScrollSnapshot;
  until: number;
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
//   - same itemID: reload presets only when NOT editing, then reuse existing
//     messages/draft/scroll state. While editing, `state.presets` may contain
//     unsaved form changes; reloading prefs would resurrect the last saved
//     model list during background sidebar refreshes.
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
      copyDebugContext: false,
      uiSettings: loadUiSettings(zoteroPrefs()),
      pasteBlocks: [],
      draftImages: [],
      nextPasteID: 1,
      localUiSettings: loadLocalUiSettings(zoteroPrefs()),
    };
    states.set(mount, state);
    void loadPersistedMessages(mount, state);
  } else {
    if (!state.editing) {
      state.presets = loadPresets(zoteroPrefs());
    }
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
    state.uiSettings = loadUiSettings(zoteroPrefs());
    state.localUiSettings = loadLocalUiSettings(zoteroPrefs());
  }

  renderPanel(mount, state);
}

function renderPanel(mount: HTMLElement, state: PanelState) {
  const doc = mount.ownerDocument!;
  capturePanelState(mount, state);
  try {
    refreshActiveReaderSelection(doc.defaultView, state.itemID, false);
  } catch (err) {
    debugZai("sidebar.selection-refresh.failed", { error: errorMessage(err) });
  }

  let panel: HTMLElement;
  try {
    panel = el(doc, "div", "zai-app native-panel");
    panel.addEventListener("keydown", (event: KeyboardEvent) => {
      handleTaskEscape(mount, state, event);
    });
    applyChatAppearance(panel, state.uiSettings, state.localUiSettings);
    panel.append(renderToolbar(doc, mount, state));
    panel.append(renderContextCard(doc, state.itemID));
    panel.append(renderMessages(doc, mount, state));
    panel.append(renderInput(doc, mount, state));
  } catch (err) {
    debugZai("sidebar.render.failed", {
      error: errorMessage(err),
      itemID: state.itemID,
    });
    mount.replaceChildren(renderPanelRecovery(doc, mount, state, err));
    schedulePanelRecovery(mount, state);
    return;
  }

  state.renderRecoveryAttempts = 0;
  mount.replaceChildren();
  mount.append(panel);
  const shouldScroll = state.scrollToBottom;
  const shouldFocus = state.focusInput;
  state.scrollToBottom = false;
  state.focusInput = false;
  afterRender(mount, () => {
    const lockedScroll = activeMessagesScrollLock(state);
    if (lockedScroll) {
      scheduleMessagesScrollRestore(mount, lockedScroll);
    } else {
      restoreMessagesScroll(mount, state, !!shouldScroll);
    }
    restoreChatInput(mount, state, !!shouldFocus);
  });
}

function renderPanelRecovery(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  err: unknown,
): HTMLElement {
  const box = el(doc, "div", "zai-app native-panel");
  box.setAttribute(
    "style",
    [
      "box-sizing:border-box",
      "height:100%",
      "padding:14px",
      "font:13px/1.45 sans-serif",
      "background:#fbfaf7",
      "color:#24211d",
    ].join(";"),
  );
  box.append(
    el(doc, "strong", "", "AI 对话正在恢复"),
    el(doc, "div", "", "Zotero 刚加载时界面还没稳定，插件会自动重试。"),
  );
  const detail = el(doc, "div", "", errorMessage(err));
  detail.style.cssText = "margin-top:8px;color:#8a5a44;font-size:12px;";
  const retry = buttonEl(doc, "立即重试");
  retry.style.cssText = "margin-top:12px;";
  retry.addEventListener("click", () => renderPanel(mount, state));
  box.append(detail, retry);
  return box;
}

function schedulePanelRecovery(mount: HTMLElement, state: PanelState): void {
  const win = mount.ownerDocument?.defaultView;
  if (!win) return;
  const attempts = (state.renderRecoveryAttempts ?? 0) + 1;
  state.renderRecoveryAttempts = attempts;
  if (attempts > 8) return;
  const delay = Math.min(1600, 150 * attempts);
  win.setTimeout(() => {
    if (states.get(mount) === state) renderPanel(mount, state);
  }, delay);
}

function applyChatAppearance(
  panel: HTMLElement,
  settings: UiSettings,
  localSettings: LocalUiSettings,
): void {
  if (settings.chatFontFamily) {
    panel.style.setProperty("--zai-font", settings.chatFontFamily);
  } else {
    panel.style.removeProperty("--zai-font");
  }
  panel.style.setProperty(
    "--zai-chat-font-size",
    `${localSettings.chatFontSizePx}px`,
  );
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
    const lockedScroll = activeMessagesScrollLock(state);
    if (lockedScroll) {
      state.messagesScrollTop = lockedScroll.top;
      state.autoFollowMessages = lockedScroll.atBottom;
      return;
    }
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
  const toolbarPresets = configuredPresets(state);
  const selectedForToolbar = selectedChatPreset(state);
  const bar = el(
    doc,
    "div",
    toolbarPresets.length ? "preset-switcher" : "preset-empty",
  );
  const topRow = el(doc, "div", "preset-switcher-row preset-switcher-top");
  const bottomRow = el(
    doc,
    "div",
    "preset-switcher-row preset-switcher-bottom",
  );
  const title = el(doc, "strong", "", "AI 对话");
  topRow.append(title);

  if (toolbarPresets.length === 0) {
    topRow.append(el(doc, "span", "", "未配置模型"));
    const button = buttonEl(doc, "添加模型");
    button.addEventListener("click", () => {
      openAddonPreferences(doc);
    });
    bottomRow.append(button);
    bar.append(topRow, bottomRow);
    return bar;
  }

  const select = doc.createElement("select");
  for (const preset of toolbarPresets) {
    const option = doc.createElement("option");
    option.value = preset.id;
    option.textContent = presetSelectLabel(preset);
    select.append(option);
  }
  // Set after options exist; otherwise the browser falls back to the first item.
  select.value = selectedForToolbar?.id ?? "";
  select.addEventListener("change", () => {
    state.selectedId = select.value;
    state.agentPermissionMode = agentPermissionMode(
      selectedChatPreset(state) ?? selectedPreset(state),
    );
    renderPanel(mount, state);
  });
  topRow.append(select);

  const settings = buttonEl(doc, "设置");
  settings.addEventListener("click", () => {
    openAddonPreferences(doc);
  });
  if (state.messages.length > 0) {
    const copyAll = buttonEl(doc, "复制MD");
    copyAll.title = state.copyDebugContext
      ? "复制当前对话为 Markdown（含工具上下文和 PDF 片段）"
      : "复制当前对话为 Markdown（只含论文介绍和对话）";
    copyAll.addEventListener("click", () => {
      const markdown = formatConversationMarkdown(
        state,
        state.copyDebugContext,
      );
      void copyToClipboard(
        doc,
        markdown,
        undefined,
        markdownToClipboardHTML(doc, markdown),
      );
      flashButton(copyAll, "已复制");
    });
    topRow.append(copyAll);

    const clear = buttonEl(doc, "清空");
    clear.disabled = state.sending;
    clear.title = "清空并保存当前条目的聊天记录";
    clear.addEventListener("click", () => {
      state.messages = [];
      void saveChatMessages(state.itemID, state.messages);
      renderPanel(mount, state);
    });
    topRow.append(clear);
  }
  const noteWindowOpen = isNoteWindowOpenForMount(mount);
  const openNote = buttonEl(doc, noteWindowOpen ? "已打开" : "打开笔记");
  openNote.className = "open-note-button";
  openNote.title = "在当前 Zotero 窗口打开当前条目的子笔记";
  openNote.disabled = state.itemID == null || noteWindowOpen;
  openNote.addEventListener("click", () => {
    void openCurrentItemNote(doc, state.itemID, openNote);
  });
  bottomRow.append(openNote);
  bottomRow.append(settings);
  const win = mount.ownerDocument!.defaultView!;
  const translateBtn = buttonEl(doc, "译");
  translateBtn.className = "zai-sidebar-translate-button";
  translateBtn.title = "逐句翻译模式（点击切换开关）";
  syncTranslateBtnState(win, translateBtn);
  translateBtn.addEventListener("click", () => {
    void toggleTranslateMode(win, translateBtn);
  });
  bottomRow.append(translateBtn);
  const hide = buttonEl(doc, "隐藏");
  hide.title = "隐藏 AI 对话列";
  hide.addEventListener("click", () => hideCurrentSidebar(mount));
  bottomRow.append(hide);
  bottomRow.append(renderChatFontSizeControl(doc, mount, state));
  if (state.messages.length > 0) {
    bottomRow.append(renderCopyDebugToggle(doc, mount, state));
  }
  bar.append(topRow, bottomRow);
  return bar;
}

function renderChatFontSizeControl(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const wrap = el(doc, "label", "chat-font-size-control");
  wrap.title = "仅保存在本机，不参与 WebDAV 云同步";
  wrap.append(doc.createTextNode("字号"));
  const select = doc.createElement("select");
  for (const size of [11, 12, 13, 14, 15, 16, 18, 20, 22]) {
    const option = doc.createElement("option");
    option.value = String(size);
    option.textContent =
      size === DEFAULT_LOCAL_UI_SETTINGS.chatFontSizePx
        ? `${size}px 默认`
        : `${size}px`;
    select.append(option);
  }
  select.value = String(state.localUiSettings.chatFontSizePx);
  select.addEventListener("change", () => {
    const next = normalizeLocalUiSettings({
      ...state.localUiSettings,
      chatFontSizePx: select.value,
    });
    state.localUiSettings = next;
    saveLocalUiSettings(zoteroPrefs(), next);
    renderPanel(mount, state);
  });
  wrap.append(select);
  return wrap;
}

export function refreshSidebarPreferences(): void {
  for (const win of Zotero.getMainWindows()) {
    const sidebar = windowSidebars.get(win);
    if (!sidebar) continue;
    const state = states.get(sidebar.mount);
    if (!state) continue;
    const presets = loadPresets(zoteroPrefs());
    state.presets = presets;
    if (!state.selectedId || !presets.some((p) => p.id === state.selectedId)) {
      state.selectedId = configuredPresets(state)[0]?.id ?? presets[0]?.id ?? null;
    }
    state.agentPermissionMode = agentPermissionMode(
      selectedChatPreset(state) ?? selectedPreset(state),
    );
    state.uiSettings = loadUiSettings(zoteroPrefs());
    state.localUiSettings = loadLocalUiSettings(zoteroPrefs());
    renderPanel(sidebar.mount, state);
  }
}

function openAddonPreferences(doc: Document): void {
  const paneID = `${addon.data.config.addonRef}-prefs`;
  const zotero = Zotero as unknown as {
    PreferencePanes?: { open?: (id?: string) => void };
    Utilities?: { Internal?: { openPreferences?: (id?: string) => void } };
  };
  try {
    if (typeof zotero.PreferencePanes?.open === "function") {
      zotero.PreferencePanes.open(paneID);
      return;
    }
  } catch {}
  try {
    if (typeof zotero.Utilities?.Internal?.openPreferences === "function") {
      zotero.Utilities.Internal.openPreferences(paneID);
      return;
    }
  } catch {}
  doc.defaultView?.openDialog(
    "chrome://zotero/content/preferences/preferences.xhtml",
    "zotero-prefs",
    "chrome,titlebar,toolbar,centerscreen",
    paneID,
  );
}

function renderPresetEditor(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
) {
  const existing = selectedPreset(state);
  let current: ModelPreset = existing ?? makePreset("openai");
  if (!existing) {
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
  const initialModels =
    draft.models && draft.models.length > 0
      ? draft.models
      : draft.model
        ? [draft.model]
        : [];
  // Chip-style model list: each model is a compact pill (input + tiny ✕)
  // and "+" sits at the end as another chip. flex-wrap keeps them on one
  // row when space allows. Every input/delete fires syncDraft() so changes
  // save live, matching label/apiKey/baseUrl behavior.
  const modelsField = doc.createElement("div") as HTMLDivElement;
  modelsField.className = "preset-models-list";
  const placeholderFor = (kind: ProviderKind) =>
    DEFAULT_MODELS[kind] || (kind === "anthropic" ? "claude-..." : "gpt-...");
  // Auto-size the input via the `size` attribute (monospace font ⇒ ~1ch each).
  // Clamped 8..28 so empty inputs are still typable and crazy-long ids don't
  // blow out the row.
  const sizeModelInput = (input: HTMLInputElement) => {
    const text = input.value || input.placeholder;
    const width = Math.max(8, Math.min(28, text.length || 8));
    input.size = width;
    input.style.width = `${width}ch`;
  };
  const addModelChip = (initialValue: string): HTMLInputElement => {
    const chip = el(doc, "span", "preset-models-chip");
    const input = inputEl(doc, initialValue);
    input.placeholder = placeholderFor(provider.value as ProviderKind);
    input.classList.add("preset-models-input");
    input.spellcheck = false;
    input.addEventListener("input", () => {
      sizeModelInput(input);
      syncDraft();
    });
    const remove = buttonEl(doc, "✕");
    remove.classList.add("preset-models-remove");
    remove.title = "删除此模型";
    remove.addEventListener("click", () => {
      chip.remove();
      syncDraft();
    });
    chip.append(input, remove);
    modelsField.insertBefore(chip, addBtn);
    sizeModelInput(input);
    return input;
  };
  const addBtn = buttonEl(doc, "+ 添加");
  addBtn.classList.add("preset-models-add");
  addBtn.title = "添加一个新模型 ID";
  addBtn.addEventListener("click", () => {
    const input = addModelChip("");
    input.focus();
    updateSaveState();
  });
  modelsField.append(addBtn);
  for (const id of initialModels) addModelChip(id);
  const replaceModelChips = (ids: string[]) => {
    Array.from(modelsField.querySelectorAll(".preset-models-chip")).forEach(
      (chip) => (chip as HTMLElement).remove(),
    );
    for (const id of ids) addModelChip(id);
  };

  const collectModelInputs = (): HTMLInputElement[] =>
    Array.from(
      modelsField.querySelectorAll(".preset-models-input"),
    ) as HTMLInputElement[];

  const refreshModelShortcutState = () => {
    const activeModels = new Set(
      collectModelInputs().map((input) => input.value.trim()),
    );
    modelShortcuts
      .querySelectorAll("[data-model-id]")
      .forEach((node: Element) =>
        (node as HTMLElement).classList.toggle(
          "is-active",
          activeModels.has((node as HTMLElement).dataset.modelId ?? ""),
        ),
      );
  };

  const readModelsField = (): { model: string; models: string[] } => {
    const lines = collectModelInputs()
      .map((input) => input.value.trim())
      .filter((value) => value.length > 0);
    const providerKind = provider.value as ProviderKind;
    // Keep the user's currently-active selection sticky if it survives the
    // edit. Otherwise fall back to first row; if the list is empty, use
    // the provider default. Mirrors normalizePreset's repair logic.
    const active =
      current.model && lines.includes(current.model)
        ? current.model
        : lines[0] || DEFAULT_MODELS[providerKind];
    return { model: active, models: lines };
  };

  const maxTokens = inputEl(doc, String(draft.maxTokens || 8192), "number");
  const reasoningEffort = selectEl(doc, REASONING_EFFORT_OPTIONS);
  reasoningEffort.value =
    draft.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  reasoningEffort.disabled = draft.provider !== "openai";
  const reasoningSummary = selectEl(doc, REASONING_SUMMARY_OPTIONS);
  reasoningSummary.value =
    draft.extras?.reasoningSummary ?? DEFAULT_REASONING_SUMMARY;
  reasoningSummary.disabled = draft.provider !== "openai";
  const modelShortcuts = el(doc, "div", "preset-model-shortcuts");
  const shortcutLabel = el(
    doc,
    "b",
    "preset-model-shortcuts-label",
    "OpenAI 常用",
  );
  modelShortcuts.append(shortcutLabel);
  const setModels = (ids: string[]) => {
    const nextModels = ids.filter((id) => id.trim().length > 0);
    if (nextModels.length === 0) return;
    replaceModelChips(nextModels);
    current = { ...current, model: nextModels[0], models: nextModels };
    refreshModelShortcutState();
    syncDraft();
  };
  const toggleModel = (id: string) => {
    const currentModels = collectModelInputs()
      .map((input) => input.value.trim())
      .filter((value) => value.length > 0);
    const nextModels = currentModels.includes(id)
      ? currentModels.filter((model) => model !== id)
      : [...currentModels, id];
    setModels(nextModels.length ? nextModels : [id]);
  };
  const allModels = buttonEl(doc, "填入全部");
  allModels.title = "填入 Codex 常用的 OpenAI 模型列表";
  allModels.addEventListener("click", () => setModels(OPENAI_QUICK_MODELS));
  modelShortcuts.append(allModels);
  for (const id of OPENAI_QUICK_MODELS) {
    const pick = buttonEl(doc, id);
    pick.dataset.modelId = id;
    pick.title = `加入/移除 ${id}`;
    pick.addEventListener("click", () => toggleModel(id));
    modelShortcuts.append(pick);
  }
  refreshModelShortcutState();
  modelShortcuts.hidden = draft.provider !== "openai";
  const modelsControl = el(doc, "div", "preset-models-control");
  modelsControl.append(
    modelsField,
    modelShortcuts,
    el(
      doc,
      "div",
      "preset-help",
      "模型 ID 仍可手动编辑；保存时会自动测试连接并探测是否需要发送 Max tokens。",
    ),
  );

  const readDraft = (): ModelPreset => {
    const providerKind = provider.value as ProviderKind;
    const { model: activeModel, models } = readModelsField();
    return {
      id: current.id,
      provider: providerKind,
      label:
        label.value.trim() || (providerKind === "anthropic" ? "Claude" : "GPT"),
      apiKey: apiKey.value.trim(),
      baseUrl: baseUrl.value.trim() || DEFAULT_BASE_URLS[providerKind],
      model: activeModel,
      models,
      maxTokens: parseInt(maxTokens.value, 10) || 8192,
      extras:
        providerKind === "openai"
          ? {
              ...current.extras,
              reasoningEffort: reasoningEffort.value as ReasoningEffort,
              reasoningSummary: reasoningSummary.value as ReasoningSummary,
              agentPermissionMode: agentPermissionMode(current),
            }
          : {
              agentPermissionMode: agentPermissionMode(current),
            },
    };
  };

  let updateSaveState = () => undefined;
  const syncDraft = () => {
    const next = readDraft();
    current = next;
    upsertPreset(state, next);
    state.selectedId = next.id;
    updateToolbarOption(mount, next);
    updateSendControls(mount, state);
    refreshModelShortcutState();
    updateSaveState();
    return next;
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
    const inputs = collectModelInputs();
    const currentLines = inputs
      .map((input) => input.value.trim())
      .filter((value) => value.length > 0);
    const allDefaults =
      currentLines.length === 0 ||
      currentLines.every((line) =>
        Object.values(DEFAULT_MODELS).includes(line),
      );
    if (allDefaults) {
      // Replace existing chips with a single one carrying the new provider's default.
      Array.from(modelsField.querySelectorAll(".preset-models-chip")).forEach(
        (chip) => (chip as HTMLElement).remove(),
      );
      addModelChip(DEFAULT_MODELS[nextProvider] || "");
    }
    collectModelInputs().forEach((input) => {
      input.placeholder = placeholderFor(nextProvider);
    });
    reasoningEffort.disabled = nextProvider !== "openai";
    reasoningSummary.disabled = nextProvider !== "openai";
    modelShortcuts.hidden = nextProvider !== "openai";
    if (nextProvider === "openai" && !reasoningEffort.value) {
      reasoningEffort.value = DEFAULT_REASONING_EFFORT;
    }
    if (nextProvider === "openai" && !reasoningSummary.value) {
      reasoningSummary.value = DEFAULT_REASONING_SUMMARY;
    }
    syncDraft();
  });

  for (const control of [label, apiKey, baseUrl, maxTokens]) {
    control.addEventListener("input", syncDraft);
  }
  reasoningEffort.addEventListener("change", syncDraft);
  reasoningSummary.addEventListener("change", syncDraft);

  box.append(
    field(doc, "Provider", provider),
    field(doc, "名称", label),
    field(doc, "API Key", apiKey),
    field(doc, "Base URL", baseUrl),
    field(doc, "Models", modelsControl),
    field(doc, "Max tokens", maxTokens),
    field(doc, "Reasoning", reasoningEffort),
    field(doc, "Reasoning Summary", reasoningSummary),
  );

  const testStatus = el(doc, "div", "preset-test-status");
  testStatus.setAttribute("role", "status");
  const setTestStatus = (
    kind: "idle" | "running" | "ok" | "error",
    text: string,
  ) => {
    testStatus.className = `preset-test-status preset-test-${kind}`;
    testStatus.textContent = text;
  };
  const buttons = el(doc, "div", "add-buttons");
  const save = buttonEl(doc, "保存预设");
  let savedSignature = presetSignature(draft);
  const isDirty = () => presetSignature(readDraft()) !== savedSignature;
  updateSaveState = () => {
    save.disabled = !isDirty();
    save.title = save.disabled ? "当前配置没有未保存改动" : "";
  };

  save.addEventListener("click", () => {
    const preset = syncDraft();
    if (!isDirty()) {
      updateSaveState();
      return;
    }
    save.disabled = true;
    setTestStatus("running", "正在测试连接；通过后会自动保存...");
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const result = await testPresetConnectivity(preset, controller.signal);
        current = result.preset;
        upsertPreset(state, result.preset);
        persist(state);
        savedSignature = presetSignature(result.preset);
        updateToolbarOption(mount, result.preset);
        updateSendControls(mount, state);
        setTestStatus("ok", `${result.message}。已保存。`);
      } catch (err) {
        setTestStatus(
          "error",
          `${sanitizedTestError(err, preset.apiKey)}。未保存，请修正后重试。`,
        );
      } finally {
        clearTimeout(timeout);
        updateSaveState();
      }
    })();
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

  const remove = buttonEl(doc, "删除当前");
  remove.addEventListener("click", () => {
    state.presets = state.presets.filter((p) => p.id !== current.id);
    state.selectedId = state.presets[0]?.id ?? null;
    state.editing = state.presets.length === 0;
    persist(state);
    renderPanel(mount, state);
  });
  buttons.append(remove);
  updateSaveState();
  box.append(buttons, testStatus);
  return box;
}

function renderContextCard(doc: Document, itemID: number | null) {
  const item = safeGetItem(itemID);
  const title =
    item && typeof item.getField === "function"
      ? item.getField("title") || "未选择条目"
      : "未选择条目";
  const card = el(doc, "div", "ctx-card");
  card.append(
    el(doc, "div", "ctx-title", title),
    el(doc, "div", "ctx-meta", `Item ID: ${itemID ?? "none"}`),
  );
  return card;
}

function safeGetItem(itemID: number | null): { getField?: (field: string) => string } | null {
  if (itemID == null) return null;
  try {
    const item = Zotero.Items.get(itemID) as
      | { getField?: (field: string) => string }
      | false
      | null;
    return item || null;
  } catch (err) {
    debugZai("sidebar.item.get.failed", {
      itemID,
      error: errorMessage(err),
    });
    return null;
  }
}

function renderQuickPrompts(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
) {
  const promptSettings = loadQuickPromptSettings(zoteroPrefs());
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
      prompt: promptSettings.builtIns.summary,
      disabled: false,
    },
    {
      label: "🔖 全文重点",
      prompt: promptSettings.builtIns.fullTextHighlight,
      disabled: !!fullTextHighlightDisabled,
      disabledTitle: fullTextHighlightDisabled,
      fullTextHighlight: true,
    },
    {
      label: "解释选区",
      prompt: promptSettings.builtIns.explainSelection,
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
        taskTitle: label.replace(/^🔖\s*/, ""),
      });
    });
    box.append(button);
  }
  const customPrompts = promptSettings.customButtons.filter(
    (button) => button.label.trim() && button.prompt.trim(),
  );
  if (customPrompts.length) {
    box.append(el(doc, "span", "quick-prompts-break"));
    for (const custom of customPrompts) {
      const button = buttonEl(doc, custom.label);
      button.className = "quick-prompt-custom";
      button.disabled = state.sending;
      button.title = custom.shortcut
        ? `自定义提示词按钮；PDF 中按 ${custom.shortcut.toUpperCase()} 触发`
        : "自定义提示词按钮";
      button.addEventListener("click", () => {
        void sendMessage(mount, state, custom.prompt, {
          taskTitle: custom.label,
        });
      });
      box.append(button);
    }
  }
  box.append(renderTaskQueueTrigger(doc, mount, state));
  return box;
}

type ChatTaskStatus =
  | "queued"
  | "running"
  | "unread"
  | "read"
  | "failed"
  | "cancelled";

interface ChatTaskView {
  task: ChatTaskMeta;
  userIndex: number;
  assistantIndex: number;
  status: ChatTaskStatus;
}

function renderTaskQueueTrigger(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  // Single-task mode: the entire task-queue concept is irrelevant — there's
  // never more than one in-flight task and the composer's "停止" button
  // already covers cancellation. Returning an empty span keeps the parent
  // grid layout stable without leaving a dangling badge.
  if (!queueWhileSendingEnabled(state)) {
    return el(doc, "span", "task-queue-trigger-hidden");
  }
  const tasks = visibleChatTasks(state);
  const unread = tasks.filter((task) => task.status === "unread").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const button = buttonEl(doc, "");
  button.className = [
    "task-queue-trigger",
    unread ? "has-unread" : "",
    running || queued ? "has-running" : "",
  ]
    .filter(Boolean)
    .join(" ");
  button.title = tasks.length
    ? "查看任务队列和未读回答"
    : "暂无任务结果";
  button.append(
    doc.createTextNode(unread ? "未读 " : queued ? "排队 " : "队列 "),
    el(doc, "span", "task-queue-count", String(unread || queued || tasks.length)),
  );
  button.addEventListener("click", () => {
    state.queueOpen = !state.queueOpen;
    renderPanel(mount, state);
  });
  return button;
}

function renderTaskQueue(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const wrap = el(doc, "div", "task-queue-wrap");
  // Mirror the trigger: when single-task mode is active, the "已完成 / 查看"
  // unread strip and the popover have nothing to coordinate, so render
  // nothing. Keeps the composer chrome free of queue scaffolding when the
  // user has explicitly opted out of multi-task semantics.
  if (!queueWhileSendingEnabled(state)) return wrap;
  const tasks = visibleChatTasks(state);
  const latestUnread = tasks.find((task) => task.status === "unread");
  if (latestUnread && !state.queueOpen) {
    const strip = el(doc, "div", "task-completion-strip");
    strip.append(
      el(doc, "span", "task-status-dot task-unread-dot"),
      el(
        doc,
        "span",
        "task-completion-title",
        `${latestUnread.task.title} 已完成`,
      ),
    );
    if (latestUnread.task.pdfSelection) {
      strip.append(
        el(doc, "span", "task-locator-chip", taskLocatorLabel(latestUnread.task)),
      );
    }
    const view = buttonEl(doc, "查看");
    view.className = "task-link-button";
    view.addEventListener("click", () => viewChatTask(mount, state, latestUnread));
    strip.append(view);
    wrap.append(strip);
  }
  if (!state.queueOpen) return wrap;

  const popover = el(doc, "div", "task-queue-popover");
  const unread = tasks.filter((task) => task.status === "unread").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const head = el(doc, "div", "task-queue-head");
  const summary = queued
    ? `${unread} 未读 / ${queued} 排队 / ${tasks.length} 总计`
    : `${unread} 未读 / ${tasks.length} 总计`;
  head.append(
    el(doc, "strong", "", "任务队列"),
    el(doc, "span", "task-queue-summary", summary),
  );
  const actions = el(doc, "div", "task-queue-actions");
  const markRead = buttonEl(doc, "全部已读");
  markRead.disabled = unread === 0;
  markRead.addEventListener("click", () => {
    markAllChatTasksRead(state);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
  });
  // Cancel-only-pending: leaves the currently running task alone (the
  // composer's "停止" button is the right place for that), drops every
  // task that's still waiting its turn. Useful when the user submitted
  // several misfires while AI was busy and now wants to drain the
  // backlog without aborting the current reply.
  const cancelQueued = buttonEl(doc, "取消待办");
  cancelQueued.className = "cancel-queued-tasks";
  cancelQueued.disabled = queued === 0;
  cancelQueued.title = cancelQueued.disabled
    ? "没有正在排队等待执行的任务"
    : "把还没轮到的任务标为已取消，不影响当前正在回答的那一条";
  cancelQueued.addEventListener("click", () => {
    cancelQueuedChatTasks(state);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
  });
  const clear = buttonEl(doc, "清空队列");
  clear.className = "clear-task-queue";
  clear.disabled = unread > 0 || running > 0 || queued > 0 || tasks.length === 0;
  clear.title = clear.disabled
    ? "全部已读且没有回答中/排队中任务时才可清空"
    : "直接清空队列记录，不删除聊天内容";
  clear.addEventListener("click", () => {
    clearChatTaskQueue(state);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
  });
  const close = buttonEl(doc, "关闭");
  close.className = "close-task-queue";
  close.title = "关闭任务队列窗口";
  close.addEventListener("click", () => {
    state.queueOpen = false;
    renderPanel(mount, state);
  });
  actions.append(markRead, cancelQueued, clear, close);
  head.append(actions);
  popover.append(head);

  const list = el(doc, "div", "task-list");
  if (tasks.length === 0) {
    list.append(el(doc, "div", "task-empty", "暂无任务结果"));
  } else {
    for (const task of tasks) {
      list.append(renderTaskRow(doc, mount, state, task));
    }
  }
  popover.append(list);
  wrap.append(popover);
  return wrap;
}

function renderTaskRow(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  view: ChatTaskView,
): HTMLElement {
  const row = el(doc, "div", `task-row task-${view.status}`);
  row.append(el(doc, "span", "task-status-dot"));

  const main = el(doc, "div", "task-main");
  const top = el(doc, "div", "task-top");
  top.append(
    el(doc, "strong", "task-title", view.task.title),
    el(doc, "span", "task-age", taskStatusLabel(view)),
  );
  main.append(top, el(doc, "div", "task-preview", view.task.promptPreview));
  if (view.task.pdfSelection) {
    main.append(el(doc, "div", "task-locator-chip", taskLocatorLabel(view.task)));
  }
  row.append(main);

  const actions = el(doc, "div", "task-row-actions");
  if (view.status === "running" || view.status === "queued") {
    const cancel = buttonEl(doc, "取消");
    cancel.className = "task-cancel";
    cancel.disabled = state.cancellingTaskID === view.task.id;
    cancel.addEventListener("click", () => cancelChatTask(mount, state, view));
    actions.append(cancel);
  } else if (view.status === "cancelled") {
    const remove = buttonEl(doc, "移除");
    remove.addEventListener("click", () => {
      hideChatTask(state, view);
      renderPanel(mount, state);
    });
    actions.append(remove);
  } else {
    const label = view.status === "read" ? "再看" : "查看";
    const button = buttonEl(doc, label);
    button.addEventListener("click", () => viewChatTask(mount, state, view));
    actions.append(button);
  }
  row.append(actions);
  return row;
}

function visibleChatTasks(state: PanelState): ChatTaskView[] {
  const tasks: ChatTaskView[] = [];
  state.messages.forEach((message, index) => {
    if (message.role !== "user" || !message.task || message.task.hiddenAt)
      return;
    const assistantIndex = findNextAssistantIndex(state.messages, index);
    tasks.push({
      task: message.task,
      userIndex: index,
      assistantIndex,
      status: chatTaskStatus(state, message.task),
    });
  });
  return tasks.sort((a, b) => b.task.createdAt - a.task.createdAt);
}

function chatTaskStatus(
  state: PanelState,
  task: ChatTaskMeta,
): ChatTaskStatus {
  if (task.cancelledAt) return "cancelled";
  if (task.error) return "failed";
  if (state.sending && state.activeTaskID === task.id) return "running";
  if (!task.completedAt) return "queued";
  if (task.completedAt && !task.viewedAt) return "unread";
  return "read";
}

function findNextAssistantIndex(messages: Message[], userIndex: number): number {
  for (let index = userIndex + 1; index < messages.length; index++) {
    if (messages[index].role === "assistant") return index;
  }
  return -1;
}

function taskStatusLabel(view: ChatTaskView): string {
  if (view.status === "queued") return "排队中";
  if (view.status === "running") return "回答中";
  if (view.status === "cancelled") return "已取消";
  if (view.status === "failed") return "失败";
  if (view.status === "read") return "已读";
  return relativeTaskTime(view.task.completedAt ?? view.task.createdAt);
}

function relativeTaskTime(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时`;
}

function taskLocatorLabel(task: ChatTaskMeta): string {
  const locator = task.pdfSelection;
  if (!locator) return "";
  const label = locator.pageLabel ?? String((locator.pageIndex ?? 0) + 1);
  return `📍 PDF 第 ${label} 页 · 原选区`;
}

function markAllChatTasksRead(state: PanelState) {
  const now = Date.now();
  for (const message of state.messages) {
    if (message.role !== "user" || !message.task) continue;
    if (chatTaskStatus(state, message.task) === "unread") {
      message.task.viewedAt = now;
    }
  }
}

function clearChatTaskQueue(state: PanelState) {
  const now = Date.now();
  for (const message of state.messages) {
    if (message.role === "user" && message.task) {
      message.task.hiddenAt = now;
    }
  }
  state.queueOpen = false;
}

// Drops every still-waiting task; the running one (if any) is left alone
// so this works as "drain the backlog" without colliding with the
// composer's stop button. Pairs with the read-on-load tombstoning in
// loadPersistedMessages — same `cancelledAt` mechanism, same downstream
// rendering as "已取消".
function cancelQueuedChatTasks(state: PanelState) {
  const now = Date.now();
  for (const message of state.messages) {
    if (message.role !== "user" || !message.task) continue;
    if (chatTaskStatus(state, message.task) === "queued") {
      message.task.cancelledAt = now;
    }
  }
}

function hideChatTask(state: PanelState, view: ChatTaskView) {
  view.task.hiddenAt = Date.now();
  void saveChatMessages(state.itemID, state.messages);
  state.queueOpen = true;
}

function cancelChatTask(
  mount: HTMLElement,
  state: PanelState,
  view: ChatTaskView,
) {
  if (view.status === "queued") {
    markMessageTaskCancelled(state.messages[view.userIndex]);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
    void processNextQueuedChatTask(mount, state);
    return;
  }
  if (!(state.sending && state.activeTaskID === view.task.id)) return;
  view.task.cancelledAt = Date.now();
  view.task.completedAt ??= view.task.cancelledAt;
  state.cancellingTaskID = view.task.id;
  state.abort?.abort();
  void saveChatMessages(state.itemID, state.messages);
  renderPanel(mount, state);
}

function cancelActiveChatTask(mount: HTMLElement, state: PanelState) {
  const active = visibleChatTasks(state).find(
    (view) => view.task.id === state.activeTaskID,
  );
  if (active) {
    cancelChatTask(mount, state, active);
    return;
  }
  state.abort?.abort();
  renderPanel(mount, state);
}

function handleTaskEscape(
  mount: HTMLElement,
  state: PanelState,
  event: KeyboardEvent,
): boolean {
  if (
    event.defaultPrevented ||
    event.key !== "Escape" ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return false;
  }
  if (state.queueOpen) {
    state.queueOpen = false;
    renderPanel(mount, state);
  } else if (state.sending) {
    cancelActiveChatTask(mount, state);
  } else {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function viewChatTask(
  mount: HTMLElement,
  state: PanelState,
  view: ChatTaskView,
) {
  view.task.viewedAt = Date.now();
  state.queueOpen = false;
  void saveChatMessages(state.itemID, state.messages);
  renderPanel(mount, state);
  afterRender(mount, () => {
    jumpToTaskMessage(mount, view);
    if (view.task.pdfSelection) {
      void jumpToPdfSelection(mount, state, view.task.pdfSelection);
    }
  });
}

function jumpToTaskMessage(mount: HTMLElement, view: ChatTaskView) {
  const index = view.assistantIndex >= 0 ? view.assistantIndex : view.userIndex;
  const root = mount.querySelector(
    `[data-message-index="${index}"]`,
  ) as HTMLElement | null;
  if (!root) return;
  root.scrollIntoView({ block: "center", behavior: "smooth" });
  root.classList.add("bubble-task-jump");
  const win = mount.ownerDocument?.defaultView;
  win?.setTimeout(() => root.classList.remove("bubble-task-jump"), 1800);
}

async function jumpToPdfSelection(
  mount: HTMLElement,
  state: PanelState,
  locator: PdfSelectionLocator,
) {
  const win = mount.ownerDocument?.defaultView;
  const activeReader = getActiveReader(win);
  const activeConversationID = win ? activeReaderConversationItemID(win) : null;
  const reader =
    readerAttachmentID(activeReader) === locator.attachmentID ||
    activeConversationID === state.itemID
      ? activeReader
      : getActiveReaderForItem(win, state.itemID);
  if (!reader || typeof reader.navigate !== "function") {
    debugZai("task.pdf-selection.jump.unavailable", {
      attachmentID: locator.attachmentID,
      itemID: state.itemID,
      activeAttachmentID: readerAttachmentID(activeReader),
      activeConversationID,
    });
    return;
  }
  try {
    await reader.navigate({ position: locator.position });
    debugZai("task.pdf-selection.jump", {
      attachmentID: locator.attachmentID,
      pageIndex: locator.pageIndex,
      text: textDebugInfo(locator.selectedText, 120),
    });
  } catch (err) {
    debugZai("task.pdf-selection.jump.failed", {
      error: errorMessage(err),
      attachmentID: locator.attachmentID,
    });
  }
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
    const lockedScroll = activeMessagesScrollLock(state);
    if (lockedScroll) {
      scheduleMessagesScrollRestore(mount, lockedScroll);
      return;
    }
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
  const queueAllowed = queueWhileSendingEnabled(state);
  const canSubmit =
    !!preset?.apiKey && !!preset.model && (!state.sending || queueAllowed);
  input.placeholder = preset
    ? state.sending
      ? queueAllowed
        ? "AI 回答中…当前回复结束后将按顺序执行队列里的消息"
        : "AI 回答中…等待结束后再发送（设置可开启发送中排队）"
      : "问点什么... (Enter 发送，Shift+Enter 换行)"
    : "先添加一个模型预设。";
  input.disabled = !preset;
  input.value = state.draftText;
  input.style.height = "auto";
  const slashMenu = el(doc, "div", "slash-command-menu");
  slashMenu.style.display = "none";

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    const slashTarget = activeSlashCommandTarget(input);
    const slashMatches = slashTarget
      ? matchingSlashCommands(slashTarget.token)
      : [];
    if (
      slashTarget &&
      slashMatches.length > 0 &&
      (event.key === "Enter" || event.key === "Tab")
    ) {
      event.preventDefault();
      applySlashCommand(input, state, slashTarget, slashMatches[0]);
      updateStatus();
      return;
    }
    if (slashTarget && event.key === "Escape") {
      slashMenu.style.display = "none";
      event.preventDefault();
      return;
    }
    // Default: blocked while sending. Enable the "queue while sending"
    // toggle (UiSettings.composerQueueWhileSending) to allow Enter to
    // register new messages onto the queue. The actual queue handling is
    // sequential: streamAssistant sets state.sending = true for the duration
    // of one task, processNextQueuedChatTask only iterates once it returns
    // to false, so messages run strictly one-at-a-time after the current
    // task completes.
    const shouldSend =
      (!state.sending || queueWhileSendingEnabled(state)) &&
      event.key === "Enter" &&
      !event.isComposing &&
      (!event.shiftKey || event.ctrlKey || event.metaKey);
    if (shouldSend) {
      event.preventDefault();
      void sendMessage(mount, state, composerMessageContent(input.value, state), {
        fromComposer: true,
      });
    }
  });

  const updateStatus = (captureFocus = true) => {
    captureDraftFromInput(input, state, captureFocus);
    autoResizeInput(input);
    renderInputStatus(status, input, state);
    renderSlashCommandMenu(slashMenu, input, state);
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
  inputStack.append(renderDraftImages(doc, mount, state, input), slashMenu, input);
  row.append(inputStack, renderWebSearchSwitcher(doc, mount, state));
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

  const send = buttonEl(doc, state.sending ? "↑ 排队" : "↑");
  send.className = state.sending ? "send-btn send-queue-btn" : "send-btn";
  send.disabled = !canSubmit;
  send.title = preset
    ? !preset.apiKey || !preset.model
      ? "请先填写 API Key 和 Model ID"
      : state.sending
        ? "加入队列：当前回复结束后按顺序执行"
        : "发送"
    : "发送";
  send.setAttribute("aria-label", state.sending ? "加入队列" : "发送");
  send.addEventListener(
    "click",
    () =>
      void sendMessage(
        mount,
        state,
        composerMessageContent(input.value, state),
        { fromComposer: true },
      ),
  );
  row.append(send);
  if (state.sending) {
    const stop = buttonEl(doc, "停止");
    stop.className = "stop-btn";
    stop.addEventListener("click", () => {
      cancelActiveChatTask(mount, state);
    });
    row.append(stop);
  }
  row.append(renderSelectionBadge(doc, mount, state));
  composer.append(
    renderQuickPrompts(doc, mount, state),
    renderTaskQueue(doc, mount, state),
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

function composerMessageContent(raw: string, state: PanelState): string {
  return expandSlashCommandMessage(expandPasteMarkers(raw, state));
}

function queueWhileSendingEnabled(state: PanelState): boolean {
  return state.uiSettings.composerQueueWhileSending === true;
}

interface SlashCommandTarget {
  start: number;
  end: number;
  token: string;
}

function activeSlashCommandTarget(
  input: HTMLTextAreaElement,
): SlashCommandTarget | null {
  const start = input.selectionStart ?? input.value.length;
  const selectionEnd = input.selectionEnd ?? start;
  if (start !== selectionEnd) return null;
  const beforeCursor = input.value.slice(0, start);
  const lineStart = beforeCursor.lastIndexOf("\n") + 1;
  const linePrefix = beforeCursor.slice(lineStart);
  if (!linePrefix.startsWith("/") || /\s/.test(linePrefix)) return null;
  const afterToken = input.value.slice(start).match(/^[^\s]*/)?.[0] ?? "";
  const end = start + afterToken.length;
  return {
    start: lineStart,
    end,
    token: input.value.slice(lineStart, end),
  };
}

function renderSlashCommandMenu(
  menu: HTMLElement,
  input: HTMLTextAreaElement,
  state: PanelState,
) {
  const target = activeSlashCommandTarget(input);
  const matches = target ? matchingSlashCommands(target.token) : [];
  if (matches.length === 0) {
    menu.style.display = "none";
    menu.replaceChildren();
    return;
  }

  const doc = input.ownerDocument!;
  menu.replaceChildren();
  matches.forEach((command, index) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "slash-command-item";
    if (index === 0) button.classList.add("slash-command-item-selected");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const latest = activeSlashCommandTarget(input);
      if (!latest) return;
      applySlashCommand(input, state, latest, command);
      captureDraftFromInput(input, state);
      renderSlashCommandMenu(menu, input, state);
      input.focus();
    });
    button.append(
      el(doc, "span", "slash-command-name", command.name),
      el(doc, "span", "slash-command-usage", command.usage),
      el(doc, "span", "slash-command-desc", slashCommandDescription(command)),
    );
    menu.append(button);
  });
  menu.style.display = "";
}

function applySlashCommand(
  input: HTMLTextAreaElement,
  state: PanelState,
  target: SlashCommandTarget,
  command: SlashCommand,
) {
  const before = input.value.slice(0, target.start);
  const after = input.value.slice(target.end);
  const insertion = `${command.name} `;
  input.value = `${before}${insertion}${after}`;
  const cursor = before.length + insertion.length;
  input.selectionStart = cursor;
  input.selectionEnd = cursor;
  captureDraftFromInput(input, state);
  autoResizeInput(input);
}

function slashCommandDescription(command: SlashCommand): string {
  const settings = loadToolSettings(zoteroPrefs());
  if (command.name === "/arxiv-search") {
    return `${command.description} 内置 arXiv 工具已可用；模型自行判断是否调用。`;
  }
  if (command.name === "/web-search" && settings.webSearchMode === "disabled") {
    return `${command.description} 可先点击输入框左下角“联网”启用。`;
  }
  return command.description;
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
  const left = el(doc, "div", "composer-footer-left");
  const actions = el(doc, "div", "composer-footer-actions");
  left.append(status);
  actions.append(
    screenshotAttach,
    imageAttach,
    renderModelSwitcher(doc, mount, state),
    renderReasoningSwitcher(doc, mount, state),
    renderYoloToggle(doc, mount, state),
  );
  footer.append(left, actions);
  return footer;
}

function renderWebSearchSwitcher(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const settings = loadToolSettings(zoteroPrefs());
  const preset = selectedChatPreset(state);
  const enabledForPreset = preset?.provider === "openai";
  const mode = settings.webSearchMode;
  const enabled = mode !== "disabled";
  const wrap = el(doc, "div", `web-search-switcher web-search-${mode}`);
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "web-search-trigger";
  trigger.textContent = enabled ? "🌐 联网" : "＋ 联网";
  trigger.title = enabledForPreset
    ? webSearchToggleTitle(mode)
    : "联网工具目前仅对 OpenAI Responses 兼容配置生效";
  trigger.disabled = !enabledForPreset || state.sending;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const popup = el(doc, "div", "web-search-popup");
  popup.setAttribute("role", "menu");
  popup.style.display = "none";

  const closePopup = () => {
    if (popup.style.display === "none") return;
    popup.style.display = "none";
    trigger.setAttribute("aria-expanded", "false");
    doc.removeEventListener("mousedown", outsideHandler, true);
    doc.removeEventListener("keydown", escapeHandler, true);
  };
  const openPopup = () => {
    if (popup.style.display !== "none") return;
    popup.style.display = "";
    trigger.setAttribute("aria-expanded", "true");
    doc.addEventListener("mousedown", outsideHandler, true);
    doc.addEventListener("keydown", escapeHandler, true);
  };
  const outsideHandler = (event: Event) => {
    if (!wrap.contains(event.target as Node)) closePopup();
  };
  const escapeHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closePopup();
      trigger.focus();
    }
  };

  const item = doc.createElement("button");
  item.type = "button";
  item.className = enabled
    ? "web-search-item web-search-item-active"
    : "web-search-item";
  item.setAttribute("role", "menuitemcheckbox");
  item.setAttribute("aria-checked", enabled ? "true" : "false");
  item.addEventListener("click", () => {
    closePopup();
    saveToolSettings(zoteroPrefs(), {
      ...settings,
      webSearchMode: enabled ? "disabled" : "live",
    });
    renderPanel(mount, state);
  });
  item.append(
    el(doc, "span", "web-search-item-icon", enabled ? "🌐" : "＋"),
    el(doc, "span", "web-search-item-main", "联网"),
    el(doc, "span", "web-search-item-check", enabled ? "✓" : ""),
    el(
      doc,
      "span",
      "web-search-item-detail",
      enabled ? "已开启；模式在设置中修改" : "点击开启；模式在设置中修改",
    ),
  );
  popup.append(item);

  trigger.addEventListener("click", () => {
    if (popup.style.display === "none") openPopup();
    else closePopup();
  });

  wrap.append(trigger, popup);
  return wrap;
}

function webSearchToggleTitle(mode: WebSearchMode): string {
  switch (mode) {
    case "cached":
      return "联网已开启：Cached；点击可关闭";
    case "live":
      return "联网已开启：Live；点击可关闭";
    default:
      return "联网已关闭；点击可开启";
  }
}

// Composer-footer model switcher (Claudian-style).
// - 0 models in current preset → render nothing.
// - 1 model               → static label (user still sees WHICH model is in use).
// - 2+ models             → trigger button + upward popup. Click opens, picks
//                            mutate `preset.model` via upsertPreset + persist
//                            (so the choice is sticky across sessions). Outside
//                            click and Escape close the popup.
// REF: Claudian's footer model dropdown — same pattern.
function renderModelSwitcher(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const preset = selectedChatPreset(state) ?? selectedPreset(state);
  const models = preset?.models ?? [];
  const wrap = el(doc, "div", "model-switcher");
  if (!preset || models.length === 0) {
    wrap.style.display = "none";
    return wrap;
  }
  const active =
    preset.model && models.includes(preset.model) ? preset.model : models[0];
  if (models.length === 1) {
    wrap.classList.add("model-switcher-static");
    wrap.title = `当前模型：${active}`;
    wrap.append(el(doc, "span", "model-switcher-label", active));
    return wrap;
  }

  const trigger = doc.createElement("button") as HTMLButtonElement;
  trigger.type = "button";
  trigger.className = "model-switcher-trigger";
  trigger.textContent = active;
  trigger.title = "切换当前预设的模型";
  trigger.disabled = state.sending;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const popup = el(doc, "div", "model-switcher-popup");
  popup.setAttribute("role", "menu");
  popup.style.display = "none";

  const closePopup = () => {
    if (popup.style.display === "none") return;
    popup.style.display = "none";
    trigger.setAttribute("aria-expanded", "false");
    doc.removeEventListener("mousedown", outsideHandler, true);
    doc.removeEventListener("keydown", escapeHandler, true);
  };
  const openPopup = () => {
    if (popup.style.display !== "none") return;
    popup.style.display = "";
    trigger.setAttribute("aria-expanded", "true");
    doc.addEventListener("mousedown", outsideHandler, true);
    doc.addEventListener("keydown", escapeHandler, true);
  };
  const outsideHandler = (event: Event) => {
    if (!wrap.contains(event.target as Node)) closePopup();
  };
  const escapeHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closePopup();
      trigger.focus();
    }
  };

  for (const id of models) {
    const item = doc.createElement("button") as HTMLButtonElement;
    item.type = "button";
    item.className = "model-switcher-item";
    if (id === active) item.classList.add("model-switcher-item-active");
    item.textContent = id;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      closePopup();
      if (id === preset.model) return;
      upsertPreset(state, { ...preset, model: id });
      persist(state);
      updateToolbarOption(mount, { ...preset, model: id });
      renderPanel(mount, state);
    });
    popup.append(item);
  }

  trigger.addEventListener("click", () => {
    if (popup.style.display === "none") openPopup();
    else closePopup();
  });

  wrap.append(trigger, popup);
  return wrap;
}

function renderReasoningSwitcher(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const preset = selectedChatPreset(state) ?? selectedPreset(state);
  const wrap = el(doc, "div", "reasoning-switcher");
  if (!preset || preset.provider !== "openai") {
    wrap.style.display = "none";
    return wrap;
  }

  const active = preset.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const trigger = doc.createElement("button") as HTMLButtonElement;
  trigger.type = "button";
  trigger.className = "reasoning-switcher-trigger";
  trigger.textContent = reasoningEffortShortLabel(active);
  trigger.title = `推理等级：${reasoningEffortLabel(active)}`;
  trigger.disabled = state.sending;
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");

  const popup = el(doc, "div", "reasoning-switcher-popup");
  popup.setAttribute("role", "menu");
  popup.style.display = "none";

  const closePopup = () => {
    if (popup.style.display === "none") return;
    popup.style.display = "none";
    trigger.setAttribute("aria-expanded", "false");
    doc.removeEventListener("mousedown", outsideHandler, true);
    doc.removeEventListener("keydown", escapeHandler, true);
  };
  const openPopup = () => {
    if (popup.style.display !== "none") return;
    popup.style.display = "";
    trigger.setAttribute("aria-expanded", "true");
    doc.addEventListener("mousedown", outsideHandler, true);
    doc.addEventListener("keydown", escapeHandler, true);
  };
  const outsideHandler = (event: Event) => {
    if (!wrap.contains(event.target as Node)) closePopup();
  };
  const escapeHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closePopup();
      trigger.focus();
    }
  };

  for (const [value, label] of REASONING_EFFORT_OPTIONS) {
    const item = doc.createElement("button") as HTMLButtonElement;
    item.type = "button";
    item.className = "reasoning-switcher-item";
    if (value === active) item.classList.add("reasoning-switcher-item-active");
    item.textContent = label;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", value === active ? "true" : "false");
    item.addEventListener("click", () => {
      closePopup();
      if (value === preset.extras?.reasoningEffort) return;
      const next = withReasoningEffort(preset, value);
      upsertPreset(state, next);
      persist(state);
      renderPanel(mount, state);
    });
    popup.append(item);
  }

  trigger.addEventListener("click", () => {
    if (popup.style.display === "none") openPopup();
    else closePopup();
  });

  wrap.append(trigger, popup);
  return wrap;
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

function renderCopyDebugToggle(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const label = el(doc, "label", "copy-debug-toggle yolo-toggle");
  const input = doc.createElement("input");
  input.type = "checkbox";
  input.checked = state.copyDebugContext;
  input.addEventListener("change", () => {
    state.copyDebugContext = input.checked;
    renderPanel(mount, state);
  });
  label.append(
    el(doc, "span", "yolo-toggle-text", "调试"),
    input,
    el(doc, "span", "yolo-toggle-track"),
  );
  label.title = state.copyDebugContext
    ? "调试复制：包含工具上下文、PDF 片段和思考过程；关闭后只复制论文介绍和对话"
    : "纯净复制：只复制论文介绍和对话；开启后包含工具上下文、PDF 片段和思考过程";
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
  fromComposer?: boolean;
  taskTitle?: string;
}

// User-message → wire-message pipeline.
// Responsibilities (in order, each one matters):
//   1. Trim & filter draft images (only images whose marker survives in
//      the final text are sent — the user can delete a marker mid-edit).
//   2. Skip if not configured: open the preset editor instead of erroring.
//   3. Capture the SELECTED PDF TEXT exactly once at send time. WHY: the
//      user may type their question after selecting; locking selection
//      here makes the wire content match what the chip showed.
//   4. Snapshot the annotation draft for selection-annotation flows BEFORE
//      we append user message — `attachAnnotationDraft` will use the
//      snapshot regardless of how selection state evolves during streaming.
//   5. Reset draft state (text/images/scroll-anchor) to fresh defaults.
//   6. Persist BEFORE streaming so the user message is durable even if the
//      provider request errors out.
async function sendMessage(
  mount: HTMLElement,
  state: PanelState,
  text: string,
  options: SendMessageOptions = {},
) {
  const baseContent = text.trim();
  const preset = selectedChatPreset(state);
  const images = state.draftImages
    .filter((image) => text.includes(image.marker))
    .map((image) => ({ ...image }));
  if ((!baseContent && images.length === 0) || !preset) return;
  await ensureHistoryLoaded(mount, state);
  if (states.get(mount) !== state) return;
  if (!preset.apiKey || !preset.model) {
    openAddonPreferences(mount.ownerDocument!);
    return;
  }

  const rawSelectedText = options.fullTextHighlight
    ? ""
    : await getSelectedTextForPrompt(mount, state.itemID);
  const selectionPayload = await buildSelectionPromptContext(
    rawSelectedText,
    state.itemID,
  );
  const selectedText = selectionPayload.selectedText;
  const quickPromptSettings = loadQuickPromptSettings(zoteroPrefs());
  const selectedSnapshot = cloneSelectionAnnotationDraft(
    getStoredSelectionAnnotation(state.itemID),
  );
  if (selectedSnapshot && selectedText) selectedSnapshot.text = selectedText;
  const selectionQuestionAnnotationEnabled =
    !options.explainSelection &&
    options.fromComposer === true &&
    !!selectedText &&
    !!selectedSnapshot &&
    quickPromptSettings.selectionQuestionAnnotationEnabled;
  const selectionContext = selectedText ? selectionPayload.context : {};
  const annotationColorGuide = selectionQuestionAnnotationEnabled
    ? loadToolSettings(zoteroPrefs()).annotationColorGuide.trim()
    : "";
  const snapshot =
    options.explainSelection || selectionQuestionAnnotationEnabled
      ? selectedSnapshot
      : null;
  const userMessage: Message = {
    role: "user",
    content: baseContent,
    task: createChatTaskMeta(
      baseContent,
      options,
      selectedText,
      selectedSnapshot,
    ),
    ...(images.length ? { images } : {}),
    ...(selectedText
      ? {
          context: {
            selectedText,
            explainSelection: options.explainSelection,
            ...((options.explainSelection ||
              selectionQuestionAnnotationEnabled) && {
              annotationSuggestion: true,
            }),
            ...(annotationColorGuide ? { annotationColorGuide } : {}),
            // Capture the snapshot + color flag onto the message itself so
            // the queue processor can recover them later. Without this,
            // queued tasks would lose their anchor to the original PDF
            // selection (and the matching color-guide flag).
            ...(snapshot
              ? {
                  queuedAnnotationSnapshot: {
                    text: snapshot.text,
                    attachmentID: snapshot.attachmentID,
                    annotation: detachAnnotationSnapshot(snapshot.annotation),
                  },
                  queuedAnnotationColorEnabled:
                    selectionQuestionAnnotationEnabled,
                }
              : {}),
            ...selectionContext,
          },
        }
      : {}),
  };
  const shouldQueue = state.sending;
  const history = shouldQueue ? [] : state.messages.slice();
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
  if (shouldQueue) {
    state.queueOpen = true;
    renderPanel(mount, state);
    return;
  }
  await streamAssistant(mount, state, history, userMessage, {
    annotationSnapshot: snapshot,
    annotationColorEnabled: selectionQuestionAnnotationEnabled,
    fullTextHighlight: options.fullTextHighlight,
    taskID: userMessage.task?.id,
  });
  void processNextQueuedChatTask(mount, state);
}

async function processNextQueuedChatTask(
  mount: HTMLElement,
  state: PanelState,
): Promise<void> {
  if (state.processingQueuedTask) return;
  state.processingQueuedTask = true;
  try {
    while (states.get(mount) === state && !state.sending) {
      const next = firstQueuedChatTask(state);
      if (!next) break;
      const userMessage = state.messages[next.userIndex];
      if (!userMessage || userMessage.role !== "user") break;
      const history = state.messages.slice(0, next.userIndex);
      // Restore whatever annotation context was captured at queue time.
      // INVARIANT: a queued message always uses the PDF selection that was
      // active when it was submitted, NEVER the live selection now —
      // otherwise users would see "建议注释" cards aimed at whatever's
      // currently highlighted in the Reader, which is rarely what they
      // typed against minutes ago.
      const queuedSnapshot = userMessage.context?.queuedAnnotationSnapshot;
      await streamAssistant(mount, state, history, userMessage, {
        annotationSnapshot: queuedSnapshot
          ? {
              text: queuedSnapshot.text,
              attachmentID: queuedSnapshot.attachmentID,
              annotation: detachAnnotationSnapshot(queuedSnapshot.annotation),
            }
          : null,
        annotationColorEnabled:
          userMessage.context?.queuedAnnotationColorEnabled === true,
        fullTextHighlight: userMessage.task?.kind === "full_text",
        taskID: userMessage.task?.id,
      });
    }
  } finally {
    state.processingQueuedTask = false;
  }
}

function firstQueuedChatTask(state: PanelState): ChatTaskView | null {
  for (const view of visibleChatTasks(state)
    .slice()
    .sort((a, b) => a.task.createdAt - b.task.createdAt)) {
    if (view.status === "queued") return view;
  }
  return null;
}

async function buildSelectionPromptContext(
  selectedText: string,
  itemID: number | null,
): Promise<{
  selectedText: string;
  context: Partial<NonNullable<Message["context"]>>;
}> {
  if (!selectedText || itemID == null) {
    return { selectedText, context: {} };
  }

  try {
    const pdfText = await zoteroContextSource.getFullText(itemID);
    if (!pdfText) return { selectedText, context: {} };
    return {
      selectedText,
      context: buildSelectionNearbyContextFromPdfText(selectedText, pdfText),
    };
  } catch (err) {
    debugZai("selection.context.failed", {
      error: errorMessage(err),
      raw: textDebugInfo(selectedText, 120),
    });
    return { selectedText, context: {} };
  }
}

function buildSelectionNearbyContextFromPdfText(
  selectedText: string,
  pdfText: string,
): Partial<NonNullable<Message["context"]>> {
  const query = selectionContextQuery(selectedText);
  if (!query) return {};
  const matches = searchPdfPassages(
    pdfText,
    query,
    contextPolicy.searchCandidateCount,
    contextPolicy,
  );
  const best = matches[0];
  if (!best) return {};

  const range = extractPdfRange(
    pdfText,
    Math.max(0, best.start - SELECTION_CONTEXT_RADIUS_CHARS),
    best.end + SELECTION_CONTEXT_RADIUS_CHARS,
    contextPolicy,
  );
  if (!range) return {};

  return {
    query,
    candidatePassageCount: matches.length,
    selectedPassageNumbers: [1],
    passageSelectorSource: "fallback",
    passageSelectionReason:
      "当前 PDF 选区自动检索原文位置，并附带命中位置附近上下文",
    retrievedPassages: [range],
  };
}

function selectionContextQuery(selectedText: string): string {
  return selectedText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SELECTION_CONTEXT_QUERY_CHARS);
}

function cloneSelectionAnnotationDraft(
  draft: SelectionAnnotationDraft | null,
): SelectionAnnotationDraft | null {
  if (!draft) return null;
  return {
    text: draft.text,
    attachmentID: draft.attachmentID,
    annotation: detachAnnotationSnapshot(draft.annotation),
  };
}

// Detaches a Reader-event annotation payload from the iframe compartment it
// was emitted in. WHY: Zotero Reader emits `annotation` objects whose nested
// `position` (and `position.rects`) are iframe-scope references. If we keep
// just `{ ...annotation }` in our cache, those nested refs survive the
// initial save but become inaccessible after the iframe re-renders or its
// next save cycle — subsequent reads then throw "Permission denied to pass
// object to privileged code", which is what produced the "first save works,
// second save fails" pattern. JSON round-tripping at capture time copies the
// data into the addon compartment as plain values, immune to whatever the
// Reader iframe does later. The try/catch is a safety net for the rare case
// where the source object is already partially detached at capture time.
function detachAnnotationSnapshot(
  annotation: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(annotation));
  } catch {
    return { ...annotation };
  }
}

function createChatTaskMeta(
  content: string,
  options: SendMessageOptions,
  selectedText: string,
  selectedSnapshot: SelectionAnnotationDraft | null,
): ChatTaskMeta {
  const pdfSelection =
    selectedText && selectedSnapshot
      ? pdfSelectionLocatorFromDraft(selectedSnapshot, selectedText)
      : null;
  return {
    id: makeTaskID(),
    kind: pdfSelection
      ? "selection"
      : options.fullTextHighlight
        ? "full_text"
        : "general",
    title:
      options.taskTitle ||
      (pdfSelection ? "选中文字提问" : contentPreview(content, 14) || "提问"),
    promptPreview: contentPreview(selectedText || content, 90),
    createdAt: Date.now(),
    ...(pdfSelection ? { pdfSelection } : {}),
  };
}

function pdfSelectionLocatorFromDraft(
  draft: SelectionAnnotationDraft,
  selectedText: string,
): PdfSelectionLocator | null {
  const position = clonePlainRecord(draft.annotation.position);
  if (!position) return null;
  const pageIndex =
    typeof position.pageIndex === "number" && Number.isFinite(position.pageIndex)
      ? Math.floor(position.pageIndex)
      : undefined;
  return {
    attachmentID: draft.attachmentID,
    selectedText,
    ...(pageIndex != null
      ? { pageIndex, pageLabel: String(pageIndex + 1) }
      : {}),
    position,
  };
}

function clonePlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return cloned && typeof cloned === "object" && !Array.isArray(cloned)
      ? (cloned as Record<string, unknown>)
      : null;
  } catch {
    return { ...(value as Record<string, unknown>) };
  }
}

function makeTaskID(): string {
  return `task-${Date.now()}-${Zotero.Utilities.randomString(6)}`;
}

function contentPreview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}…`
    : normalized;
}

interface StreamAssistantOptions {
  annotationSnapshot?: SelectionAnnotationDraft | null;
  annotationColorEnabled?: boolean;
  fullTextHighlight?: boolean;
  taskID?: string;
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
  const userIndex = state.messages.indexOf(userMessage);
  const assistantIndex =
    userIndex >= 0 ? userIndex + 1 : state.messages.length;
  const assistant: Message = { role: "assistant", content: "" };
  state.messages.splice(assistantIndex, 0, assistant);
  state.activeAssistantIndex = assistantIndex;
  state.activeAssistantStage = "building_context";
  state.activeTaskID = options.taskID;
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
      const hasNearbyContext = !!userMessage.context.retrievedPassages?.length;
      userMessage.context = {
        ...userMessage.context,
        planMode: "selected_text",
        plannerSource: "selected",
        planReason: hasNearbyContext
          ? "用户当前选中了 PDF 文本，并已自动附带命中位置附近上下文"
          : "用户当前选中了 PDF 文本，直接作为显式上下文发送",
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
      previousMessages: history,
      selectionAnnotation: () => getStoredSelectionAnnotation(state.itemID),
      fullTextHighlight: options.fullTextHighlight,
      getActiveReader: () =>
        getReaderForCurrentSelection(mount.ownerDocument!.defaultView, state.itemID),
      // Curry the live document and itemID so the model writes to whatever
      // is selected at call time (not at session-creation time). Refresh
      // the visible note panel after the write so the user sees the
      // append immediately, matching the manual button's UX.
      appendToChildNote: async (content) => {
        const result = await appendAssistantContentToItemNote(
          mount.ownerDocument!,
          state.itemID,
          content,
        );
        refreshVisibleNoteWindow(mount.ownerDocument!, result.noteID);
        return result;
      },
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
        toolSettings: loadToolSettings(zoteroPrefs()),
      },
    )) {
      if (chunk.type === "text_delta") {
        state.activeAssistantStage = "writing";
        state.activeAssistantDetail = undefined;
        assistant.content += chunk.text;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === "thinking_delta") {
        state.activeAssistantStage = "thinking";
        state.activeAssistantDetail = undefined;
        assistant.thinking = `${assistant.thinking ?? ""}${chunk.text}`;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === "tool_call") {
        state.activeAssistantStage =
          chunk.status === "started" ? "using_tool" : "waiting_model";
        state.activeAssistantDetail = undefined;
        recordToolCall(userMessage, chunk);
        void saveChatMessages(state.itemID, state.messages);
        state.scrollToBottom = state.autoFollowMessages;
        renderPanel(mount, state);
      } else if (chunk.type === "status") {
        state.activeAssistantStage = "waiting_model";
        state.activeAssistantDetail = chunk.message;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === "error") {
        state.activeAssistantDetail = undefined;
        markMessageTaskError(userMessage, chunk.message);
        assistant.content += `\n[Error] ${chunk.message}`;
        updateMessageBubble(mount, assistantIndex, assistant);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbortError(err) || controller.signal.aborted) {
      if (!assistant.content.trim()) {
        assistant.content = "已取消本次回答。";
      }
      markMessageTaskCancelled(userMessage);
    } else {
      markMessageTaskError(userMessage, message);
      assistant.content += `\n[Error] ${message}`;
    }
    updateMessageBubble(mount, assistantIndex, assistant);
  } finally {
    toolSession?.dispose();
    markMessageTaskCompleted(userMessage);
    if (options.annotationSnapshot) {
      attachAnnotationDraft(
        assistant,
        options.annotationSnapshot,
        !!options.annotationColorEnabled,
      );
    }
    state.sending = false;
    state.abort = undefined;
    state.activeAssistantIndex = undefined;
    state.activeAssistantStage = undefined;
    state.activeAssistantDetail = undefined;
    state.activeTaskID = undefined;
    state.cancellingTaskID = undefined;
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
  colorEnabled: boolean,
) {
  const parsed = parseAnnotationSuggestion(assistant.content);
  if (!parsed.comment) return;
  const color = colorEnabled ? allowedAnnotationColor(parsed.color) : null;
  assistant.content = parsed.body;
  assistant.annotationDraft = {
    comment: parsed.comment,
    ...(color ? { color } : {}),
    snapshot: {
      text: snapshot.text,
      attachmentID: snapshot.attachmentID,
      annotation: detachAnnotationSnapshot(snapshot.annotation),
    },
    state: { kind: "idle" },
  };
}

function markMessageTaskCompleted(message: Message) {
  if (!message.task || message.task.completedAt) return;
  message.task.completedAt = Date.now();
}

function markMessageTaskCancelled(message: Message) {
  if (!message.task) return;
  const now = Date.now();
  message.task.cancelledAt ??= now;
  message.task.completedAt ??= now;
}

function markMessageTaskError(message: Message, error: string) {
  if (!message.task) return;
  message.task.error = error;
  message.task.completedAt ??= Date.now();
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && /abort/i.test(err.name)) ||
    (err instanceof Error && /abort/i.test(err.message))
  );
}

function allowedAnnotationColor(color: string | null): string | null {
  if (!color) return null;
  const allowed = configuredAnnotationColors();
  return allowed.has(color.toLowerCase()) ? color.toLowerCase() : null;
}

function configuredAnnotationColors(): Set<string> {
  const guide = loadToolSettings(zoteroPrefs()).annotationColorGuide;
  return new Set(
    (guide.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((hex) =>
      hex.toLowerCase(),
    ),
  );
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
  const toolManual = toolManualWithConfiguredGuides();
  return `${systemPrompt}\n\n${toolManual}\n\nThe ledger below records previous context metadata that may no longer be visible. Use it as a planning map for tool choice, including source identity, ranges, and whether prior snippets can be reloaded with chat_get_previous_context. Do not treat the ledger itself as source text. The model decides whether to answer from current conversation, reload prior chat context, call targeted tools, or fetch fresh text.\n\nPreviously sent context ledger (not currently attached):\n${contextLedger}`;
}

function toolManualWithConfiguredGuides(): string {
  const guide = loadToolSettings(zoteroPrefs()).annotationColorGuide.trim();
  if (!guide) return ZOTERO_TOOL_MANUAL;
  return `${ZOTERO_TOOL_MANUAL}\n\nConfigured PDF annotation color presets:\n${guide}`;
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
  if (!replaced && chunk.status === "started") {
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
    ...mergeToolContext(message.context, chunk.context),
    toolCalls: nextTools,
  };
}

function mergeToolContext(
  previous: Message["context"],
  next: Message["context"],
): Message["context"] {
  if (!next) return previous;
  const merged = {
    ...previous,
    ...next,
  };
  if (previous?.retrievedPassages?.length || next.retrievedPassages?.length) {
    const passages = [
      ...(previous?.retrievedPassages ?? []),
      ...(next.retrievedPassages ?? []),
    ];
    const seen = new Set<string>();
    merged.retrievedPassages = passages.filter((passage) => {
      const key = `${passage.start}:${passage.end}:${passage.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return merged;
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
  resetChatTaskForRetry(userMessage);
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
    taskID: userMessage.task?.id,
  });
}

function resetChatTaskForRetry(message: Message) {
  if (!message.task) return;
  message.task.createdAt = Date.now();
  delete message.task.completedAt;
  delete message.task.viewedAt;
  delete message.task.hiddenAt;
  delete message.task.cancelledAt;
  delete message.task.error;
}

async function loadPersistedMessages(mount: HTMLElement, state: PanelState) {
  if (state.historyLoaded) return;
  const messages = await loadChatMessages(state.itemID);
  if (states.get(mount) !== state || state.sending) return;
  // Tombstone any task that was running/queued when Zotero last closed.
  // Without this, a `task` lacking both `completedAt` and `cancelledAt`
  // looks "queued" forever and `processNextQueuedChatTask` never picks it
  // up (no sendMessage triggers it on cold start) — UI would show "排队
  // 中" badges for ghosts. Marking them cancelled is the conservative
  // choice: the user can manually retry via 重试 if they actually wanted
  // those tasks to run, but we don't auto-fire untrusted API calls on
  // boot.
  const cancelledStale = cancelStaleQueuedTasks(messages);
  state.messages = messages;
  state.historyLoaded = true;
  state.scrollToBottom = true;
  if (cancelledStale > 0) {
    void saveChatMessages(state.itemID, state.messages);
  }
  renderPanel(mount, state);
}

function cancelStaleQueuedTasks(messages: Message[]): number {
  const now = Date.now();
  let cancelled = 0;
  for (const message of messages) {
    if (message.role !== "user" || !message.task) continue;
    const task = message.task;
    if (task.completedAt || task.cancelledAt) continue;
    task.cancelledAt = now;
    task.error = "Zotero 重启时被中断";
    cancelled += 1;
  }
  return cancelled;
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

async function getSelectedTextForPrompt(
  mount: HTMLElement,
  itemID: number | null,
): Promise<string> {
  const win = mount.ownerDocument?.defaultView;
  const reader = getActiveReader(win);
  const ids = readerItemIDs(reader, itemID);
  const draft = firstUsableStoredSelectionAnnotation(ids);
  const rangeText = getActiveReaderSelectionRangeText(reader);
  const visualSelection = getActiveReaderVisualSelection(reader);
  const visualText =
    visualSelection.source === "dom-rects" ? visualSelection.text : "";
  const liveText = getActiveReaderSelection(reader);
  if (rangeText) {
    rememberReaderSelection(reader, itemID, rangeText, draft?.annotation);
  } else if (liveText) {
    rememberReaderSelection(reader, itemID, liveText);
  }
  const rectText = draft
    ? await extractSelectionTextFromAnnotationPosition(reader, draft)
    : "";
  if (rectText && draft) {
    rememberReaderSelection(reader, itemID, rectText, draft.annotation);
  }
  const storedText = firstUsableStoredSelectedText(ids);
  const selectedText =
    rangeText || rectText || visualText || liveText || draft?.text || storedText;
  debugZai("selection.official-text", {
    chosen: rangeText
      ? "reader-selection-ranges"
      : rectText
      ? "position-rects"
      : visualText
        ? visualSelection.source
        : liveText
        ? "live"
        : draft?.text
          ? "reader-event"
          : "stored",
    range: textDebugInfo(rangeText, 120),
    visual: textDebugInfo(visualSelection.text, 120),
    visualSource: visualSelection.source,
    visualRects: visualSelection.rectCount,
    rectText: textDebugInfo(rectText, 120),
    live: textDebugInfo(liveText, 120),
    readerEvent: textDebugInfo(draft?.text ?? "", 120),
    stored: textDebugInfo(storedText, 120),
  });
  return selectedText && !shouldIgnoreSelectedText(ids, selectedText)
    ? selectedText
    : "";
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
  const ids = readerItemIDs(reader, itemID);
  const text = getActiveReaderSelection(reader);
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

function getActiveReaderSelectionRangeText(reader: unknown): string {
  for (const view of activeReaderViews(reader as any)) {
    const text = selectionRangeTextFromView(view);
    if (text) return text;
  }
  return "";
}

function activeReaderViews(reader: any): any[] {
  const views: any[] = [];
  const add = (view: unknown) => {
    if (view && !views.includes(view)) views.push(view);
  };
  add(reader?._internalReader?._primaryView);
  add(reader?._internalReader?._secondaryView);
  return views;
}

function selectionRangeTextFromView(view: any): string {
  const ranges: any[] = Array.isArray(view?._selectionRanges)
    ? view._selectionRanges
    : [];
  if (!ranges.length || ranges[0]?.collapsed) return "";
  const parts = ranges
    .slice()
    .sort(selectionRangeOrder)
    .map((range) => textFromSelectionRange(view, range))
    .filter(Boolean);
  return normalizeSelectedText(parts.join("\n"));
}

function selectionRangeOrder(left: any, right: any): number {
  const leftPage = selectionRangePageIndex(left);
  const rightPage = selectionRangePageIndex(right);
  if (leftPage !== rightPage) return leftPage - rightPage;
  return selectionRangeStartOffset(left) - selectionRangeStartOffset(right);
}

function textFromSelectionRange(view: any, range: any): string {
  const pageIndex = selectionRangePageIndex(range);
  const chars = charsForReaderPage(view, pageIndex);
  const start = selectionRangeStartOffset(range);
  const end = selectionRangeEndOffset(range);
  if (chars.length && Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return textFromReaderChars(chars.slice(start, end));
  }
  return typeof range?.text === "string" ? range.text : "";
}

function selectionRangePageIndex(range: any): number {
  const pageIndex =
    range?.position?.pageIndex ?? range?.pageIndex ?? range?.positionPageIndex;
  return typeof pageIndex === "number" && Number.isFinite(pageIndex)
    ? Math.floor(pageIndex)
    : 0;
}

function selectionRangeStartOffset(range: any): number {
  return Math.min(selectionRangeOffset(range?.anchorOffset), selectionRangeOffset(range?.headOffset));
}

function selectionRangeEndOffset(range: any): number {
  return Math.max(selectionRangeOffset(range?.anchorOffset), selectionRangeOffset(range?.headOffset));
}

function selectionRangeOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function charsForReaderPage(view: any, pageIndex: number): any[] {
  const pages = view?._pdfPages;
  const page = Array.isArray(pages) ? pages[pageIndex] : pages?.[String(pageIndex)];
  return Array.isArray(page?.chars) ? page.chars : [];
}

function textFromReaderChars(chars: any[]): string {
  const text: string[] = [];
  for (const char of chars) {
    if (!char || char.ignorable) continue;
    if (typeof char.c === "string") text.push(char.c);
    if (char.paragraphBreakAfter) {
      text.push("\n\n");
    } else if (char.lineBreakAfter) {
      text.push("\n");
    } else if (char.spaceAfter) {
      text.push(" ");
    }
  }
  return text.join("").trim();
}

interface VisualSelectionSnapshot {
  text: string;
  rectCount: number;
  source: string;
}

interface VisualCharFragment {
  char: string;
  rect: DOMRect;
  key: string;
}

function getActiveReaderVisualSelection(reader: unknown): VisualSelectionSnapshot {
  for (const win of activeReaderWindows(reader as any)) {
    const snapshot = visualSelectionFromWindow(win);
    if (snapshot.text) return snapshot;
  }
  return { text: "", rectCount: 0, source: "" };
}

function visualSelectionFromWindow(win: Window): VisualSelectionSnapshot {
  try {
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return { text: "", rectCount: 0, source: "" };
    }
    const rects = selectionClientRects(selection);
    const visualText = normalizeSelectedText(
      extractVisualTextFromClientRects(win.document, rects),
    );
    const rawText = normalizeSelectedText(selection.toString());
    if (isUsableVisualSelectionText(visualText, rawText)) {
      return {
        text: visualText,
        rectCount: rects.length,
        source: "dom-rects",
      };
    }
    return {
      text: rawText,
      rectCount: rects.length,
      source: rawText ? "dom-selection" : "",
    };
  } catch (err) {
    debugZai("selection.visual.failed", { error: errorMessage(err) });
    return { text: "", rectCount: 0, source: "" };
  }
}

function selectionClientRects(selection: Selection): DOMRect[] {
  const rects: DOMRect[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    rects.push(
      ...clientRectArray(range.getClientRects()).filter(isUsefulClientRect),
    );
  }
  return rects;
}

function isUsableVisualSelectionText(visualText: string, rawText: string): boolean {
  if (!visualText) return false;
  if (!rawText) return visualText.length >= 2;
  if (visualText === rawText) return true;
  return visualText.length >= Math.max(12, rawText.length * 0.25);
}

function extractVisualTextFromClientRects(
  doc: Document,
  selectionRects: DOMRect[],
): string {
  if (!selectionRects.length) return "";
  const bounds = unionClientRects(selectionRects);
  const fragments = visualCharFragments(doc, selectionRects, bounds);
  return textFromVisualFragments(fragments);
}

function visualCharFragments(
  doc: Document,
  selectionRects: DOMRect[],
  bounds: DOMRect,
): VisualCharFragment[] {
  const fragments: VisualCharFragment[] = [];
  const seen = new Set<string>();
  const range = doc.createRange();
  const nodes = collectSelectionTextNodes(doc, bounds);
  nodes.forEach((node, nodeIndex) => {
    const text = node.nodeValue ?? "";
    for (const segment of textCodeUnitSegments(text)) {
      const char = text.slice(segment.start, segment.end);
      if (!char.trim()) continue;
      try {
        range.setStart(node, segment.start);
        range.setEnd(node, segment.end);
      } catch {
        continue;
      }
      const rect = bestOverlappingClientRect(
        clientRectArray(range.getClientRects()).filter(isUsefulClientRect),
        selectionRects,
      );
      if (!rect) continue;
      const key = `${nodeIndex}:${segment.start}:${segment.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fragments.push({ char, rect, key });
    }
  });
  range.detach?.();
  return fragments;
}

function collectSelectionTextNodes(doc: Document, bounds: DOMRect): Text[] {
  const roots = (Array.from(doc.querySelectorAll(".textLayer")) as Element[])
    .filter((root) => clientRectListOverlaps(root.getClientRects(), bounds));
  const searchRoots: Node[] = roots.length
    ? roots
    : doc.body
      ? [doc.body]
      : [];
  const nodes: Text[] = [];
  const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
  for (const root of searchRoots) {
    const walker = doc.createTreeWalker(root, showText);
    let current = walker.nextNode();
    while (current) {
      if (current.nodeType === 3) {
        const text = current as Text;
        if (
          text.nodeValue?.trim() &&
          text.parentElement &&
          clientRectListOverlaps(text.parentElement.getClientRects(), bounds)
        ) {
          nodes.push(text);
        }
      }
      current = walker.nextNode();
    }
  }
  return nodes;
}

function textFromVisualFragments(fragments: VisualCharFragment[]): string {
  if (!fragments.length) return "";
  const rows: Array<{ y: number; height: number; chars: VisualCharFragment[] }> = [];
  const sorted = fragments
    .slice()
    .sort(
      (a, b) =>
        clientRectMidY(a.rect) - clientRectMidY(b.rect) ||
        a.rect.left - b.rect.left,
    );

  for (const fragment of sorted) {
    const y = clientRectMidY(fragment.rect);
    const height = Math.max(fragment.rect.height, 1);
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate.y - y) <= Math.max(2, Math.min(8, height * 0.6)),
    );
    if (row) {
      row.chars.push(fragment);
      row.height = Math.max(row.height, height);
      row.y = (row.y + y) / 2;
    } else {
      rows.push({ y, height, chars: [fragment] });
    }
  }

  return rows
    .sort((a, b) => a.y - b.y)
    .map((row) => visualRowText(row.chars, row.height))
    .filter(Boolean)
    .join(" ");
}

function visualRowText(chars: VisualCharFragment[], rowHeight: number): string {
  const sorted = chars
    .slice()
    .sort((a, b) => a.rect.left - b.rect.left || a.key.localeCompare(b.key));
  let output = "";
  let previous: VisualCharFragment | null = null;
  for (const fragment of sorted) {
    if (previous) {
      const gap = fragment.rect.left - previous.rect.right;
      if (
        gap > Math.max(2, rowHeight * 0.22) &&
        shouldInsertVisualSpace(previous.char, fragment.char)
      ) {
        output += " ";
      }
    }
    output += fragment.char;
    previous = fragment;
  }
  return output.trim();
}

function shouldInsertVisualSpace(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (/[,.;:!?，。；：！？)]/.test(right)) return false;
  if (/[(（]$/.test(left)) return false;
  return /[A-Za-z0-9\u4e00-\u9fff)\]]/.test(left) &&
    /[A-Za-z0-9\u4e00-\u9fff([（]/.test(right);
}

function textCodeUnitSegments(
  text: string,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const char of Array.from(text)) {
    const end = offset + char.length;
    segments.push({ start: offset, end });
    offset = end;
  }
  return segments;
}

function bestOverlappingClientRect(
  candidates: DOMRect[],
  selectionRects: DOMRect[],
): DOMRect | null {
  let best: { rect: DOMRect; area: number } | null = null;
  for (const rect of candidates) {
    for (const selectionRect of selectionRects) {
      const area = clientRectOverlapArea(rect, selectionRect, 1);
      if (area > 0.5 && (!best || area > best.area)) {
        best = { rect, area };
      }
    }
  }
  return best?.rect ?? null;
}

function clientRectListOverlaps(rects: DOMRectList, bounds: DOMRect): boolean {
  return clientRectArray(rects).some(
    (rect) => isUsefulClientRect(rect) && clientRectsOverlap(rect, bounds),
  );
}

function clientRectArray(rects: DOMRectList | null): DOMRect[] {
  return rects ? Array.from(rects) : [];
}

function unionClientRects(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

function isUsefulClientRect(rect: DOMRect): boolean {
  return rect.width > 0.5 && rect.height > 0.5;
}

function clientRectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return clientRectOverlapArea(a, b) > 0;
}

function clientRectOverlapArea(a: DOMRect, b: DOMRect, tolerance = 0): number {
  const left = Math.max(a.left, b.left - tolerance);
  const right = Math.min(a.right, b.right + tolerance);
  const top = Math.max(a.top, b.top - tolerance);
  const bottom = Math.min(a.bottom, b.bottom + tolerance);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clientRectMidY(rect: DOMRect): number {
  return (rect.top + rect.bottom) / 2;
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
    const officialText = normalizeSelectedText(e.params?.annotation?.text);
    const visualSelection = getActiveReaderVisualSelection(e.reader);
    const text = officialText || visualSelection.text;
    if (!text) return;
    const annotation = e.params?.annotation
      ? { ...e.params.annotation, text }
      : undefined;
    debugZai("selection.event-capture", {
      rects: annotation ? annotationRectCount(annotation) : 0,
      official: textDebugInfo(officialText, 120),
      visual: textDebugInfo(visualSelection.text, 120),
      visualSource: visualSelection.source,
      visualRects: visualSelection.rectCount,
      text: textDebugInfo(text, 120),
    });
    rememberReaderSelection(e.reader, null, text, annotation);
    for (const win of mountedWindows) {
      const sidebar = windowSidebars.get(win);
      if (sidebar)
        updateSelectionIndicators(sidebar.mount, safeSelectedItemID(win));
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
    const itemID = safeSelectedItemID(win);
    const before = getStoredSelectedText(itemID);
    const focusInSidebar =
      isFocusInside(sidebar.mount) || isFocusInside(sidebar.noteMount);
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
  // INVARIANT: only composer-area DOM is replaced here; messages-list scroll
  // must NOT shift. The wrap defends against the same scroll-collapse seen
  // on annotation-save (focused descendants in a sibling re-rendered subtree).
  preserveMessagesScroll(mount, () => {
    const state = states.get(mount);
    const prompts = mount.querySelector(".quick-prompts") as HTMLElement | null;
    if (state && prompts) {
      prompts.replaceWith(
        renderQuickPrompts(mount.ownerDocument!, mount, state),
      );
    }
    const badge = mount.querySelector(".selection-badge") as HTMLElement | null;
    if (state && badge) {
      badge.replaceWith(
        renderSelectionBadge(mount.ownerDocument!, mount, state),
      );
    }
    const input = mount.querySelector(
      ".input-row textarea",
    ) as HTMLTextAreaElement | null;
    const status = mount.querySelector(
      ".composer-status",
    ) as HTMLElement | null;
    if (state && input && status) {
      renderInputStatus(status, input, state);
    }
  });
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
  if (attachmentID != null) {
    readerByAttachmentID.set(attachmentID, reader);
  }
  for (const id of ids) {
    if (ignoredSelectedTextByItem.get(id) === normalized) {
      continue;
    }
    ignoredSelectedTextByItem.delete(id);
    selectedTextByItem.set(id, normalized);
    if (annotation && attachmentID != null) {
      selectedAnnotationByItem.set(id, {
        text: normalized,
        annotation: detachAnnotationSnapshot(annotation),
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

function firstUsableStoredSelectionAnnotation(
  ids: number[],
): SelectionAnnotationDraft | null {
  for (const id of ids) {
    const draft = selectedAnnotationByItem.get(id);
    if (draft && ignoredSelectedTextByItem.get(id) !== draft.text) {
      return draft;
    }
  }
  return null;
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
  try {
    const r = reader as {
      itemID?: number;
      _item?: { id?: number };
    } | null;
    return typeof r?._item?.id === "number"
      ? r._item.id
      : typeof r?.itemID === "number"
        ? r.itemID
        : null;
  } catch {
    return null;
  }
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

function getReaderForCurrentSelection(
  win: Window | null | undefined,
  itemID: number | null,
): any {
  const draft = getStoredSelectionAnnotation(itemID);
  return getReaderForAttachmentOrItem(win, itemID, draft?.attachmentID ?? null);
}

function getReaderForAttachmentOrItem(
  win: Window | null | undefined,
  itemID: number | null,
  attachmentID: number | null,
): any {
  const active = getActiveReaderForItem(win, itemID);
  if (!attachmentID || readerHasAttachmentID(active, attachmentID)) {
    return active;
  }

  const cached = readerByAttachmentID.get(attachmentID);
  if (readerHasAttachmentID(cached, attachmentID)) return cached;

  const readers = allZoteroReaders();
  const exact = readers.filter((reader) =>
    readerHasAttachmentID(reader, attachmentID),
  );
  const sameThread =
    exact.find((reader) => readerConversationItemID(reader) === itemID) ??
    exact[0];
  if (sameThread) return sameThread;

  debugZai("text-annotation.reader-missing", {
    itemID,
    attachmentID,
    activeAttachmentID: readerAttachmentID(active),
    knownReaders: readers.map((reader) => ({
      itemID: (reader as any)?.itemID,
      attachmentID: readerAttachmentID(reader),
      conversationItemID: readerConversationItemID(reader),
    })),
  });
  return active;
}

function allZoteroReaders(): any[] {
  const readerAPI = (Zotero as any).Reader;
  const readers = Array.isArray(readerAPI?._readers) ? readerAPI._readers : [];
  return readers.filter(Boolean);
}

function readerHasAttachmentID(reader: unknown, attachmentID: number): boolean {
  return readerAttachmentID(reader) === attachmentID;
}

function readerConversationItemID(reader: unknown): number | null {
  try {
    const r = reader as {
      itemID?: number;
      _item?: { id?: number; parentID?: number };
    } | null;
    return typeof r?._item?.parentID === "number"
      ? r._item.parentID
      : typeof r?._item?.id === "number"
        ? itemIDToParentID(r._item.id)
        : itemIDToParentID(r?.itemID);
  } catch {
    return null;
  }
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
  const normalized = formatSelectedTextSemantically(
    repairPdfSelectionLineBreaks(text),
  );
  return normalized.length > contextPolicy.maxSelectedTextChars
    ? normalized.slice(0, contextPolicy.maxSelectedTextChars)
    : normalized;
}

type SelectedTextBlockKind = "paragraph" | "list" | "heading";

interface SelectedTextBlock {
  kind: SelectedTextBlockKind;
  text: string;
}

function formatSelectedTextSemantically(text: string): string {
  const blocks: SelectedTextBlock[] = [];
  let current: SelectedTextBlock | null = null;
  const flush = () => {
    if (!current) return;
    const value = current.text.trim();
    if (value) blocks.push({ ...current, text: value });
    current = null;
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = normalizeSelectedTextLine(rawLine);
    if (!line) {
      flush();
      continue;
    }
    const kind = selectedTextBlockKind(line);
    if (kind !== "paragraph") {
      flush();
      current = { kind, text: line };
      continue;
    }
    if (!current) {
      current = { kind: "paragraph", text: line };
    } else {
      current.text = `${current.text} ${line}`;
    }
  }
  flush();
  return joinSelectedTextBlocks(blocks);
}

function normalizeSelectedTextLine(line: string): string {
  return line.replace(/\u00a0/g, " ").replace(/[ \t\f\v]+/g, " ").trim();
}

function selectedTextBlockKind(line: string): SelectedTextBlockKind {
  if (
    /^(?:\d{1,3}[\).]|\([a-zA-Z0-9]\)|[a-zA-Z]\))\s+/.test(line)
  ) {
    return "list";
  }
  if (/^(?:[A-Z]\.|[IVXLC]+\.|Fig(?:ure)?\.?\s*\d+[:.])\s+/.test(line)) {
    return "heading";
  }
  return "paragraph";
}

function joinSelectedTextBlocks(blocks: SelectedTextBlock[]): string {
  let output = "";
  let previous: SelectedTextBlock | null = null;
  for (const block of blocks) {
    if (!output) {
      output = block.text;
    } else {
      output +=
        previous?.kind === "list" && block.kind === "list" ? "\n" : "\n\n";
      output += block.text;
    }
    previous = block;
  }
  return output.trim();
}

function repairPdfSelectionLineBreaks(text: string): string {
  return text
    .replace(/([A-Za-z]{3,})-\s*\r?\n\s*([a-z]{3,})/g, "$1$2")
    .replace(/([A-Za-z]{3,})-\s{2,}([a-z]{3,})/g, "$1$2");
}

async function extractSelectionTextFromAnnotationPosition(
  reader: unknown,
  draft: SelectionAnnotationDraft,
): Promise<string> {
  if (!reader || !hasAnnotationPosition(draft.annotation)) return "";
  let locator: Awaited<ReturnType<typeof createPdfLocator>> | null = null;
  try {
    locator = await createPdfLocator(reader);
    const extracted = normalizeSelectedText(
      await locator.extractTextFromPosition(draft.annotation.position),
    );
    debugZai(extracted ? "selection.position-text" : "selection.position-empty", {
      rects: annotationRectCount(draft.annotation),
      official: textDebugInfo(draft.text, 120),
      extracted: textDebugInfo(extracted, 120),
    });
    return extracted;
  } catch (err) {
    debugZai("selection.position-text.failed", {
      error: errorMessage(err),
      official: textDebugInfo(draft.text, 120),
    });
    return "";
  } finally {
    locator?.dispose();
  }
}

function hasAnnotationPosition(
  annotation: Record<string, unknown>,
): annotation is Record<string, unknown> & { position: unknown } {
  return !!annotation.position && typeof annotation.position === "object";
}

function annotationRectCount(annotation: Record<string, unknown>): number {
  const position = annotation.position as { rects?: unknown } | undefined;
  return Array.isArray(position?.rects) ? position.rects.length : 0;
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
    const lockedScroll = activeMessagesScrollLock(state);
    if (lockedScroll) {
      state.messagesScrollTop = lockedScroll.top;
      state.autoFollowMessages = lockedScroll.atBottom;
      return;
    }
    state.messagesScrollTop = messages.scrollTop;
  }
}

// Wraps a local DOM mutation (e.g. swapping a single bubble element) so the
// messages-list scroll position is preserved across the swap.
// WHY: Zotero/Firefox may collapse `.messages` scrollTop to 0 mid-mutation
// when a focused descendant is replaced; without this guard the chat
// visibly pages back to the top after operations like "save annotation".
// We restore both synchronously and on the next animation frame to cover
// async layout passes that arrive after the sync swap completes.
function captureMessagesScrollSnapshot(
  mount: HTMLElement,
): MessagesScrollSnapshot | null {
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) return null;
  return {
    top: messages.scrollTop,
    atBottom: isMessagesElementNearBottom(messages),
  };
}

function activeMessagesScrollLock(
  state: PanelState | undefined,
): MessagesScrollSnapshot | null {
  if (!state?.messagesScrollLock) return null;
  if (Date.now() <= state.messagesScrollLock.until) {
    return state.messagesScrollLock.snapshot;
  }
  state.messagesScrollLock = undefined;
  return null;
}

function lockMessagesScroll(
  mount: HTMLElement,
  snapshot: MessagesScrollSnapshot | null = captureMessagesScrollSnapshot(
    mount,
  ),
  durationMs = 3000,
): MessagesScrollSnapshot | null {
  const state = states.get(mount);
  if (state && snapshot) {
    state.messagesScrollLock = {
      snapshot,
      until: Date.now() + durationMs,
    };
    const win = mount.ownerDocument?.defaultView;
    win?.setTimeout(() => activeMessagesScrollLock(state), durationMs + 50);
  }
  return snapshot;
}

function restoreMessagesScrollSnapshot(
  mount: HTMLElement,
  snapshot: MessagesScrollSnapshot | null,
) {
  if (!snapshot) return;
  const messages = mount.querySelector(".messages") as HTMLElement | null;
  if (!messages) return;
  const maxTop = Math.max(0, messages.scrollHeight - messages.clientHeight);
  messages.scrollTop = snapshot.atBottom
    ? maxTop
    : Math.min(snapshot.top, maxTop);
  const state = states.get(mount);
  if (state) {
    state.messagesScrollTop = messages.scrollTop;
    state.autoFollowMessages = snapshot.atBottom;
  }
}

function scheduleMessagesScrollRestore(
  mount: HTMLElement,
  snapshot: MessagesScrollSnapshot | null,
) {
  restoreMessagesScrollSnapshot(mount, snapshot);
  const win = mount.ownerDocument?.defaultView;
  if (!win) return;
  win.requestAnimationFrame(() => {
    restoreMessagesScrollSnapshot(mount, snapshot);
    win.requestAnimationFrame(() =>
      restoreMessagesScrollSnapshot(mount, snapshot),
    );
  });
  win.setTimeout(() => restoreMessagesScrollSnapshot(mount, snapshot), 0);
  win.setTimeout(() => restoreMessagesScrollSnapshot(mount, snapshot), 80);
  win.setTimeout(() => restoreMessagesScrollSnapshot(mount, snapshot), 250);
}

function preserveMessagesScroll(
  mount: HTMLElement,
  mutate: () => void,
  snapshot = captureMessagesScrollSnapshot(mount),
) {
  mutate();
  scheduleMessagesScrollRestore(mount, snapshot);
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

function renderBubbleIdentity(
  doc: Document,
  role: Message["role"],
  settings: UiSettings,
): HTMLElement {
  const profile =
    role === "user" ? settings.userProfile : settings.assistantProfile;
  const wrap = el(doc, "div", "bubble-identity");
  if (profile.avatar) {
    wrap.append(renderBubbleAvatar(doc, profile));
  }
  wrap.append(el(doc, "div", "bubble-role", profile.label));
  return wrap;
}

function renderBubbleAvatar(
  doc: Document,
  profile: ChatProfileSettings,
): HTMLElement {
  const avatar = el(doc, "span", "bubble-avatar");
  if (isAvatarImageSource(profile.avatar)) {
    const image = doc.createElement("img");
    image.src = profile.avatar;
    image.alt = profile.label;
    avatar.append(image);
  } else {
    avatar.textContent = profile.avatar;
  }
  return avatar;
}

function isAvatarImageSource(value: string): boolean {
  return /^(data:image\/|https?:\/\/|file:\/\/|chrome:\/\/)/i.test(value);
}

function bubble(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  message: Message,
  index: number,
) {
  const root = el(
    doc,
    "div",
    [
      "bubble",
      `bubble-${message.role}`,
      `bubble-actions-${state.uiSettings.messageActionsPosition}`,
      `bubble-actions-${state.uiSettings.messageActionsLayout}`,
    ].join(" "),
  );
  root.dataset.messageIndex = String(index);
  const head = el(doc, "div", "bubble-head");
  head.append(renderBubbleIdentity(doc, message.role, state.uiSettings));

  const actions = el(doc, "div", "bubble-actions");
  const copy = buttonEl(doc, "复制");
  copy.addEventListener("click", () => {
    const markdown = messageToClipboard(message, state.copyDebugContext);
    void copyToClipboard(
      doc,
      markdown,
      undefined,
      markdownToClipboardHTML(doc, markdown),
    );
    flashButton(copy, "已复制");
  });
  actions.append(copy);

  if (message.role === "assistant" && message.content.trim()) {
    const saveNote = buttonEl(doc, "写入笔记");
    saveNote.title = betterNotesInsertAvailable()
      ? "用 Better Notes 写入当前条目的子笔记"
      : "写入当前条目的 Zotero 子笔记";
    saveNote.disabled =
      state.itemID == null ||
      (state.sending && state.activeAssistantIndex === index);
    saveNote.addEventListener("click", () => {
      void writeAssistantMessageToNote(doc, state.itemID, message, saveNote);
    });
    actions.append(saveNote);
  }

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
  const sourceUser =
    message.role === "assistant"
      ? state.messages[findPreviousUserIndex(state.messages, index)]
      : undefined;
  if (message.role === "assistant") {
    renderAssistantProcess(doc, root, sourceUser);
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

async function openCurrentItemNote(
  doc: Document,
  itemID: number | null,
  button: HTMLButtonElement,
) {
  const originalText = button.textContent || "打开笔记";
  const originalTitle = button.title;
  button.textContent = "打开中...";
  button.disabled = true;
  let opened = false;

  try {
    const { note, created } = await resolveTargetNote(itemID);
    await showNoteWindow(doc, note);
    opened = true;
    button.textContent = created ? "已新建并打开" : "已打开";
    button.title = `目标笔记 #${note.id}`;
    button.disabled = true;
  } catch (err) {
    button.textContent = "打开失败";
    button.title = err instanceof Error ? err.message : String(err);
  } finally {
    if (!opened) {
      doc.defaultView?.setTimeout(() => {
        button.textContent = originalText;
        button.title = originalTitle;
        button.disabled = false;
      }, 1400);
    }
  }
}

async function showNoteWindow(doc: Document, note: Zotero.Item) {
  const sidebar = findSidebarStateByDocument(doc);
  if (!sidebar) throw new Error("无法找到 AI 侧栏");

  sidebar.noteItemID = note.id;
  setNoteColumnVisible(sidebar, true);
  try {
    renderNoteWindow(sidebar, note);
    updateOpenNoteButton(sidebar);
  } catch (err) {
    sidebar.noteItemID = undefined;
    sidebar.noteMount.replaceChildren();
    setNoteColumnVisible(sidebar, false);
    updateOpenNoteButton(sidebar);
    throw err;
  }
}

function renderNoteWindow(sidebar: WindowSidebarState, note: Zotero.Item) {
  const doc = sidebar.noteMount.ownerDocument!;
  sidebar.noteEditorCleanup?.();
  sidebar.noteEditorCleanup = undefined;
  sidebar.noteMount.replaceChildren();
  const head = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  head.className = "zai-note-window-head";

  const title = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  title.className = "zai-note-window-title";
  title.textContent = noteTitle(note);
  title.title = "拖动左侧橙色分隔线可调整笔记栏宽度";

  const resizeHint = doc.createElementNS(XHTML_NS, "span") as HTMLElement;
  resizeHint.className = "zai-note-resize-hint";
  resizeHint.textContent = "↔ 拖左侧边缘";
  resizeHint.title = "请拖动笔记栏左侧橙色分隔线调整宽度，避免拖出 Zotero PDF 信息栏";

  const status = doc.createElementNS(XHTML_NS, "span") as HTMLElement;
  status.className = "zai-note-window-status";
  status.textContent = "自动保存";

  const save = buttonEl(doc, "保存");
  save.className = "zai-note-window-button zai-note-window-save";
  save.disabled = true;
  save.title = "没有未保存修改";

  const close = buttonEl(doc, "关闭");
  close.className = "zai-note-window-button";
  head.append(title, resizeHint, status, save, close);

  const body = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  body.className = "zai-note-window-body";

  const zoteroEditor = createZoteroNoteEditorElement(doc);
  if (zoteroEditor) {
    body.append(zoteroEditor);
    sidebar.noteMount.append(head, body);
    initializeZoteroNoteEditor(
      sidebar,
      zoteroEditor,
      note,
      status,
      save,
      close,
    );
    return;
  }

  const editor = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  editor.className = "zai-note-rich-editor";
  editor.contentEditable = "true";
  editor.spellcheck = true;
  editor.tabIndex = 0;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("data-placeholder", "输入笔记...");
  renderEditableNoteHTML(editor, note.getNote?.() || "");
  editor.dataset.savedHTML = editableNoteHTML(editor);

  const markChanged = () => {
    updateNoteSaveState(editor, save);
    scheduleAutosaveNote(sidebar, note, editor, status, save);
  };

  editor.addEventListener("input", markChanged);
  editor.addEventListener("paste", (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    insertPlainTextAtSelection(doc, text);
    markChanged();
  });
  sidebar.noteEditorCleanup = installNoteEditorEventIsolation(
    doc,
    editor,
    () => void autosaveNoteNow(sidebar, note, editor, status, save),
  );
  save.addEventListener("click", () => {
    void autosaveNoteNow(sidebar, note, editor, status, save);
  });
  close.addEventListener("click", () => {
    void closeNoteWindow(sidebar, note, editor, status, save, close);
  });

  body.append(editor);
  sidebar.noteMount.append(head, body);
}

interface ZoteroNoteEditorElement extends Element {
  mode?: string;
  viewMode?: string;
  item?: Zotero.Item;
  notitle?: boolean;
  focus?: () => Promise<void>;
  saveSync?: () => void;
  destroy?: () => void;
  getCurrentInstance?: () => { _iframeWindow?: Window } | null;
  _id?: (id: string) => Element | null;
}

function createZoteroNoteEditorElement(
  doc: Document,
): ZoteroNoteEditorElement | null {
  if (!doc.defaultView?.customElements?.get("note-editor")) return null;
  const createXULElement = doc.createXULElement?.bind(doc);
  if (!createXULElement) return null;
  const editor = createXULElement(
    "note-editor",
  ) as ZoteroNoteEditorElement;
  editor.setAttribute("class", "zai-zotero-note-editor");
  editor.setAttribute("flex", "1");
  editor.setAttribute("notitle", "1");
  return editor;
}

function initializeZoteroNoteEditor(
  sidebar: WindowSidebarState,
  editor: ZoteroNoteEditorElement,
  note: Zotero.Item,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
  closeButton: HTMLButtonElement,
) {
  const doc = sidebar.noteMount.ownerDocument!;
  const win = doc.defaultView;
  status.textContent = "Zotero 自动保存";
  saveButton.disabled = false;
  saveButton.title = "手动触发 Zotero 官方笔记编辑器保存";

  editor.notitle = true;
  editor.mode = "edit";
  editor.viewMode = "library";
  editor.item = note;
  hideZoteroNoteEditorLinks(editor);

  const saveNow = () => {
    saveZoteroNoteEditor(editor, status, saveButton);
  };
  const closeNow = () => {
    closeZoteroNoteWindow(sidebar, editor, closeButton);
  };
  const stopBubble = (event: Event) => {
    event.stopPropagation();
  };
  const refocusEditor = () => {
    void focusZoteroNoteEditor(editor);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveNow();
    }
    event.stopPropagation();
  };

  saveButton.addEventListener("click", saveNow);
  closeButton.addEventListener("click", closeNow);
  editor.addEventListener("focusin", stopBubble);
  editor.addEventListener("pointerdown", stopBubble);
  editor.addEventListener("click", stopBubble);
  editor.addEventListener("keydown", handleKeyDown);

  let initTimer: number | undefined;
  const afterInit = (attempt = 0) => {
    hideZoteroNoteEditorLinks(editor);
    const instance = editor.getCurrentInstance?.();
    if (instance?._iframeWindow) {
      installZoteroNoteEditorKeySave(editor, status, saveButton);
      ensureZoteroNoteEditorKatexCSS(editor);
      void focusZoteroNoteEditor(editor);
      return;
    }
    if (attempt >= 80 || !win) return;
    initTimer = win.setTimeout(() => afterInit(attempt + 1), 50);
  };
  initTimer = win?.setTimeout(() => afterInit(), 0);
  win?.setTimeout(refocusEditor, 150);

  sidebar.noteEditorCleanup = () => {
    if (initTimer && win) win.clearTimeout(initTimer);
    saveButton.removeEventListener("click", saveNow);
    closeButton.removeEventListener("click", closeNow);
    editor.removeEventListener("focusin", stopBubble);
    editor.removeEventListener("pointerdown", stopBubble);
    editor.removeEventListener("click", stopBubble);
    editor.removeEventListener("keydown", handleKeyDown);
    editor.destroy?.();
  };
}

function hideZoteroNoteEditorLinks(editor: ZoteroNoteEditorElement) {
  const links = editor._id?.("links-container") as (HTMLElement & {
    hidden?: boolean;
  }) | null;
  if (links) links.hidden = true;
}

async function focusZoteroNoteEditor(editor: ZoteroNoteEditorElement) {
  try {
    await editor.focus?.();
  } catch (err) {
    Zotero.debug(
      `[Zotero AI Sidebar] Could not focus Zotero note editor: ${String(err)}`,
    );
  }
}

function saveZoteroNoteEditor(
  editor: ZoteroNoteEditorElement,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
) {
  try {
    status.textContent = "保存中...";
    editor.saveSync?.();
    status.textContent = "已保存";
    saveButton.disabled = false;
  } catch (err) {
    status.textContent = "保存失败";
    status.title = err instanceof Error ? err.message : String(err);
  }
}

function installZoteroNoteEditorKeySave(
  editor: ZoteroNoteEditorElement,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
) {
  const iframeWindow = editor.getCurrentInstance?.()?._iframeWindow;
  if (!iframeWindow || (editor as Element).hasAttribute("data-zai-save-key")) {
    return;
  }
  const saveOnKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveZoteroNoteEditor(editor, status, saveButton);
    }
  };
  iframeWindow.addEventListener("keydown", saveOnKeyDown, true);
  (editor as Element).setAttribute("data-zai-save-key", "true");
}

function ensureAllZoteroNoteEditorKatexCSS(doc: Document): void {
  const editors = Array.from(
    doc.querySelectorAll("note-editor"),
  ) as ZoteroNoteEditorElement[];
  let injected = 0;
  for (const editor of editors) {
    if (ensureZoteroNoteEditorKatexCSS(editor)) injected++;
  }
  debugZai("note-editor-katex-css:scan", {
    editors: editors.length,
    injected,
  });
}

function ensureZoteroNoteEditorKatexCSS(
  editor: ZoteroNoteEditorElement,
): boolean {
  const iframeDoc = editor.getCurrentInstance?.()?._iframeWindow?.document;
  if (!iframeDoc) return false;
  ensureKatexCSSInDocument(iframeDoc);
  return true;
}

function ensureKatexCSSInDocument(doc: Document): void {
  const root = doc.head ?? doc.documentElement;
  if (!root) return;

  if (!doc.getElementById("zai-katex-css-link")) {
    const link = doc.createElement("link");
    link.id = "zai-katex-css-link";
    link.rel = "stylesheet";
    link.href = `chrome://${addon.data.config.addonRef}/content/katex/katex.min.css`;
    root.append(link);
  }

  if (!doc.getElementById("zai-katex-css-fallback")) {
    const style = doc.createElement("style");
    style.id = "zai-katex-css-fallback";
    style.textContent = `
.katex .katex-mathml {
  position: absolute;
  clip: rect(1px, 1px, 1px, 1px);
  padding: 0;
  border: 0;
  height: 1px;
  width: 1px;
  overflow: hidden;
}
.katex-display {
  display: block;
  margin: 1em 0;
  text-align: center;
}
.katex-display > .katex {
  display: block;
  text-align: center;
  white-space: nowrap;
}
`;
    root.append(style);
  }
}

function closeZoteroNoteWindow(
  sidebar: WindowSidebarState,
  editor: ZoteroNoteEditorElement,
  closeButton: HTMLButtonElement,
) {
  try {
    closeButton.disabled = true;
    editor.saveSync?.();
    sidebar.noteItemID = undefined;
    sidebar.noteEditorCleanup?.();
    sidebar.noteEditorCleanup = undefined;
    sidebar.noteMount.replaceChildren();
    setNoteColumnVisible(sidebar, false);
    updateOpenNoteButton(sidebar);
  } finally {
    closeButton.disabled = false;
  }
}

function renderEditableNoteHTML(target: HTMLElement, html: string) {
  target.replaceChildren();
  const doc = target.ownerDocument!;
  const Parser = doc.defaultView?.DOMParser;
  if (!html.trim() || !Parser) return;
  const parsed = new Parser().parseFromString(html, "text/html");
  if (parsed.body) appendSanitizedNoteChildren(doc, target, parsed.body);
}

function editableNoteHTML(editor: HTMLElement): string {
  const doc = editor.ownerDocument!;
  const scratch = doc.createElement("div");
  appendSanitizedNoteChildren(doc, scratch, editor);
  return isEditableNoteEmpty(scratch) ? "" : String(scratch.innerHTML).trim();
}

function isEditableNoteEmpty(element: HTMLElement): boolean {
  if (element.querySelector("table, hr, blockquote, pre, ul, ol")) return false;
  return !(element.textContent || "").replace(/\u200b/g, "").trim();
}

function insertPlainTextAtSelection(doc: Document, text: string) {
  if (doc.execCommand?.("insertText", false, text)) return;
  const selection = doc.getSelection?.();
  if (!selection || !selection.rangeCount) return;
  selection.deleteFromDocument();
  selection.getRangeAt(0).insertNode(doc.createTextNode(text));
  selection.collapseToEnd();
}

function installNoteEditorEventIsolation(
  doc: Document,
  editor: HTMLElement,
  saveNow: () => void,
): () => void {
  const stopBubble = (event: Event) => {
    event.stopPropagation();
  };
  const stopKeyboardBubble = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveNow();
    }
    // Do not stop the event in capture phase: Firefox/contenteditable needs the
    // normal target phase for Enter, Backspace/Delete and list editing.
    event.stopPropagation();
  };
  const ensureEditorFocus = () => {
    if (doc.activeElement === editor) return;
    const selection = doc.getSelection?.();
    if (selection?.anchorNode && !editor.contains(selection.anchorNode)) return;
    editor.focus({ preventScroll: true });
  };

  for (const type of [
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "pointerdown",
    "pointerup",
  ]) {
    editor.addEventListener(type, stopBubble);
  }
  editor.addEventListener("focus", stopBubble);
  editor.addEventListener("click", ensureEditorFocus);
  editor.addEventListener("keydown", stopKeyboardBubble);
  editor.addEventListener("keypress", stopBubble);
  editor.addEventListener("keyup", stopBubble);

  return () => {
    for (const type of [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "pointerdown",
      "pointerup",
    ]) {
      editor.removeEventListener(type, stopBubble);
    }
    editor.removeEventListener("focus", stopBubble);
    editor.removeEventListener("click", ensureEditorFocus);
    editor.removeEventListener("keydown", stopKeyboardBubble);
    editor.removeEventListener("keypress", stopBubble);
    editor.removeEventListener("keyup", stopBubble);
  };
}

interface EditableSelectionSnapshot {
  anchorPath: number[];
  anchorOffset: number;
  focusPath: number[];
  focusOffset: number;
}

function saveEditableSelection(root: HTMLElement): EditableSelectionSnapshot | null {
  const selection = root.ownerDocument?.getSelection?.();
  if (
    !selection ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }
  const anchorPath = nodePathFromRoot(root, selection.anchorNode);
  const focusPath = nodePathFromRoot(root, selection.focusNode);
  if (!anchorPath || !focusPath) return null;
  return {
    anchorPath,
    anchorOffset: selection.anchorOffset,
    focusPath,
    focusOffset: selection.focusOffset,
  };
}

function restoreEditableSelection(
  root: HTMLElement,
  snapshot: EditableSelectionSnapshot | null,
) {
  if (!snapshot || !root.isConnected) return;
  const restore = () => {
    if (!root.isConnected) return;
    const anchor = nodeFromRootPath(root, snapshot.anchorPath);
    const focus = nodeFromRootPath(root, snapshot.focusPath);
    if (!anchor || !focus) return;
    const anchorOffset = clampNodeOffset(anchor, snapshot.anchorOffset);
    const focusOffset = clampNodeOffset(focus, snapshot.focusOffset);
    root.focus({ preventScroll: true });
    const selection = root.ownerDocument?.getSelection?.();
    if (!selection) return;
    const selectionWithExtent = selection as Selection & {
      setBaseAndExtent?: (
        anchorNode: Node,
        anchorOffset: number,
        focusNode: Node,
        focusOffset: number,
      ) => void;
    };
    if (selectionWithExtent.setBaseAndExtent) {
      selectionWithExtent.setBaseAndExtent(
        anchor,
        anchorOffset,
        focus,
        focusOffset,
      );
      return;
    }
    const range = root.ownerDocument!.createRange();
    range.setStart(anchor, anchorOffset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  restore();
  const win = root.ownerDocument?.defaultView;
  win?.requestAnimationFrame?.(restore);
  win?.setTimeout(restore, 80);
}

function restoreEditableSelectionIfLost(
  root: HTMLElement,
  snapshot: EditableSelectionSnapshot | null,
) {
  if (hasEditableSelection(root)) return;
  restoreEditableSelection(root, snapshot);
}

function hasEditableSelection(root: HTMLElement): boolean {
  const selection = root.ownerDocument?.getSelection?.();
  return !!(
    selection?.anchorNode &&
    selection.focusNode &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode)
  );
}

function nodePathFromRoot(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return current === root ? path : null;
}

function nodeFromRootPath(root: Node, path: number[]): Node | null {
  let current: Node = root;
  for (const index of path) {
    const child = current.childNodes.item(index);
    if (!child) return null;
    current = child;
  }
  return current;
}

function clampNodeOffset(node: Node, offset: number): number {
  const max =
    node.nodeType === Node.TEXT_NODE
      ? (node.textContent || "").length
      : node.childNodes.length;
  return Math.max(0, Math.min(offset, max));
}

async function closeNoteWindow(
  sidebar: WindowSidebarState,
  note: Zotero.Item,
  editor: HTMLElement,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
  closeButton: HTMLButtonElement,
) {
  try {
    closeButton.disabled = true;
    await autosaveNoteNow(sidebar, note, editor, status, saveButton);
    sidebar.noteItemID = undefined;
    sidebar.noteEditorCleanup?.();
    sidebar.noteEditorCleanup = undefined;
    sidebar.noteMount.replaceChildren();
    setNoteColumnVisible(sidebar, false);
    updateOpenNoteButton(sidebar);
  } finally {
    closeButton.disabled = false;
  }
}

function scheduleAutosaveNote(
  sidebar: WindowSidebarState,
  note: Zotero.Item,
  editor: HTMLElement,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
) {
  const win = editor.ownerDocument?.defaultView;
  if (sidebar.noteAutosaveTimer && win) {
    win.clearTimeout(sidebar.noteAutosaveTimer);
  }
  if (!isNoteEditorDirty(editor)) {
    updateNoteSaveState(editor, saveButton);
    return;
  }
  status.textContent = "未保存";
  sidebar.noteAutosaveTimer = win?.setTimeout(() => {
    sidebar.noteAutosaveTimer = undefined;
    void autosaveNoteNow(sidebar, note, editor, status, saveButton);
  }, 1800);
}

async function autosaveNoteNow(
  sidebar: WindowSidebarState,
  note: Zotero.Item,
  editor: HTMLElement,
  status: HTMLElement,
  saveButton: HTMLButtonElement,
) {
  const win = editor.ownerDocument?.defaultView;
  if (sidebar.noteAutosaveTimer && win) {
    win.clearTimeout(sidebar.noteAutosaveTimer);
    sidebar.noteAutosaveTimer = undefined;
  }
  if (!isNoteEditorDirty(editor)) {
    updateNoteSaveState(editor, saveButton);
    return;
  }
  if (sidebar.noteAutosavePromise) {
    await sidebar.noteAutosavePromise;
  }
  status.textContent = "保存中...";
  saveButton.disabled = true;
  const selection = saveEditableSelection(editor);
  sidebar.noteAutosavePromise = (async () => {
    const html = editableNoteHTML(editor);
    note.setNote(html || "<p></p>");
    await note.saveTx();
  })();
  try {
    await sidebar.noteAutosavePromise;
    editor.dataset.savedHTML = editableNoteHTML(editor);
    status.textContent = "已保存";
    updateNoteSaveState(editor, saveButton);
    restoreEditableSelectionIfLost(editor, selection);
  } catch (err) {
    status.textContent = "保存失败";
    status.title = err instanceof Error ? err.message : String(err);
    updateNoteSaveState(editor, saveButton);
    restoreEditableSelectionIfLost(editor, selection);
    throw err;
  } finally {
    sidebar.noteAutosavePromise = undefined;
  }
}

function isNoteEditorDirty(editor: HTMLElement): boolean {
  return editableNoteHTML(editor) !== (editor.dataset.savedHTML ?? "");
}

function updateNoteSaveState(
  editor: HTMLElement,
  saveButton: HTMLButtonElement,
) {
  const dirty = isNoteEditorDirty(editor);
  saveButton.disabled = !dirty;
  saveButton.title = dirty ? "保存当前修改 (Ctrl+S)" : "没有未保存修改";
}

function findSidebarStateByDocument(doc: Document): WindowSidebarState | null {
  for (const win of mountedWindows) {
    const state = windowSidebars.get(win);
    if (state?.mount.ownerDocument === doc) return state;
  }
  return null;
}

function findSidebarStateByMount(mount: HTMLElement): WindowSidebarState | null {
  for (const win of mountedWindows) {
    const state = windowSidebars.get(win);
    if (state?.mount === mount) return state;
  }
  return null;
}

function isNoteWindowOpenForMount(mount: HTMLElement): boolean {
  return !!findSidebarStateByMount(mount)?.noteItemID;
}

function updateOpenNoteButton(state: WindowSidebarState) {
  const button = state.mount.querySelector(
    ".open-note-button",
  ) as HTMLButtonElement | null;
  if (!button) return;
  const opened = !!state.noteItemID;
  button.textContent = opened ? "已打开" : "打开笔记";
  button.disabled = opened;
}

function setNoteColumnVisible(state: WindowSidebarState, visible: boolean) {
  const noteColumn = state.noteColumn as Element & {
    hidden?: boolean;
    collapsed?: boolean;
  };
  const noteSplitter = state.noteSplitter as Element & { hidden?: boolean };
  noteColumn.hidden = !visible;
  noteSplitter.hidden = !visible;
  if (visible) {
    noteColumn.collapsed = false;
    state.noteColumn.removeAttribute("collapsed");
    state.noteColumn.removeAttribute("hidden");
    state.noteSplitter.removeAttribute("hidden");
    if (!state.noteColumn.getAttribute("width")) {
      state.noteColumn.setAttribute("width", "360");
    }
    return;
  }
  noteColumn.collapsed = true;
  state.noteColumn.setAttribute("collapsed", "true");
  state.noteColumn.setAttribute("hidden", "true");
  state.noteSplitter.setAttribute("hidden", "true");
}

function noteTitle(note: Zotero.Item): string {
  const title = (note as Zotero.Item & { getNoteTitle?: () => string })
    .getNoteTitle?.();
  return title || `Zotero 笔记 #${note.id}`;
}

function refreshVisibleNoteWindow(doc: Document, noteID: number) {
  const sidebar = findSidebarStateByDocument(doc);
  if (sidebar?.noteItemID !== noteID) return;
  const note = getZoteroItem(noteID);
  if (isZoteroNote(note)) renderNoteWindow(sidebar, note);
}

function appendSanitizedNoteChildren(
  doc: Document,
  target: HTMLElement,
  source: Node,
) {
  const children = Array.from(source.childNodes).filter(
    (node): node is Node => !!node,
  );
  for (const child of children) {
    if (child.nodeType === 3) {
      target.append(doc.createTextNode(child.textContent || ""));
      continue;
    }
    if (child.nodeType !== 1) continue;

    const sourceEl = child as Element;
    const tag = sourceEl.tagName.toLowerCase();
    if (!ALLOWED_NOTE_TAGS.has(tag)) {
      appendSanitizedNoteChildren(doc, target, sourceEl);
      continue;
    }

    const clone = doc.createElement(tag);
    copySafeNoteAttributes(sourceEl, clone);
    appendSanitizedNoteChildren(doc, clone, sourceEl);
    target.append(clone);
  }
}

const ALLOWED_NOTE_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "col",
  "colgroup",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

function copySafeNoteAttributes(source: Element, target: HTMLElement) {
  for (const attr of Array.from(source.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith("on")) continue;
    if (name === "href") {
      if (!isSafeNoteUrl(value)) continue;
      target.setAttribute("href", value);
      target.setAttribute("rel", "noreferrer");
      target.setAttribute("target", "_blank");
      continue;
    }
    if (name.startsWith("data-")) {
      target.setAttribute(name, value);
      continue;
    }
    if (
      name === "style" &&
      !/url\s*\(|expression\s*\(/i.test(value)
    ) {
      target.setAttribute(name, value);
      continue;
    }
    if (["alt", "class", "colspan", "rowspan", "title"].includes(name)) {
      target.setAttribute(name, value);
    }
  }
}

function isSafeNoteUrl(value: string): boolean {
  const url = value.trim().toLowerCase();
  return !!url && !url.startsWith("javascript:") && !url.startsWith("data:");
}

async function writeAssistantMessageToNote(
  doc: Document,
  itemID: number | null,
  message: Message,
  button: HTMLButtonElement,
) {
  const originalText = button.textContent || "写入笔记";
  const originalTitle = button.title;
  button.textContent = "写入中...";
  button.disabled = true;

  try {
    const result = await appendAssistantContentToItemNote(
      doc,
      itemID,
      message.content,
    );
    button.textContent = result.usedBetterNotes
      ? "已写入 BN"
      : result.created
        ? "已新建笔记"
        : "已写入";
    button.title = `目标笔记 #${result.noteID}`;
    refreshVisibleNoteWindow(doc, result.noteID);
  } catch (err) {
    button.textContent = "写入失败";
    button.title = err instanceof Error ? err.message : String(err);
  } finally {
    doc.defaultView?.setTimeout(() => {
      button.textContent = originalText;
      button.title = originalTitle;
      button.disabled = false;
    }, 1400);
  }
}

async function appendAssistantContentToItemNote(
  doc: Document,
  itemID: number | null,
  content: string,
): Promise<{ noteID: number; created: boolean; usedBetterNotes: boolean }> {
  if (itemID == null) throw new Error("未选择 Zotero 条目");
  const target = await resolveTargetNote(itemID);
  const html = assistantContentToNoteHTML(doc, content);
  const usedBetterNotes = await insertHTMLIntoNote(target.note, html);
  return {
    noteID: target.note.id,
    created: target.created,
    usedBetterNotes,
  };
}

async function resolveTargetNote(
  itemID: number | null,
): Promise<{ note: Zotero.Item; created: boolean }> {
  if (itemID == null) throw new Error("未选择 Zotero 条目");
  const item = getZoteroItem(itemID);
  if (!item) throw new Error(`找不到 Zotero 条目 #${itemID}`);
  if (isZoteroNote(item)) return { note: item, created: false };

  const parent = parentItemForNotes(item);
  const existing = childNotesForItem(parent)[0];
  if (existing) return { note: existing, created: false };

  return { note: await createChildNote(parent), created: true };
}

function getZoteroItem(itemID: number): Zotero.Item | null {
  const item = Zotero.Items.get(itemID) as Zotero.Item | false | undefined;
  return item || null;
}

function parentItemForNotes(item: Zotero.Item): Zotero.Item {
  const maybeAttachment = item as Zotero.Item & {
    isAttachment?: () => boolean;
    parentID?: number;
  };
  if (maybeAttachment.isAttachment?.() && maybeAttachment.parentID) {
    return getZoteroItem(maybeAttachment.parentID) ?? item;
  }
  return item;
}

function childNotesForItem(item: Zotero.Item): Zotero.Item[] {
  const getNotes = (item as Zotero.Item & { getNotes?: () => unknown })
    .getNotes;
  if (!getNotes) return [];

  const ids = getNotes.call(item);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const notes = Zotero.Items.get(ids as number[]) as
    | Zotero.Item[]
    | Zotero.Item
    | false
    | undefined;
  const items = Array.isArray(notes) ? notes : notes ? [notes] : [];
  return items.filter(isZoteroNote);
}

function isZoteroNote(item: Zotero.Item | null | undefined): item is Zotero.Item {
  return !!item && (item as Zotero.Item & { isNote?: () => boolean }).isNote?.();
}

async function createChildNote(parent: Zotero.Item): Promise<Zotero.Item> {
  const note = new (Zotero as unknown as { Item: new (type: string) => any }).Item(
    "note",
  ) as Zotero.Item;
  note.libraryID = parent.libraryID;
  (note as Zotero.Item & { parentID?: number }).parentID = parent.id;
  note.setNote("<p>AI 笔记</p>");
  await note.saveTx();
  return note;
}

function assistantContentToNoteHTML(doc: Document, content: string): string {
  const root = doc.createElement("div");
  root.append(doc.createElement("hr"));

  const title = doc.createElement("h2");
  title.textContent = `AI 总结 ${formatNoteTimestamp(new Date())}`;
  root.append(title);

  const body = doc.createElement("div");
  // Notes path: keep $..$ / $$..$$ as plain text. Zotero's note editor
  // (and Better Notes' ProseMirror schema) strips KaTeX-produced HTML and
  // MathML wrappers; the only math syntax that consistently round-trips
  // is the LaTeX source inside dollar delimiters, which Better Notes
  // re-renders via its own KaTeX pass. See the comment in
  // appendInlineMarkdown above for the failure modes we'd hit otherwise.
  renderMarkdownInto(body, content.trim(), "source");
  while (body.firstChild) root.appendChild(body.firstChild);
  return String(root.innerHTML);
}

async function insertHTMLIntoNote(
  note: Zotero.Item,
  html: string,
  forceMetadata = false,
): Promise<boolean> {
  const betterNotesInsert = betterNotesNoteInsert();
  const before = note.getNote?.() || "";
  debugZai("note-insert:start", {
    noteID: note.id,
    forceMetadata,
    betterNotes: Boolean(betterNotesInsert),
    before: textDebugInfo(before, 120),
    beforeHTML: htmlStringDebugInfo(before),
    html: htmlStringDebugInfo(html),
  });
  if (betterNotesInsert) {
    await betterNotesInsert(note, html, -1, forceMetadata);
    const after = note.getNote?.() || "";
    debugZai("note-insert:better-notes-done", {
      noteID: note.id,
      after: textDebugInfo(after, 120),
      afterHTML: htmlStringDebugInfo(after),
    });
    return true;
  }

  note.setNote(appendHTMLToExistingNote(note.getNote() || "", html));
  await note.saveTx();
  const after = note.getNote?.() || "";
  debugZai("note-insert:zotero-done", {
    noteID: note.id,
    after: textDebugInfo(after, 120),
    afterHTML: htmlStringDebugInfo(after),
  });
  return false;
}

function betterNotesInsertAvailable(): boolean {
  return !!betterNotesNoteInsert();
}

function betterNotesNoteInsert():
  | ((
      note: Zotero.Item,
      html: string,
      lineIndex?: number,
      forceMetadata?: boolean,
    ) => Promise<void> | void)
  | null {
  const noteApi = (Zotero as unknown as {
    BetterNotes?: {
      api?: {
        note?: {
          insert?: (
            note: Zotero.Item,
            html: string,
            lineIndex?: number,
            forceMetadata?: boolean,
          ) => Promise<void> | void;
        };
      };
    };
  }).BetterNotes?.api?.note;
  return typeof noteApi?.insert === "function"
    ? noteApi.insert.bind(noteApi)
    : null;
}

function appendHTMLToExistingNote(existing: string, addition: string): string {
  if (!existing.trim()) return `<div>${addition}</div>`;
  const closingDiv = existing.lastIndexOf("</div>");
  if (closingDiv >= 0 && existing.slice(closingDiv).trim() === "</div>") {
    return `${existing.slice(0, closingDiv)}${addition}${existing.slice(
      closingDiv,
    )}`;
  }
  return `${existing}${addition}`;
}

function formatNoteTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(" ");
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
  if (draft.color) {
    const color = el(doc, "span", "annotation-suggestion-color", draft.color);
    color.style.setProperty("--annotation-color", draft.color);
    color.title = "保存时使用该 PDF 注释颜色";
    head.append(color);
  }
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
  applyAnnotationButtonState(button, draft.state, "annotation");
  button.addEventListener("click", () => {
    button.blur();
    void saveAnnotationDraftFromBubble(mount, state, index);
  });
  actions.append(button);

  const textButton = buttonEl(doc, "");
  textButton.classList.add("annotation-save", "annotation-save-text");
  applyAnnotationButtonState(textButton, draft.textState ?? { kind: "idle" }, "text");
  textButton.addEventListener("click", () => {
    textButton.blur();
    void saveTextAnnotationDraftFromBubble(mount, state, index);
  });
  actions.append(textButton);

  const failedState =
    draft.state.kind === "failed"
      ? draft.state
      : draft.state.kind !== "saved" && draft.textState?.kind === "failed"
        ? draft.textState
        : null;
  if (failedState) {
    const failedMode =
      draft.state.kind === "failed" ? "高亮+评论保存失败" : "新增文字保存失败";
    const err = el(
      doc,
      "div",
      "annotation-suggestion-error",
      `${failedMode}: ${friendlyAnnotationError(failedState.error)}`,
    );
    actions.append(err);
  }
  return actions;
}

function friendlyAnnotationError(raw: string): string {
  if (/Permission denied to pass object to privileged code/i.test(raw)) {
    return "插件与 Zotero 主窗口之间的对象权限边界没穿过去——重试一次通常就行；持续失败请反馈日志。";
  }
  if (/attachment is no longer available/i.test(raw)) {
    return "原 PDF 附件已被删除或移走，无法定位选区。";
  }
  if (/position data|usable rect data/i.test(raw)) {
    return "选区缺少有效的 PDF 坐标信息，请重新选取一段文字后再试。";
  }
  return raw;
}

function applyAnnotationButtonState(
  button: HTMLButtonElement,
  state: AssistantAnnotationDraft["state"],
  mode: "annotation" | "text",
) {
  // Wording mirrors Zotero Reader's official toolbar (reader.ftl):
  //   - `highlight` annotation = "高亮文本 / Highlight Text" (we call the
  //     comment-bearing variant "高亮+评论").
  //   - `text` annotation = "新增文字 / Add Text" (the T toolbar tool).
  // Keeping these labels aligned with Zotero's own UI also lets users speak
  // about the action with the same vocabulary the model sees in the tool
  // descriptions, so prompts like "新增文字" route correctly without having
  // to mention "T 工具".
  switch (state.kind) {
    case "idle":
      button.textContent =
        mode === "text" ? "🅣 新增文字" : "💾 高亮+评论";
      button.disabled = false;
      button.title =
        mode === "text"
          ? "Zotero Reader 的「新增文字 / Add Text」(T 工具)：在选区下方放一段可见文字"
          : "Zotero Reader 的「高亮文本 / Highlight Text」并附上评论";
      return;
    case "saving":
      button.textContent = "保存中…";
      button.disabled = true;
      button.title = "";
      return;
    case "saved":
      button.textContent = "✓ 已保存";
      button.disabled = true;
      button.title =
        state.annotationID > 0
          ? `Zotero annotation #${state.annotationID}`
          : "已写入 Zotero（条目 ID 暂未回填）";
      return;
    case "failed":
      button.textContent = mode === "text" ? "↻ 重试新增文字" : "↻ 重试高亮+评论";
      button.disabled = false;
      button.title = state.error;
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
    const localZoteroTool = latestTool.name.startsWith("zotero_");
    return {
      label: localZoteroTool ? "正在调用 Zotero 工具" : "正在使用联网工具",
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
        detail:
          state.activeAssistantDetail ||
          latestTool?.summary ||
          "请求已发送，等待首个流式事件",
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

  const scrollSnapshot = lockMessagesScroll(mount);
  draft.state = { kind: "saving" };
  refreshAnnotationSuggestion(mount, index, scrollSnapshot);
  try {
    const { id } = await saveSelectionAnnotation(draft.snapshot, {
      comment: draft.comment,
      ...(draft.color ? { color: draft.color } : {}),
    });
    lockMessagesScroll(mount, scrollSnapshot);
    scheduleMessagesScrollRestore(mount, scrollSnapshot);
    draft.state = { kind: "saved", annotationID: id, savedAt: Date.now() };
  } catch (err) {
    lockMessagesScroll(mount, scrollSnapshot);
    scheduleMessagesScrollRestore(mount, scrollSnapshot);
    draft.state = {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  void saveChatMessages(state.itemID, state.messages);
  refreshAnnotationSuggestion(mount, index, scrollSnapshot);
}

async function saveTextAnnotationDraftFromBubble(
  mount: HTMLElement,
  state: PanelState,
  index: number,
) {
  const message = state.messages[index];
  const draft = message?.annotationDraft;
  if (!message || !draft) return;
  const textState = draft.textState ?? { kind: "idle" as const };
  if (textState.kind === "saving" || textState.kind === "saved") return;

  const scrollSnapshot = lockMessagesScroll(mount);
  draft.textState = { kind: "saving" };
  refreshAnnotationSuggestion(mount, index, scrollSnapshot);
  try {
    const reader = getActiveReaderForItem(
      mount.ownerDocument?.defaultView,
      state.itemID,
    );
    const readerForSelection = getReaderForAttachmentOrItem(
      mount.ownerDocument?.defaultView,
      state.itemID,
      draft.snapshot.attachmentID,
    );
    const fontSize = loadToolSettings(zoteroPrefs()).textAnnotationFontSize;
    const { id } = await saveTextAnnotationNearSelection(
      draft.snapshot,
      {
        comment: draft.comment,
        ...(draft.color ? { color: draft.color } : {}),
        fontSize,
        placement: "below",
      },
      readerForSelection ?? reader,
    );
    lockMessagesScroll(mount, scrollSnapshot);
    scheduleMessagesScrollRestore(mount, scrollSnapshot);
    draft.textState = { kind: "saved", annotationID: id, savedAt: Date.now() };
  } catch (err) {
    lockMessagesScroll(mount, scrollSnapshot);
    scheduleMessagesScrollRestore(mount, scrollSnapshot);
    draft.textState = {
      kind: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  void saveChatMessages(state.itemID, state.messages);
  refreshAnnotationSuggestion(mount, index, scrollSnapshot);
}

function refreshAnnotationSuggestion(
  mount: HTMLElement,
  index: number,
  scrollSnapshot?: MessagesScrollSnapshot | null,
) {
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
  // INVARIANT: this is a local in-bubble swap; messages-list scroll position
  // must NOT shift. Without preservation, swapping in a slightly shorter
  // suggestion (e.g. "✓ 已保存" replacing "💾 高亮+评论") clamps scrollTop
  // when the user is near the bottom and visually pages the chat backward.
  preserveMessagesScroll(
    mount,
    () => {
      if (existing) existing.replaceWith(next);
      else root.append(next);
    },
    scrollSnapshot,
  );
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
function renderMarkdownInto(
  target: HTMLElement,
  markdown: string,
  mathMode: MathRenderMode = "html",
) {
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
    appendInlineMarkdown(p, paragraph.join(" "), mathMode);
    // Display math in source mode emits a block element. Nesting that inside
    // <p> is invalid HTML and note parsers may drop or duplicate it. Hoist
    // block children up to `target` and emit surrounding inline text as <p>'s.
    if (p.querySelector(":scope > pre, :scope > div.math-display")) {
      flushParagraphWithBlockHoist(target, p);
    } else {
      target.append(p);
    }
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
    appendInlineMarkdown(li, text, mathMode);
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
      appendInlineMarkdown(
        heading,
        line.slice(headingLevel + 1).trim(),
        mathMode,
      );
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
      appendInlineMarkdown(quote, line.slice(2), mathMode);
      target.append(quote);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
}

// Walks `<p>`'s children, splitting at direct child blocks so display
// math (or any other block emitted by inline rendering) sits at block
// level instead of nested inside <p>. We preserve a fresh <p> only for
// runs of inline content; empty runs are dropped.
function flushParagraphWithBlockHoist(
  target: HTMLElement,
  p: HTMLElement,
): void {
  const doc = target.ownerDocument!;
  let buffer: HTMLElement = doc.createElement("p");
  const flushBuffer = () => {
    if (buffer.childNodes.length > 0) target.append(buffer);
    buffer = doc.createElement("p");
  };
  let preceedingPreFlushed = false;
  for (const child of Array.from(p.childNodes) as Node[]) {
    if (isHoistableInlineRenderBlock(child)) {
      flushBuffer();
      target.append(child);
      preceedingPreFlushed = true;
    } else {
      // After hoisting a <pre>, the joined-paragraph mechanic leaves a
      // single leading space on the next text node (paragraph.join(" ")
      // glue). Trim it so the resulting <p> doesn't start with " ".
      if (
        preceedingPreFlushed &&
        buffer.childNodes.length === 0 &&
        child.nodeType === 3
      ) {
        const stripped = (child.textContent ?? "").replace(/^\s+/, "");
        if (stripped) buffer.append(doc.createTextNode(stripped));
        preceedingPreFlushed = false;
      } else {
        buffer.append(child);
        preceedingPreFlushed = false;
      }
    }
  }
  flushBuffer();
}

function isHoistableInlineRenderBlock(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as HTMLElement;
  return (
    el.tagName === "PRE" ||
    (el.tagName === "DIV" && el.classList.contains("math-display"))
  );
}

// Inline markdown: `code`, **bold**, [label](url).
// Streaming-safe pattern: at each step we look for the EARLIEST opening
// delimiter; if its closing partner is not yet in the buffer, we emit the
// rest as literal text and return. WHY: during streaming, the next chunk
// may bring the closing delimiter — but until then, NEVER half-render a
// `<strong>` or `<a>` (those would have to be unwound on the next call).
// INVARIANT: every emitted node is either createTextNode or createElement
// with textContent; no innerHTML on any path.
function appendInlineMarkdown(
  parent: HTMLElement,
  text: string,
  mathMode: MathRenderMode = "html",
) {
  const doc = parent.ownerDocument!;
  let cursor = 0;

  while (cursor < text.length) {
    // Math is checked first because its delimiters can legitimately contain
    // characters that would otherwise be parsed as bold/link/code (e.g.
    // `\[ a [b] \]`). Streaming-safe: findNextMathRegion returns null when
    // the closing delimiter has not arrived yet, so unclosed math falls
    // through to plain-text emission and is retried on the next chunk.
    //
    // All three modes (html / mathml / source) need detection so the
    // delimiters get consumed and the inner LaTeX is normalized. The
    // mode only affects the OUTPUT in renderMathInto: KaTeX HTML for
    // chat, KaTeX MathML for older note paths, or a plain
    // <span class="math">$..$</span> wrapper that Better Notes recognizes.
    const math = findNextMathRegion(text, cursor);
    const codeStart = text.indexOf("`", cursor);
    const boldStart = text.indexOf("**", cursor);
    const linkStart = text.indexOf("[", cursor);
    const starts = [
      math ? math.start : -1,
      codeStart,
      boldStart,
      linkStart,
    ].filter((index) => index >= 0);
    const next = starts.length ? Math.min(...starts) : -1;

    if (next < 0) {
      parent.append(doc.createTextNode(text.slice(cursor)));
      return;
    }
    if (next > cursor) {
      parent.append(doc.createTextNode(text.slice(cursor, next)));
    }

    if (math && next === math.start) {
      renderMathInto(parent, math, mathMode);
      cursor = math.end;
      continue;
    }

    if (next === codeStart) {
      const end = text.indexOf("`", next + 1);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const codeContent = text.slice(next + 1, end);
      // ESCAPE HATCH: models sometimes wrap a math formula in backticks
      // (`$$ x $$` or `$x$`), which would normally render as inline code
      // and leave the dollar delimiters visible. If the entire backticked
      // body — after trimming — is a single closed math region, treat
      // the author's intent as math and render accordingly. Genuine
      // "show LaTeX source" cases should use a fenced code block, which
      // is handled at the block level and never reaches here.
      const trimmed = codeContent.trim();
      const inner = findNextMathRegion(trimmed, 0);
      if (inner && inner.start === 0 && inner.end === trimmed.length) {
        renderMathInto(parent, inner, mathMode);
        cursor = end + 1;
        continue;
      }
      const code = doc.createElement("code");
      code.textContent = codeContent;
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
      appendInlineMarkdown(strong, text.slice(next + 2, end), mathMode);
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
    appendInlineMarkdown(anchor, link.label, mathMode);
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

let programmaticClipboardWrite = false;
let pendingSidebarCopy: { text: string; label: string; html?: string } | null =
  null;

async function copyToClipboard(
  doc: Document,
  text: string,
  debugLabel?: string,
  html?: string,
) {
  if (debugLabel) {
    debugZai(`${debugLabel}: clipboard-write:start`, {
      text: textDebugInfo(text),
      html: html ? htmlStringDebugInfo(html) : null,
    });
  }
  if (html) {
    const copiedRich = copyRichTextViaExecCommand(doc, text, html, debugLabel);
    if (copiedRich) return;
  }
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      if (debugLabel) {
        debugZai(`${debugLabel}: clipboard-write:writeText-ok`, {
          length: text.length,
        });
      }
      return;
    } catch (err) {
      // Zotero/Firefox chrome documents can expose navigator.clipboard but
      // still reject writeText(). Fall through to the execCommand path.
      if (debugLabel) {
        debugZai(`${debugLabel}: clipboard-write:writeText-failed`, {
          error: errorMessage(err),
        });
      }
    }
  }

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const root = doc.body ?? doc.documentElement;
  if (!root) {
    if (debugLabel) debugZai(`${debugLabel}: clipboard-write:no-root`);
    return;
  }
  root.append(textarea);
  textarea.select();
  programmaticClipboardWrite = true;
  try {
    const ok = doc.execCommand("copy");
    if (debugLabel) {
      debugZai(`${debugLabel}: clipboard-write:execCommand`, { ok });
    }
  } finally {
    programmaticClipboardWrite = false;
    textarea.remove();
  }
}

function copyRichTextViaExecCommand(
  doc: Document,
  text: string,
  html: string,
  debugLabel?: string,
): boolean {
  const root = doc.body ?? doc.documentElement;
  if (!root) {
    if (debugLabel) debugZai(`${debugLabel}: clipboard-write:no-root`);
    return false;
  }

  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData("text/html", html);
    wrote = true;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  root.append(textarea);
  textarea.select();
  doc.addEventListener("copy", onCopy, true);
  programmaticClipboardWrite = true;
  try {
    const ok = doc.execCommand("copy");
    if (debugLabel) {
      debugZai(`${debugLabel}: clipboard-write:rich-execCommand`, {
        ok,
        wrote,
      });
    }
    return ok && wrote;
  } finally {
    programmaticClipboardWrite = false;
    doc.removeEventListener("copy", onCopy, true);
    textarea.remove();
  }
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

function messageToClipboard(message: Message, includeDebugContext: boolean): string {
  if (!includeDebugContext) return message.content;

  const lines = [`## ${message.role === "user" ? "You" : "AI"}`, ""];
  lines.push(...formatContextMarkdown(message));
  const imageSummary = formatImageAttachmentSummary(message);
  if (imageSummary) lines.push(imageSummary, "");
  if (message.thinking) {
    lines.push("### 思考过程", "", message.thinking, "");
  }
  lines.push(message.content, "");
  return lines.join("\n");
}

function formatConversationMarkdown(
  state: PanelState,
  includeDebugContext: boolean,
): string {
  const item = state.itemID == null ? null : Zotero.Items.get(state.itemID);
  const title = item?.getField("title") || "未选择条目";
  const lines = [
    `# Zotero AI Chat - ${title}`,
    "",
    `- Item ID: ${state.itemID ?? "none"}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
    ...formatItemIntroductionMarkdown(state.itemID, item),
  ];

  for (const message of state.messages) {
    lines.push(`## ${message.role === "user" ? "You" : "AI"}`, "");
    if (includeDebugContext) {
      lines.push(...formatContextMarkdown(message));
      const imageSummary = formatImageAttachmentSummary(message);
      if (imageSummary) lines.push(imageSummary, "");
      if (message.thinking) {
        lines.push("### 思考过程", "", message.thinking, "");
      }
    }
    lines.push(message.content, "");
  }

  return lines.join("\n");
}

function formatItemIntroductionMarkdown(
  itemID: number | null,
  item: Zotero.Item | false | null | undefined,
): string[] {
  if (itemID == null || !item) return [];
  const authors = item
    .getCreators()
    .map((creator) =>
      [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    )
    .filter(Boolean);
  const fields = [
    ["标题", item.getField("title")],
    ["作者", authors.join(", ")],
    ["年份", parseYearString(item.getField("date"))],
    ["期刊/会议", item.getField("publicationTitle") || item.getField("conferenceName")],
    ["DOI", item.getField("DOI")],
    ["URL", item.getField("url")],
  ].filter(([, value]) => String(value ?? "").trim().length > 0);
  const tags = item
    .getTags()
    .map((tag) => tag.tag)
    .filter(Boolean);
  const abstract = item.getField("abstractNote")?.trim();
  const lines = ["## PDF 介绍", ""];
  for (const [label, value] of fields) {
    lines.push(`- ${label}: ${value}`);
  }
  if (tags.length) lines.push(`- 标签: ${tags.join(", ")}`);
  if (abstract) {
    lines.push("", "### 摘要", "", abstract);
  }
  lines.push("", "## 对话记录", "");
  return lines;
}

function parseYearString(date: string): string {
  return date.match(/\b(18|19|20|21)\d{2}\b/)?.[0] ?? "";
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

function withReasoningEffort(
  preset: ModelPreset,
  effort: ReasoningEffort,
): ModelPreset {
  return {
    ...preset,
    extras: {
      ...preset.extras,
      reasoningEffort: effort,
    },
  };
}

function reasoningEffortLabel(effort: ReasoningEffort): string {
  return (
    REASONING_EFFORT_OPTIONS.find(([value]) => value === effort)?.[1] ?? effort
  );
}

function reasoningEffortShortLabel(effort: ReasoningEffort): string {
  const label = reasoningEffortLabel(effort);
  return label.split(" - ")[0] || label;
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

function presetSelectLabel(preset: ModelPreset): string {
  return `${preset.label} (${preset.provider})`;
}

function updateToolbarOption(mount: HTMLElement, preset: ModelPreset) {
  const option = Array.from(
    mount.querySelectorAll(".preset-switcher option"),
  ).find((node) => (node as HTMLOptionElement).value === preset.id) as
    | HTMLOptionElement
    | undefined;
  if (option) {
    option.textContent = presetSelectLabel(preset);
  }
}

async function testPresetConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<{ message: string; preset: ModelPreset }> {
  if (!preset.apiKey.trim()) throw new Error("API Key 为空");
  if (!preset.model.trim()) throw new Error("Model 为空");
  if (preset.provider === "openai") {
    return testOpenAIConnectivity(preset, signal);
  }

  const testPreset = {
    ...preset,
    maxTokens: Math.min(Math.max(preset.maxTokens || 256, 256), 512),
  };
  const messages: Message[] = [{ role: "user", content: "Reply OK." }];
  const provider = getProvider(testPreset);
  let sawAnyChunk = false;

  for await (const chunk of provider.stream(
    messages,
    "Connectivity test. Reply with OK only.",
    testPreset,
    signal,
  )) {
    if (chunk.type === "error") throw new Error(chunk.message);
    sawAnyChunk = true;
    if (chunk.type === "text_delta" || chunk.type === "usage") break;
  }

  return {
    preset,
    message: sawAnyChunk
      ? `连接成功：${preset.provider} / ${preset.model}`
      : `连接完成：${preset.provider} / ${preset.model}`,
  };
}

async function testOpenAIConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
): Promise<{ message: string; preset: ModelPreset }> {
  const withMaxTokens = await requestOpenAIConnectivity(preset, signal, true);
  if (withMaxTokens.ok) {
    return {
      preset: withOmitMaxOutputTokens(preset, false),
      message: `连接成功：${preset.provider} / ${preset.model}（支持 Max tokens）`,
    };
  }

  if (!isUnsupportedMaxOutputTokens(withMaxTokens.body)) {
    throw new Error(openAITestErrorMessage(withMaxTokens));
  }

  const withoutMaxTokens = await requestOpenAIConnectivity(
    preset,
    signal,
    false,
  );
  if (!withoutMaxTokens.ok) {
    throw new Error(openAITestErrorMessage(withoutMaxTokens));
  }

  return {
    preset: withOmitMaxOutputTokens(preset, true),
    message:
      `连接成功：${preset.provider} / ${preset.model}` +
      "（服务不支持 Max tokens，已保存为不发送）",
  };
}

type OpenAITestResult =
  | { ok: true }
  | { ok: false; status: number; body: string };

async function requestOpenAIConnectivity(
  preset: ModelPreset,
  signal: AbortSignal,
  includeMaxOutputTokens: boolean,
): Promise<OpenAITestResult> {
  const body = {
    model: preset.model,
    instructions: "Connectivity test. Reply OK only.",
    input: [{ role: "user", content: "Reply OK." }],
    ...(includeMaxOutputTokens ? { max_output_tokens: 256 } : {}),
    reasoning:
      preset.provider === "openai"
        ? {
            effort: preset.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
            ...(preset.extras?.reasoningSummary === "none"
              ? {}
              : {
                  summary:
                    preset.extras?.reasoningSummary ??
                    DEFAULT_REASONING_SUMMARY,
                }),
          }
        : undefined,
    stream: true,
    store: false,
  };
  const response = await fetch(openAIResponsesUrl(preset.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${preset.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  return {
    ok: false,
    status: response.status,
    body: await response.text(),
  };
}

function openAIResponsesUrl(baseUrl: string): string {
  const root = baseUrl.trim() || "https://api.openai.com/v1";
  return `${root.replace(/\/+$/, "")}/responses`;
}

function isUnsupportedMaxOutputTokens(body: string): boolean {
  return /unsupported parameter:\s*max_output_tokens|max_output_tokens.*unsupported/i.test(
    body,
  );
}

function openAITestErrorMessage(
  result: Exclude<OpenAITestResult, { ok: true }>,
) {
  return `HTTP ${result.status}: ${result.body || "no body"}`;
}

function withOmitMaxOutputTokens(
  preset: ModelPreset,
  omit: boolean,
): ModelPreset {
  const extras = { ...preset.extras };
  if (omit) extras.omitMaxOutputTokens = true;
  else delete extras.omitMaxOutputTokens;
  return { ...preset, extras };
}

function presetSignature(preset: ModelPreset): string {
  return JSON.stringify({
    id: preset.id,
    provider: preset.provider,
    label: preset.label,
    apiKey: preset.apiKey,
    baseUrl: preset.baseUrl,
    model: preset.model,
    models: preset.models ?? [],
    maxTokens: preset.maxTokens,
    extras: preset.extras ?? {},
  });
}

function sanitizedTestError(err: unknown, apiKey: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (apiKey) message = message.split(apiKey).join("[API_KEY]");
  if (message.toLowerCase().includes("abort")) {
    return "连接超时或已取消";
  }
  return `连接失败：${message}`;
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
    scheduleWindowRegisterRetry(win);
    return;
  }
  windowRegisterRetries.delete(win);

  doc.getElementById(SPLITTER_ID)?.remove();
  doc.getElementById(COLUMN_ID)?.remove();
  doc.getElementById(NOTE_SPLITTER_ID)?.remove();
  doc.getElementById(NOTE_COLUMN_ID)?.remove();

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

  const noteSplitter = doc.createXULElement("splitter");
  noteSplitter.id = NOTE_SPLITTER_ID;
  noteSplitter.setAttribute("resizebefore", "closest");
  noteSplitter.setAttribute("resizeafter", "closest");
  noteSplitter.setAttribute("collapse", "after");
  noteSplitter.setAttribute("orient", "horizontal");
  noteSplitter.setAttribute("hidden", "true");
  noteSplitter.append(doc.createXULElement("grippy"));

  const noteColumn = doc.createXULElement("vbox");
  noteColumn.id = NOTE_COLUMN_ID;
  noteColumn.setAttribute("class", "zai-note-column");
  noteColumn.setAttribute("width", "360");
  noteColumn.setAttribute("zotero-persist", "width");
  noteColumn.setAttribute("collapsed", "true");
  noteColumn.setAttribute("hidden", "true");
  noteColumn.addEventListener(
    "wheel",
    (event: Event) => event.stopPropagation(),
    {
      passive: true,
    },
  );

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

  const katexLink = doc.createElementNS(XHTML_NS, "link") as HTMLLinkElement;
  katexLink.rel = "stylesheet";
  katexLink.href = `chrome://${addon.data.config.addonRef}/content/katex/katex.min.css`;

  const noteLink = doc.createElementNS(XHTML_NS, "link") as HTMLLinkElement;
  noteLink.rel = "stylesheet";
  noteLink.href = `chrome://${addon.data.config.addonRef}/content/sidebar.css`;

  const noteKatexLink = doc.createElementNS(XHTML_NS, "link") as HTMLLinkElement;
  noteKatexLink.rel = "stylesheet";
  noteKatexLink.href = `chrome://${addon.data.config.addonRef}/content/katex/katex.min.css`;

  const mount = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  mount.id = ROOT_ID;
  mount.className = "zai-root-independent";

  const noteMount = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  noteMount.id = NOTE_ROOT_ID;
  noteMount.className = "zai-note-root";

  noteColumn.append(noteLink, noteKatexLink, noteMount);
  column.append(link, katexLink, mount);
  parent.insertBefore(noteSplitter, contextPane.nextSibling);
  parent.insertBefore(noteColumn, noteSplitter.nextSibling);
  parent.insertBefore(splitter, noteColumn.nextSibling);
  parent.insertBefore(column, splitter.nextSibling);

  const state: WindowSidebarState = {
    column,
    splitter,
    mount,
    noteColumn,
    noteSplitter,
    noteMount,
  };
  splitter.addEventListener("command", () => updateToggleButton(state));
  splitter.addEventListener("mouseup", () => updateToggleButton(state));
  windowSidebars.set(win, state);
  mountedWindows.add(win);
  installToggleButton(win, state);
  installFloatingToggle(win, state);
  patchItemSelection(win, state);
  startSelectionMonitor(win, state);
  installSidebarCopyHandler(win, state);
  installSidebarSelectionMenu(win, state);
  installReaderPromptShortcutHandler(win, state);
  renderWindowSidebar(win);
  scheduleInitialSidebarRefresh(win, state);
}

function scheduleWindowRegisterRetry(win: Window): void {
  const attempt = (windowRegisterRetries.get(win) ?? 0) + 1;
  windowRegisterRetries.set(win, attempt);
  if (attempt > 24) {
    Zotero.debug("[Zotero AI Sidebar] Could not find Zotero pane container");
    return;
  }
  win.setTimeout(() => registerSidebarForWindow(win), 250);
}

function installReaderTranslateToolbar(
  win: Window,
  state: WindowSidebarState,
): void {
  const mountedGroups: HTMLElement[] = [];

  const mountIntoActiveReader = () => {
    const reader = getActiveReader(win) as any;
    for (const readerWin of activeReaderWindows(reader)) {
      const doc = readerWin.document;
      if (!doc || doc.getElementById(READER_TRANSLATE_GROUP_ID)) {
        if (doc) syncReaderTranslateButtons(win, doc);
        continue;
      }
      const toolbar = findReaderToolbar(doc);
      if (!toolbar) continue;
      ensureReaderTranslateToolbarStyle(doc);
      const group = doc.createElement("span");
      group.id = READER_TRANSLATE_GROUP_ID;
      group.className = "zai-reader-translate-group";

      const translateBtn = doc.createElement("button");
      translateBtn.type = "button";
      translateBtn.className = "zai-reader-translate-button";
      translateBtn.textContent = "译";
      translateBtn.title = "逐句翻译模式 (Alt+T)，翻译参数在插件设置中配置";
      translateBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleTranslateMode(win, translateBtn);
      });

      group.append(translateBtn);
      insertReaderTranslateGroup(toolbar, group);
      mountedGroups.push(group);
      syncReaderTranslateButtons(win, doc);
    }
  };

  mountIntoActiveReader();
  const monitorID = win.setInterval(mountIntoActiveReader, 500);
  state.readerTranslateToolbarCleanup = () => {
    win.clearInterval(monitorID);
    for (const group of mountedGroups) group.remove();
  };
}

function findReaderToolbar(doc: Document): HTMLElement | null {
  if (!doc.querySelector(".textLayer,.pdfViewer,.page[data-page-number],#viewerContainer")) {
    return null;
  }
  const selectors = [
    ".reader-toolbar",
    "#toolbarViewer",
    "#toolbarViewerLeft",
    "#toolbarContainer",
    "[role='toolbar']",
    ".toolbar",
    ".toolbar-container",
  ];
  for (const selector of selectors) {
    for (const candidate of Array.from(doc.querySelectorAll(selector))) {
      const toolbar = candidate as HTMLElement;
      if (typeof toolbar.querySelector === "function" && toolbar.querySelector("button,toolbarbutton")) {
        return toolbar;
      }
    }
  }
  return null;
}

function insertReaderTranslateGroup(toolbar: HTMLElement, group: HTMLElement): void {
  const before =
    toolbar.querySelector("spacer[flex='1'], .spacer, .toolbar-spacer") ??
    toolbar.querySelector("#scaleSelectContainer, #numPages") ??
    null;
  toolbar.insertBefore(group, before);
}

function syncReaderTranslateButtons(win: Window, doc?: Document): void {
  const targetDoc = doc ?? win.document;
  const enabled = translateControllers.get(win)?.isEnabled() ?? false;
  const buttons = Array.from(
    targetDoc.querySelectorAll(".zai-reader-translate-button"),
  ) as HTMLElement[];
  for (const button of buttons) {
    button.classList.toggle("zai-reader-translate-button--active", enabled);
    setTranslateButtonLabel(button, enabled);
  }
}

function ensureReaderTranslateToolbarStyle(doc: Document): void {
  if (doc.getElementById(READER_TRANSLATE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = READER_TRANSLATE_STYLE_ID;
  style.textContent = READER_TRANSLATE_STYLE_TEXT;
  (doc.head ?? doc.documentElement)?.append(style);
}

const READER_TRANSLATE_STYLE_TEXT = `
.zai-reader-translate-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-inline: 6px;
  vertical-align: middle;
}
.zai-reader-translate-button {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.zai-reader-translate-button:hover {
  background: rgba(128, 128, 128, 0.14);
}
.zai-reader-translate-button--active {
  color: #d34a24;
  background: rgba(239, 91, 43, 0.14);
  border-color: #ef5b2b;
}
body.zai-translate-mode-on .page { cursor: crosshair !important; }
body.zai-translate-mode-on .textLayer span:hover {
  background: rgba(74, 140, 247, 0.10);
  border-radius: 2px;
}
`;

function installReaderPromptShortcutHandler(
  win: Window,
  sidebar: WindowSidebarState,
): void {
  const installedWindows = new WeakSet<Window>();
  const cleanupCallbacks: Array<() => void> = [];
  const addWindow = (targetWin: Window | null | undefined) => {
    if (!targetWin || installedWindows.has(targetWin)) return;
    installedWindows.add(targetWin);
    const handler = (event: KeyboardEvent) => {
      if (handleTranslateModeShortcut(win, event)) return;
      if (handleReaderTaskEscape(win, targetWin, sidebar, event)) return;
      void handleReaderPromptShortcut(win, targetWin, sidebar, event);
    };
    targetWin.addEventListener("keydown", handler, true);
    cleanupCallbacks.push(() =>
      targetWin.removeEventListener("keydown", handler, true),
    );
  };
  const installLikelyReaderWindows = () => {
    addWindow(win);
    const reader = getActiveReader(win) as any;
    for (const readerWin of activeReaderWindows(reader)) addWindow(readerWin);
  };
  installLikelyReaderWindows();
  const monitorID = win.setInterval(installLikelyReaderWindows, 500);
  sidebar.promptShortcutCleanup = () => {
    win.clearInterval(monitorID);
    for (const cleanup of cleanupCallbacks) cleanup();
  };
}

function handleTranslateModeShortcut(win: Window, event: KeyboardEvent): boolean {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== "t") return false;
  if (isEditableEventTarget(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  const readerDoc = (event.target as Node | null)?.ownerDocument;
  const button =
    readerDoc?.querySelector<HTMLElement>(".zai-reader-translate-button") ??
    win.document.querySelector<HTMLElement>(".zai-reader-translate-button");
  const fallback = win.document.documentElement as HTMLElement | null;
  if (!button && !fallback) return true;
  void toggleTranslateMode(win, button ?? fallback!);
  return true;
}

async function handleReaderPromptShortcut(
  win: Window,
  sourceWin: Window,
  sidebar: WindowSidebarState,
  event: KeyboardEvent,
): Promise<void> {
  const key = shortcutKeyFromEvent(event);
  if (!key || !isReaderShortcutContext(win, sourceWin, event)) return;

  const settings = loadQuickPromptSettings(zoteroPrefs());
  const prompt = settings.customButtons.find(
    (button) => button.shortcut === key && button.prompt.trim(),
  );
  if (!prompt) return;

  const itemID = safeSelectedItemID(win);
  const selectedText = await getSelectedTextForPrompt(sidebar.mount, itemID);
  if (!selectedText) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  setColumnCollapsed(win, sidebar, false);
  const state = states.get(sidebar.mount);
  if (!state) return;
  void sendMessage(sidebar.mount, state, prompt.prompt, {
    taskTitle: prompt.label?.trim() || `快捷键 ${key.toUpperCase()}`,
  });
}

function handleReaderTaskEscape(
  win: Window,
  sourceWin: Window,
  sidebar: WindowSidebarState,
  event: KeyboardEvent,
): boolean {
  if (
    event.defaultPrevented ||
    event.key !== "Escape" ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    !isReaderShortcutContext(win, sourceWin, event)
  ) {
    return false;
  }
  const state = states.get(sidebar.mount);
  if (!state || (!state.queueOpen && !state.sending)) return false;
  const handled = handleTaskEscape(sidebar.mount, state, event);
  if (handled) event.stopImmediatePropagation();
  return handled;
}

function shortcutKeyFromEvent(event: KeyboardEvent): string {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  ) {
    return "";
  }
  const key = event.key.toLowerCase();
  return /^[a-z0-9]$/.test(key) ? key : "";
}

function isReaderShortcutContext(
  win: Window,
  sourceWin: Window,
  event: KeyboardEvent,
): boolean {
  if (isEditableEventTarget(event.target)) return false;
  const reader = getActiveReader(win);
  if (!reader) return false;
  const readerWindows = activeReaderWindows(reader);
  if (readerWindows.some((readerWin) => readerWin === sourceWin)) return true;

  const active = win.document.activeElement;
  return readerWindows.some((readerWin) => active === safeFrameElement(readerWin));
}

function activeReaderWindows(reader: any): Window[] {
  const windows: Window[] = [];
  const add = (value: unknown) => {
    const win = value as Window | null | undefined;
    if (win && !windows.includes(win)) windows.push(win);
  };
  add(reader?._internalReader?._primaryView?._iframeWindow);
  add(reader?._internalReader?._secondaryView?._iframeWindow);
  add(reader?._iframeWindow);
  return windows;
}

function safeFrameElement(win: Window): Element | null {
  try {
    return win.frameElement;
  } catch {
    return null;
  }
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  const element =
    target && (target as { nodeType?: number }).nodeType === 1
      ? (target as Element)
      : null;
  if (!element) return false;
  const editable = element.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
  return !!editable;
}

// Zotero's main window keybindings intercept Ctrl/Cmd+C before any native
// `copy` event fires inside our XHTML sidebar — pressing the shortcut
// triggers Zotero's "copy selected items" instead of copying the text the
// user highlighted in our chat. Hook a capture-phase keydown at the window
// level: if the current selection lives inside our column or noteColumn,
// write its text to the clipboard ourselves and stop the event so Zotero
// doesn't override it. We deliberately don't touch other Ctrl+C presses
// (selection in items list, search bar, etc.) — the column.contains check
// keeps this scoped.
function installSidebarCopyHandler(
  win: Window,
  sidebar: WindowSidebarState,
): void {
  const doc = win.document;
  const installedWindows = new WeakSet<Window>();
  const installedTargets: EventTarget[] = [];
  const addTarget = (
    target: EventTarget | null | undefined,
    sourceWin: Window,
  ) => {
    if (!target || installedTargets.includes(target)) return;
    const keydownHandler = (event: KeyboardEvent) => {
      const isCopyCombo =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "c";
      if (!isCopyCombo) return;
      copySidebarSelectionFromEvent(
        doc,
        win,
        sourceWin,
        sidebar,
        event,
        "copy-keydown",
      );
    };
    const copyHandler = (event: ClipboardEvent) => {
      handleSidebarCopyEvent(doc, win, sourceWin, sidebar, event);
    };
    const commandHandler = (event: Event) => {
      if (!isCopyCommandEvent(event)) return;
      copySidebarSelectionFromEvent(
        doc,
        win,
        sourceWin,
        sidebar,
        event,
        "copy-command",
      );
    };

    target.addEventListener("keydown", keydownHandler as EventListener, true);
    target.addEventListener("copy", copyHandler as EventListener, true);
    target.addEventListener("command", commandHandler, true);
    installedTargets.push(target);
    cleanupCallbacks.push(() => {
      target.removeEventListener(
        "keydown",
        keydownHandler as EventListener,
        true,
      );
      target.removeEventListener("copy", copyHandler as EventListener, true);
      target.removeEventListener("command", commandHandler, true);
    });
  };
  const addWindow = (targetWin: Window | null | undefined) => {
    if (!targetWin || installedWindows.has(targetWin)) return;
    installedWindows.add(targetWin);
    addTarget(targetWin, targetWin);
    try {
      addTarget(targetWin.document, targetWin);
      addTarget(targetWin.document.getElementById("cmd_copy"), targetWin);
      addTarget(targetWin.document.getElementById("key_copy"), targetWin);
      addTarget(targetWin.document.getElementById("editMenuCommands"), targetWin);
      addTarget(targetWin.document.getElementById("editMenuKeys"), targetWin);
    } catch {
      // Cross-origin / destroyed frame; ignore.
    }
  };
  const cleanupCallbacks: Array<() => void> = [];
  const cacheSelection = () => {
    const sel = win.getSelection();
    if (!selectionBelongsToSidebar(sel, sidebar)) return;
    const text = serializeSidebarSelectionForClipboard(sel);
    if (!text) return;
    cacheSidebarSelection(sidebar, text, "selection-cache");
  };
  const installLikelyFrameWindows = () => {
    addWindow(win);
    installDescendantFrameCopyHandlers(win, addWindow);
    const reader = getActiveReader(win) as any;
    addWindow(reader?._internalReader?._primaryView?._iframeWindow);
    addWindow(reader?._internalReader?._secondaryView?._iframeWindow);
    addWindow(reader?._iframeWindow);
    const noteEditor = findActiveNoteEditor(sidebar);
    addWindow(noteEditor?.getCurrentInstance?.()?._iframeWindow);
  };
  installLikelyFrameWindows();
  const frameMonitorID = win.setInterval(installLikelyFrameWindows, 500);
  doc.addEventListener("selectionchange", cacheSelection, true);
  sidebar.column.addEventListener("mouseup", cacheSelection, true);
  sidebar.column.addEventListener("keyup", cacheSelection, true);
  sidebar.noteColumn.addEventListener("mouseup", cacheSelection, true);
  sidebar.noteColumn.addEventListener("keyup", cacheSelection, true);
  cleanupCallbacks.push(() => {
    win.clearInterval(frameMonitorID);
    doc.removeEventListener("selectionchange", cacheSelection, true);
    sidebar.column.removeEventListener("mouseup", cacheSelection, true);
    sidebar.column.removeEventListener("keyup", cacheSelection, true);
    sidebar.noteColumn.removeEventListener("mouseup", cacheSelection, true);
    sidebar.noteColumn.removeEventListener("keyup", cacheSelection, true);
  });
  sidebar.copyHandlerCleanup = () => {
    for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
  };
}

function handleSidebarCopyEvent(
  doc: Document,
  topWin: Window,
  sourceWin: Window,
  sidebar: WindowSidebarState,
  event: ClipboardEvent,
): void {
  if (pendingSidebarCopy) {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", pendingSidebarCopy.text);
    if (pendingSidebarCopy.html) {
      event.clipboardData.setData("text/html", pendingSidebarCopy.html);
    }
    debugZai(
      `${pendingSidebarCopy.label}: clipboardData-set`,
      {
        text: textDebugInfo(pendingSidebarCopy.text),
        html: pendingSidebarCopy.html
          ? htmlStringDebugInfo(pendingSidebarCopy.html)
          : null,
      },
    );
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return;
  }
  if (programmaticClipboardWrite) return;
  const sel = topWin.getSelection();
  if (!selectionBelongsToSidebar(sel, sidebar)) return;
  if (editableTargetHasOwnSelection(event.target, sel)) return;
  const text = serializeSidebarSelection(sel, "copy-event");
  if (!text || !event.clipboardData) return;
  cacheSidebarSelection(sidebar, text, "copy-event");
  const html = markdownToClipboardHTML(doc, text);
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", html);
  debugZai("copy-event: clipboardData-set", textDebugInfo(text));
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  if (sourceWin !== topWin) {
    void copyToClipboard(doc, text, "copy-event:ensure", html);
  }
}

function installDescendantFrameCopyHandlers(
  rootWin: Window,
  addWindow: (win: Window | null | undefined) => void,
): void {
  const frames = rootWin.frames;
  for (let i = 0; i < frames.length; i++) {
    let frame: Window | null = null;
    try {
      frame = frames.item(i);
    } catch {
      frame = null;
    }
    if (!frame) continue;
    addWindow(frame);
    installDescendantFrameCopyHandlers(frame, addWindow);
  }
}

function copySidebarSelectionFromEvent(
  doc: Document,
  topWin: Window,
  sourceWin: Window,
  sidebar: WindowSidebarState,
  event: Event,
  label: string,
): boolean {
  const selectionResult = sidebarClipboardText(topWin, sourceWin, sidebar);
  if (!selectionResult) return false;
  const { text, fromCache } = selectionResult;
  if (editableTargetHasOwnSelection(event.target, topWin.getSelection())) {
    return false;
  }

  debugZai(`${label}: intercepted`, {
    fromCache,
    sourceIsTop: sourceWin === topWin,
    target: eventTargetDebugInfo(event.target),
    text: textDebugInfo(text, 160),
  });
  cacheSidebarSelection(sidebar, text, label);

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  let copied = false;
  const html = markdownToClipboardHTML(doc, text);
  pendingSidebarCopy = { text, label, html };
  try {
    copied = doc.execCommand("copy");
    debugZai(`${label}: execCommand`, { copied });
  } catch (err) {
    debugZai(`${label}: execCommand-failed`, {
      error: errorMessage(err),
    });
  } finally {
    pendingSidebarCopy = null;
  }

  // Even when execCommand reports success, Zotero/Firefox chrome can still
  // leave the native KaTeX/selection text on the clipboard. The async write
  // path is known to work from the context-menu copy action, so use it as a
  // final authoritative overwrite for keyboard/command copies.
  void copyToClipboard(doc, text, `${label}:ensure`, html);
  return true;
}

function sidebarClipboardText(
  topWin: Window,
  sourceWin: Window,
  sidebar: WindowSidebarState,
): { text: string; fromCache: boolean } | null {
  const topSelection = topWin.getSelection();
  if (selectionBelongsToSidebar(topSelection, sidebar)) {
    const text = serializeSidebarSelection(topSelection, "copy-active-selection");
    return text ? { text, fromCache: false } : null;
  }

  if (hasNonCollapsedSelection(sourceWin) || hasNonCollapsedSelection(topWin)) {
    return null;
  }
  if (sourceWin === topWin) return null;

  const cached = sidebar.lastCopySelection;
  if (!cached || Date.now() - cached.updatedAt > 10000) return null;
  return { text: cached.text, fromCache: true };
}

function hasNonCollapsedSelection(win: Window): boolean {
  try {
    const sel = win.getSelection();
    return Boolean(sel && !sel.isCollapsed && sel.rangeCount > 0);
  } catch {
    return false;
  }
}

function cacheSidebarSelection(
  sidebar: WindowSidebarState,
  text: string,
  label: string,
): void {
  const previous = sidebar.lastCopySelection;
  sidebar.lastCopySelection = { text, updatedAt: Date.now() };
  if (!previous || previous.text !== text || Date.now() - previous.updatedAt > 1000) {
    debugZai(`${label}: cached`, textDebugInfo(text, 120));
  }
}

function serializeSidebarSelectionForClipboard(selection: Selection): string {
  return serializeSelectionAsMarkdown(selection) || selection.toString();
}

function isCopyCommandEvent(event: Event): boolean {
  const target = event.target;
  const id = eventTargetId(target).toLowerCase();
  const command = eventTargetCommand(target).toLowerCase();
  return (
    id === "cmd_copy" ||
    command === "cmd_copy" ||
    id.includes("copy") ||
    command.includes("copy")
  );
}

function eventTargetId(target: EventTarget | null): string {
  const id = (target as unknown as { id?: unknown } | null)?.id;
  return typeof id === "string"
    ? id
    : "";
}

function eventTargetCommand(target: EventTarget | null): string {
  const getter = (target as { getAttribute?: (name: string) => string | null } | null)
    ?.getAttribute;
  return typeof getter === "function" ? getter.call(target, "command") || "" : "";
}

function eventTargetDebugInfo(target: EventTarget | null): unknown {
  return {
    id: eventTargetId(target),
    command: eventTargetCommand(target),
    tag: (target as { tagName?: string } | null)?.tagName ?? "",
  };
}

function selectionBelongsToSidebar(
  selection: Selection | null,
  sidebar: WindowSidebarState,
): selection is Selection {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(
    (anchor &&
      (sidebar.column.contains(anchor) || sidebar.noteColumn.contains(anchor))) ||
      (focus &&
        (sidebar.column.contains(focus) || sidebar.noteColumn.contains(focus))),
  );
}

function isEditableCopyTarget(target: EventTarget | null): boolean {
  return !!editableCopyRoot(target);
}

function editableCopyRoot(target: EventTarget | null): Element | null {
  const el = target as unknown as Element | null;
  if (!el || (el as unknown as { nodeType?: number }).nodeType !== 1) {
    return null;
  }
  const closest = (el as unknown as {
    closest?: (selector: string) => Element | null;
  }).closest;
  const root =
    typeof closest === "function"
      ? closest.call(el, "textarea,input,[contenteditable='true']")
      : null;
  if (root) return root;
  const tag = el.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "INPUT" ||
    el.getAttribute("contenteditable") === "true"
  )
    ? el
    : null;
}

function editableTargetHasOwnSelection(
  target: EventTarget | null,
  selection: Selection | null,
): boolean {
  const root = editableCopyRoot(target);
  if (!root) return false;
  const tag = root.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const input = root as HTMLInputElement | HTMLTextAreaElement;
    try {
      return (input.selectionStart ?? 0) !== (input.selectionEnd ?? 0);
    } catch {
      return true;
    }
  }
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  return Boolean(
    (anchor && root.contains(anchor)) || (focus && root.contains(focus)),
  );
}

function serializeSidebarSelection(
  selection: Selection,
  label: string,
): string {
  const nativeText = selection.toString();
  const markdown = serializeSelectionAsMarkdown(selection);
  const text = markdown || nativeText;
  debugZai(`${label}: selection`, {
    rangeCount: selection.rangeCount,
    native: textDebugInfo(nativeText),
    markdown: textDebugInfo(markdown),
    used: markdown ? "markdown" : "native",
    output: textDebugInfo(text),
    ranges: rangeDebugInfo(selection),
  });
  return text;
}

function rangeDebugInfo(selection: Selection): unknown[] {
  const ranges: unknown[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const startMath = closestLatexElement(range.startContainer);
    const endMath = closestLatexElement(range.endContainer);
    let clonedMathCount = 0;
    let clonedTags = "";
    try {
      const fragment = range.cloneContents();
      clonedMathCount = fragment.querySelectorAll?.("[data-latex]").length ?? 0;
      clonedTags = Array.from(fragment.childNodes)
        .slice(0, 8)
        .map((node) => node?.nodeName ?? "")
        .join(",");
    } catch {
      clonedTags = "<clone failed>";
    }
    ranges.push({
      index: i,
      collapsed: range.collapsed,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      start: nodeDebugInfo(range.startContainer),
      end: nodeDebugInfo(range.endContainer),
      startMath: mathDebugInfo(startMath),
      endMath: mathDebugInfo(endMath),
      clonedMathCount,
      clonedTags,
    });
  }
  return ranges;
}

function closestLatexElement(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    if (cur.nodeType === 1) {
      const el = cur as HTMLElement;
      if (el.dataset?.latex !== undefined) return el;
    }
    cur = cur.parentNode;
  }
  return null;
}

function nodeDebugInfo(node: Node | null): unknown {
  if (!node) return null;
  const parent =
    node.nodeType === 1
      ? (node as Element)
      : node.parentElement ?? undefined;
  return {
    type: node.nodeType,
    name: node.nodeName,
    parent: parent
      ? `${parent.tagName.toLowerCase()}${parent.className ? `.${String(parent.className).split(/\s+/).filter(Boolean).slice(0, 3).join(".")}` : ""}`
      : "",
    text: node.nodeType === 3 ? previewText(node.textContent ?? "", 80) : "",
  };
}

function mathDebugInfo(el: HTMLElement | null): unknown {
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    className: el.className,
    display: el.dataset.display,
    latex: textDebugInfo(el.dataset.latex ?? "", 120),
  };
}

function htmlDebugInfo(doc: Document, html: string): unknown {
  const tmp = doc.createElement("div");
  tmp.innerHTML = html;
  return {
    ...textDebugInfo(html),
    p: tmp.querySelectorAll("p").length,
    li: tmp.querySelectorAll("li").length,
    preMath: tmp.querySelectorAll("pre.math").length,
    spanMath: tmp.querySelectorAll("span.math").length,
    divMath: tmp.querySelectorAll("div.math").length,
    dataLatex: tmp.querySelectorAll("[data-latex]").length,
    topTags: Array.from(tmp.children)
      .slice(0, 10)
      .map((el) => el.tagName.toLowerCase())
      .join(","),
  };
}

function htmlStringDebugInfo(html: string): Record<string, unknown> {
  return {
    ...textDebugInfo(html),
    p: countMatches(html, /<p[\s>]/g),
    li: countMatches(html, /<li[\s>]/g),
    preMath: countMatches(html, /<pre[^>]*class="[^"]*\bmath\b/g),
    spanMath: countMatches(html, /<span[^>]*class="[^"]*\bmath\b/g),
    divMath: countMatches(html, /<div[^>]*class="[^"]*\bmath\b/g),
    dataLatex: countMatches(html, /\sdata-latex=/g),
    displayDelimiters: countMatches(html, /\$\$[\s\S]*?\$\$/g),
  };
}

function textDebugInfo(
  text: string,
  previewLimit = 240,
): Record<string, unknown> {
  return {
    length: text.length,
    lines: text ? text.split("\n").length : 0,
    head: previewText(text, previewLimit),
    tail: previewText(text.slice(-previewLimit), previewLimit),
  };
}

function previewText(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}...`
    : normalized;
}

function countMatches(text: string, pattern: RegExp): number {
  return Array.from(text.matchAll(pattern)).length;
}

function debugZai(label: string, detail?: unknown): void {
  try {
    const suffix =
      detail === undefined
        ? ""
        : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    Zotero.debug(`[zai-debug] ${label}${suffix}`);
  } catch {
    // Ignore logging failures; diagnostics must not break copy/import.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Right-click on a chat selection → floating menu with 复制 / 导入笔记.
// We deliberately don't replace the entire context menu (that would require
// fighting Zotero's XUL menupopup system); instead we suppress the default
// browser menu only when our criteria are met, then render a lightweight
// HTML menu at the click point.
function installSidebarSelectionMenu(
  win: Window,
  sidebar: WindowSidebarState,
): void {
  const doc = win.document;
  let activeMenu: HTMLElement | null = null;
  const dismiss = () => {
    activeMenu?.remove();
    activeMenu = null;
    doc.removeEventListener("mousedown", outsideClick, true);
    doc.removeEventListener("keydown", escClose, true);
  };
  const outsideClick = (e: Event) => {
    if (activeMenu && !activeMenu.contains(e.target as Node)) dismiss();
  };
  const escClose = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };

  const onContextMenu = (event: MouseEvent) => {
    const sel = win.getSelection();
    if (!selectionBelongsToSidebar(sel, sidebar)) return;
    const text = serializeSidebarSelection(sel, "context-menu");
    if (!text) return;

    event.preventDefault();
    event.stopPropagation();
    dismiss();

    const menu = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
    menu.className = "zai-selection-menu";
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;

    const copyBtn = doc.createElementNS(XHTML_NS, "button") as HTMLButtonElement;
    copyBtn.type = "button";
    copyBtn.className = "zai-selection-menu-item";
    copyBtn.textContent = "复制";
    copyBtn.addEventListener("click", () => {
      debugZai("context-menu-copy: click", textDebugInfo(text));
      void copyToClipboard(
        doc,
        text,
        "context-menu-copy",
        markdownToClipboardHTML(doc, text),
      );
      dismiss();
    });

    const importBtn = doc.createElementNS(XHTML_NS, "button") as HTMLButtonElement;
    importBtn.type = "button";
    importBtn.className = "zai-selection-menu-item";
    importBtn.textContent = "导入笔记";
    importBtn.addEventListener("click", () => {
      debugZai("context-menu-import: click", textDebugInfo(text));
      void importSelectionToNote(doc, sidebar, text);
      dismiss();
    });

    menu.append(copyBtn, importBtn);
    (doc.body ?? doc.documentElement)?.append(menu);
    activeMenu = menu;
    doc.addEventListener("mousedown", outsideClick, true);
    doc.addEventListener("keydown", escClose, true);
  };

  win.addEventListener("contextmenu", onContextMenu, true);
  sidebar.selectionMenuCleanup = () => {
    win.removeEventListener("contextmenu", onContextMenu, true);
    dismiss();
  };
}

// Insert a chat selection into the user's note. If the note panel is open
// AND its editor exposes a usable cursor (ProseMirror selection), insert
// at that cursor; otherwise append to the end of the note. The end-of-note
// fallback uses the existing append path (with Better Notes if available)
// but without the "AI 总结 [timestamp]" header — that header is for whole-
// message exports, not for snippet imports.
async function importSelectionToNote(
  doc: Document,
  sidebar: WindowSidebarState,
  selectionMarkdown: string,
): Promise<void> {
  const itemID = sidebar.noteItemID ?? currentItemIdForSidebar(sidebar);
  if (itemID == null) {
    Zotero.debug("[zai] importSelectionToNote: no item selected");
    return;
  }

  const html = markdownToNoteHTMLFragment(doc, selectionMarkdown);
  debugZai("import-selection:prepared", {
    itemID,
    noteItemID: sidebar.noteItemID,
    currentItemID: currentItemIdForSidebar(sidebar),
    markdown: textDebugInfo(selectionMarkdown),
    html: htmlDebugInfo(doc, html),
  });

  try {
    const target = await resolveTargetNote(itemID);
    debugZai("import-selection:target-note", {
      noteID: target.note.id,
      created: target.created,
      noteBefore: textDebugInfo(target.note.getNote?.() || "", 120),
    });
    // Better Notes' editor insertion path uses ProseMirror insertHTML(),
    // which can truncate multi-block snippets after display math. Force
    // metadata insertion for selection imports, then refresh the visible
    // editor so all blocks after the formula survive.
    await insertHTMLIntoNote(target.note, html, true);
    refreshVisibleNoteWindow(doc, target.note.id);
    ensureAllZoteroNoteEditorKatexCSS(doc);
    doc.defaultView?.setTimeout(() => {
      ensureAllZoteroNoteEditorKatexCSS(doc);
    }, 300);
    debugZai("import-selection:refreshed", {
      noteID: target.note.id,
      noteAfterRefreshCall: textDebugInfo(target.note.getNote?.() || "", 120),
    });
  } catch (err) {
    debugZai("import-selection:failed", { error: errorMessage(err) });
  }
}

function currentItemIdForSidebar(sidebar: WindowSidebarState): number | null {
  return states.get(sidebar.mount)?.itemID ?? null;
}

function markdownToNoteHTMLFragment(doc: Document, markdown: string): string {
  const tmp = doc.createElement("div");
  renderMarkdownInto(tmp, markdown.trim(), "source");
  return String(tmp.innerHTML);
}

function markdownToClipboardHTML(doc: Document, markdown: string): string {
  const htmlDoc = doc.implementation.createHTMLDocument("zai-clipboard");
  const tmp = htmlDoc.createElement("div");
  renderMarkdownInto(tmp, markdown.trim(), "source");
  return String(tmp.innerHTML);
}

function findActiveNoteEditor(
  sidebar: WindowSidebarState,
): ZoteroNoteEditorElement | null {
  const editor = sidebar.noteMount.querySelector(
    "note-editor",
  ) as ZoteroNoteEditorElement | null;
  return editor ?? null;
}

function tryInsertHTMLAtCursor(
  editor: ZoteroNoteEditorElement,
  html: string,
): boolean {
  try {
    const iframeWin = editor.getCurrentInstance?.()?._iframeWindow as
      | (Window & { wrappedJSObject?: any })
      | undefined;
    if (!iframeWin) return false;
    const wrapped = iframeWin.wrappedJSObject ?? iframeWin;
    const instance = wrapped._currentEditorInstance;
    const core = instance?._editorCore;
    if (!core?.view?.state || typeof core.insertHTML !== "function") {
      return false;
    }
    const sel = core.view.state.selection;
    let position: number;
    try {
      position = sel.$anchor.after(sel.$anchor.depth);
    } catch {
      position = core.view.state.doc.content.size;
    }
    const docSize = core.view.state.doc.content.size;
    position = Math.max(0, Math.min(position, docSize));
    core.insertHTML(position, html);
    return true;
  } catch {
    return false;
  }
}

export function unregisterSidebarForWindow(win: Window) {
  const state = windowSidebars.get(win);
  if (!state) return;

  disableTranslateMode(win);

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
  state.noteSplitter.remove();
  state.noteEditorCleanup?.();
  state.noteEditorCleanup = undefined;
  state.copyHandlerCleanup?.();
  state.copyHandlerCleanup = undefined;
  state.selectionMenuCleanup?.();
  state.selectionMenuCleanup = undefined;
  state.promptShortcutCleanup?.();
  state.promptShortcutCleanup = undefined;
  state.readerTranslateToolbarCleanup?.();
  state.readerTranslateToolbarCleanup = undefined;
  state.initialRefreshCleanup?.();
  state.initialRefreshCleanup = undefined;
  state.noteColumn.remove();
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

  const itemID = safeSelectedItemID(win);
  const panelState = states.get(state.mount);
  if (panelState?.sending) {
    updateSelectionIndicators(state.mount, panelState.itemID);
    updateToggleButton(state);
    return;
  }

  renderMount(state.mount, itemID);
  updateToggleButton(state);
}

function safeSelectedItemID(win: Window): number | null {
  try {
    return getSelectedItemID(win);
  } catch (err) {
    debugZai("sidebar.selected-item.failed", { error: errorMessage(err) });
    return null;
  }
}

function scheduleInitialSidebarRefresh(win: Window, state: WindowSidebarState) {
  const timers: number[] = [];
  let raf = 0;
  const refresh = () => {
    if (windowSidebars.get(win) !== state) return;
    renderWindowSidebar(win);
  };

  // On cold start Zotero can call plugin window-load hooks before the item
  // pane selection and stylesheet layout have fully settled. A few delayed
  // refreshes mirror the later hide/show path without changing normal chat.
  if (win.requestAnimationFrame) {
    raf = win.requestAnimationFrame(refresh);
  }
  for (const delay of [0, 100, 400, 1200]) {
    timers.push(win.setTimeout(refresh, delay));
  }
  state.initialRefreshCleanup = () => {
    if (raf && win.cancelAnimationFrame) win.cancelAnimationFrame(raf);
    for (const timer of timers) win.clearTimeout(timer);
  };
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
    disableTranslateMode(win);
    column.collapsed = true;
    splitter.hidden = true;
    state.column.setAttribute("collapsed", "true");
    state.splitter.setAttribute("hidden", "true");
    state.noteItemID = undefined;
    state.noteEditorCleanup?.();
    state.noteEditorCleanup = undefined;
    state.noteMount.replaceChildren();
    setNoteColumnVisible(state, false);
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

async function toggleTranslateMode(win: Window, btn: HTMLElement): Promise<void> {
  const ctrl = await getOrCreateTranslateController(win);
  if (!ctrl) {
    syncTranslateBtnState(win, btn);
    flashButton(btn as HTMLButtonElement, "无PDF");
    return;
  }
  if (ctrl.isEnabled()) {
    ctrl.disable();
    translateControllers.delete(win);
    syncTranslateBtnState(win, btn);
  } else {
    try {
      await ctrl.enable();
      syncTranslateBtnState(win, btn);
    } catch (err) {
      debugZai("translate.enable.failed", { error: errorMessage(err) });
      syncTranslateBtnState(win, btn);
      flashButton(btn as HTMLButtonElement, "失败");
    }
  }
}

async function getOrCreateTranslateController(win: Window): Promise<TranslateModeController | null> {
  const reader = getActiveReader(win);
  if (!reader) return null;
  const existing = translateControllers.get(win);
  const prefs = zoteroPrefs();
  const presets = loadPresets(prefs);
  if (existing?.isForReader(reader)) {
    existing.refreshPresets(presets);
    return existing;
  }
  existing?.disable();
  const ctrl = new TranslateModeController({
    prefs,
    presets,
    reader,
  });
  translateControllers.set(win, ctrl);
  return ctrl;
}

function syncTranslateBtnState(win: Window, btn: HTMLElement): void {
  const enabled = translateControllers.get(win)?.isEnabled() ?? false;
  btn.classList.toggle("zai-toolbar-icon--active", enabled);
  btn.classList.toggle("zai-reader-translate-button--active", enabled);
  setTranslateButtonLabel(btn, enabled);
  syncReaderTranslateButtons(win, btn.ownerDocument ?? undefined);
}

function disableTranslateMode(win: Window): void {
  translateControllers.get(win)?.disable();
  translateControllers.delete(win);
  syncTranslateButtons(win);
}

function syncTranslateButtons(win: Window): void {
  const docs = [win.document];
  const reader = getActiveReader(win) as any;
  for (const readerWin of activeReaderWindows(reader)) docs.push(readerWin.document);
  const enabled = translateControllers.get(win)?.isEnabled() ?? false;
  for (const doc of docs) {
    const buttons = Array.from(
      doc.querySelectorAll(".zai-sidebar-translate-button,.zai-reader-translate-button"),
    ) as HTMLElement[];
    for (const button of buttons) {
      button.classList.toggle("zai-toolbar-icon--active", enabled);
      button.classList.toggle("zai-reader-translate-button--active", enabled);
      setTranslateButtonLabel(button, enabled);
    }
  }
}

function setTranslateButtonLabel(btn: HTMLElement, enabled: boolean): void {
  if (
    !btn.classList.contains("zai-sidebar-translate-button") &&
    !btn.classList.contains("zai-reader-translate-button")
  ) {
    return;
  }
  btn.textContent = enabled ? "译✓" : "译";
}

declare global {
  interface Document {
    createXULElement(tagName: string): Element;
  }
}
