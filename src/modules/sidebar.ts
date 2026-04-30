import { buildContext } from '../context/builder';
import {
  createZoteroAgentTools,
  type SelectionAnnotationDraft,
} from '../context/agent-tools';
import {
  contextSummaryLine,
  formatContextMarkdown,
  formatContextLedger,
  formatUserMessageForApi,
  retainedContextStats,
  toApiMessages,
} from '../context/message-format';
import { DEFAULT_CONTEXT_POLICY } from '../context/policy';
import { zoteroContextSource } from '../context/zotero-source';
import { getProvider } from '../providers/factory';
import type { Message } from '../providers/types';
import { loadChatMessages, saveChatMessages } from '../settings/chat-history';
import { loadPresets, savePresets, zoteroPrefs } from '../settings/storage';
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
} from '../settings/types';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const COLUMN_ID = 'zai-column';
const SPLITTER_ID = 'zai-column-splitter';
const ROOT_ID = 'zai-root';
const TOGGLE_BUTTON_ID = 'zai-toggle-button';
const FLOATING_TOGGLE_ID = 'zai-floating-toggle';
const contextPolicy = DEFAULT_CONTEXT_POLICY;

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
const SELECTION_MONITOR_MS = 120;

interface PasteBlock {
  id: number;
  marker: string;
  text: string;
  lineCount: number;
}

interface DraftImage {
  id: string;
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
  skipNextDraftCapture?: boolean;
  agentPermissionMode: AgentPermissionMode;
  pasteBlocks: PasteBlock[];
  draftImages: DraftImage[];
  nextPasteID: number;
  abort?: AbortController;
}

const states = new WeakMap<Element, PanelState>();

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
      draftText: '',
      draftSelectionStart: 0,
      draftSelectionEnd: 0,
      draftHadFocus: false,
      messagesScrollTop: 0,
      agentPermissionMode: agentPermissionMode(presets[0]),
      pasteBlocks: [],
      draftImages: [],
      nextPasteID: 1,
    };
    states.set(mount, state);
    void loadPersistedMessages(mount, state);
  } else {
    state.presets = loadPresets(zoteroPrefs());
    if (state.selectedId && !state.presets.find((p) => p.id === state!.selectedId)) {
      state.selectedId = state.presets[0]?.id ?? null;
    }
    if (state.presets.length === 0) state.editing = true;
    state.agentPermissionMode = agentPermissionMode(selectedChatPreset(state) ?? selectedPreset(state));
  }

  renderPanel(mount, state);
}

function renderPanel(mount: HTMLElement, state: PanelState) {
  const doc = mount.ownerDocument!;
  capturePanelState(mount, state);
  refreshActiveReaderSelection(doc.defaultView, state.itemID, false);
  mount.replaceChildren();

  const panel = el(doc, 'div', 'zai-app native-panel');
  panel.append(renderToolbar(doc, mount, state));
  if (state.editing || state.presets.length === 0) {
    panel.append(renderPresetEditor(doc, mount, state));
  }
  panel.append(renderContextCard(doc, state.itemID));
  if (state.messages.length === 0) {
    panel.append(renderQuickPrompts(doc, mount, state));
  }
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

function capturePanelState(mount: HTMLElement, state: PanelState) {
  if (!state.skipNextDraftCapture) {
    const input = mount.querySelector('.input-row textarea') as HTMLTextAreaElement | null;
    if (input) {
      captureDraftFromInput(input, state);
    }
  }
  state.skipNextDraftCapture = false;

  const messages = mount.querySelector('.messages') as HTMLElement | null;
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
  state.draftSelectionStart = clampOffset(input.selectionStart ?? input.value.length, input.value);
  state.draftSelectionEnd = clampOffset(
    input.selectionEnd ?? state.draftSelectionStart,
    input.value,
  );
  if (captureFocus) {
    state.draftHadFocus = input.ownerDocument?.activeElement === input;
  }
}

function renderToolbar(doc: Document, mount: HTMLElement, state: PanelState) {
  const toolbarPresets = state.editing ? state.presets : configuredPresets(state);
  const selectedForToolbar = state.editing ? selectedPreset(state) : selectedChatPreset(state);
  const bar = el(doc, 'div', toolbarPresets.length ? 'preset-switcher' : 'preset-empty');
  const title = el(doc, 'strong', '', 'AI 对话');
  bar.append(title);

  if (toolbarPresets.length === 0) {
    bar.append(el(doc, 'span', '', '未配置模型'));
    const button = buttonEl(doc, '添加模型');
    button.addEventListener('click', () => {
      state.editing = true;
      renderPanel(mount, state);
    });
    bar.append(button);
    return bar;
  }

  const select = doc.createElement('select');
  select.value = selectedForToolbar?.id ?? '';
  for (const preset of toolbarPresets) {
    const option = doc.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.label} (${preset.provider} · ${preset.model || 'no model'})`;
    select.append(option);
  }
  select.addEventListener('change', () => {
    state.selectedId = select.value;
    state.editing = false;
    state.agentPermissionMode = agentPermissionMode(selectedChatPreset(state) ?? selectedPreset(state));
    renderPanel(mount, state);
  });
  bar.append(select);

  const settings = buttonEl(doc, state.editing ? '收起' : '设置');
  settings.addEventListener('click', () => {
    state.editing = !state.editing;
    renderPanel(mount, state);
  });
  if (state.messages.length > 0) {
    const copyAll = buttonEl(doc, '复制MD');
    copyAll.title = '复制当前对话为 Markdown';
    copyAll.addEventListener('click', () => {
      void copyToClipboard(doc, formatConversationMarkdown(state));
      flashButton(copyAll, '已复制');
    });
    bar.append(copyAll);

    const clear = buttonEl(doc, '清空');
    clear.disabled = state.sending;
    clear.title = '清空并保存当前条目的聊天记录';
    clear.addEventListener('click', () => {
      state.messages = [];
      void saveChatMessages(state.itemID, state.messages);
      renderPanel(mount, state);
    });
    bar.append(clear);
  }
  bar.append(settings);
  const hide = buttonEl(doc, '隐藏');
  hide.title = '隐藏 AI 对话列';
  hide.addEventListener('click', () => hideCurrentSidebar(mount));
  bar.append(hide);
  return bar;
}

function renderPresetEditor(doc: Document, mount: HTMLElement, state: PanelState) {
  let current = selectedPreset(state);
  if (!current) {
    current = makePreset('openai');
    state.presets = [...state.presets, current];
    state.selectedId = current.id;
  }
  const draft = current;
  const box = el(doc, 'div', 'preset-edit native-preset-edit');

  const provider = selectEl(doc, [
    ['openai', 'OpenAI 兼容'],
    ['anthropic', 'Anthropic'],
  ]);
  provider.value = draft.provider;
  const label = inputEl(doc, draft.label);
  const apiKey = inputEl(doc, draft.apiKey, 'password');
  const baseUrl = inputEl(doc, draft.baseUrl || DEFAULT_BASE_URLS[draft.provider]);
  const model = inputEl(doc, draft.model || DEFAULT_MODELS[draft.provider]);
  const modelListId = `zai-models-${makeId()}`;
  model.setAttribute('list', modelListId);
  const maxTokens = inputEl(doc, String(draft.maxTokens || 8192), 'number');
  const reasoningEffort = selectEl(doc, REASONING_EFFORT_OPTIONS);
  reasoningEffort.value = draft.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  reasoningEffort.disabled = draft.provider !== 'openai';
  const reasoningSummary = selectEl(doc, REASONING_SUMMARY_OPTIONS);
  reasoningSummary.value = draft.extras?.reasoningSummary ?? DEFAULT_REASONING_SUMMARY;
  reasoningSummary.disabled = draft.provider !== 'openai';
  const modelList = doc.createElement('datalist');
  modelList.id = modelListId;
  for (const suggestion of MODEL_SUGGESTIONS[draft.provider]) {
    const option = doc.createElement('option');
    option.value = suggestion;
    modelList.append(option);
  }

  const readDraft = (): ModelPreset => {
    const providerKind = provider.value as ProviderKind;
    return {
      id: current.id,
      provider: providerKind,
      label: label.value.trim() || (providerKind === 'anthropic' ? 'Claude' : 'GPT'),
      apiKey: apiKey.value.trim(),
      baseUrl: baseUrl.value.trim() || DEFAULT_BASE_URLS[providerKind],
      model: model.value.trim() || DEFAULT_MODELS[providerKind],
      maxTokens: parseInt(maxTokens.value, 10) || 8192,
      extras: providerKind === 'openai'
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

  provider.addEventListener('change', () => {
    const nextProvider = provider.value as ProviderKind;
    label.value = label.value || (nextProvider === 'anthropic' ? 'Claude' : 'GPT');
    if (!baseUrl.value || Object.values(DEFAULT_BASE_URLS).includes(baseUrl.value)) {
      baseUrl.value = DEFAULT_BASE_URLS[nextProvider];
    }
    if (!model.value || Object.values(DEFAULT_MODELS).includes(model.value)) {
      model.value = DEFAULT_MODELS[nextProvider];
    }
    reasoningEffort.disabled = nextProvider !== 'openai';
    reasoningSummary.disabled = nextProvider !== 'openai';
    if (nextProvider === 'openai' && !reasoningEffort.value) {
      reasoningEffort.value = DEFAULT_REASONING_EFFORT;
    }
    if (nextProvider === 'openai' && !reasoningSummary.value) {
      reasoningSummary.value = DEFAULT_REASONING_SUMMARY;
    }
    modelList.replaceChildren();
    for (const suggestion of MODEL_SUGGESTIONS[nextProvider]) {
      const option = doc.createElement('option');
      option.value = suggestion;
      modelList.append(option);
    }
    syncDraft();
  });

  for (const control of [label, apiKey, baseUrl, model, maxTokens]) {
    control.addEventListener('input', syncDraft);
  }
  reasoningEffort.addEventListener('change', syncDraft);
  reasoningSummary.addEventListener('change', syncDraft);

  box.append(
    field(doc, 'Provider', provider),
    field(doc, '名称', label),
    field(doc, 'API Key', apiKey),
    field(doc, 'Base URL', baseUrl),
    field(doc, 'Model ID', model),
    field(doc, 'Max tokens', maxTokens),
    field(doc, 'Reasoning', reasoningEffort),
    field(doc, 'Summary', reasoningSummary),
    modelList,
  );

  const buttons = el(doc, 'div', 'add-buttons');
  const save = buttonEl(doc, '保存预设');
  save.addEventListener('click', () => {
    syncDraft();
    state.editing = false;
    renderPanel(mount, state);
  });
  buttons.append(save);

  for (const kind of ['openai', 'anthropic'] as ProviderKind[]) {
    const add = buttonEl(doc, kind === 'openai' ? '+ OpenAI' : '+ Anthropic');
    add.addEventListener('click', () => {
      const preset = makePreset(kind);
      state.presets = [...state.presets, preset];
      state.selectedId = preset.id;
      state.editing = true;
      renderPanel(mount, state);
    });
    buttons.append(add);
  }

  if (current) {
    const remove = buttonEl(doc, '删除当前');
    remove.addEventListener('click', () => {
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
  const title = item?.getField('title') || '未选择条目';
  const card = el(doc, 'div', 'ctx-card');
  card.append(
    el(doc, 'div', 'ctx-title', title),
    el(doc, 'div', 'ctx-meta', `Item ID: ${itemID ?? 'none'}`),
  );
  return card;
}

function renderQuickPrompts(doc: Document, mount: HTMLElement, state: PanelState) {
  const prompts = [
    ['总结', '请用中文总结这篇论文：研究问题、方法、主要结论。'],
    ['贡献', '请提炼这篇论文的核心贡献、创新点和适用场景。'],
    ['方法', '请解释这篇论文的方法流程，并列出关键公式或算法步骤。'],
    ['局限', '请分析这篇论文的局限性、可能的反例和后续改进方向。'],
  ];
  const box = el(doc, 'div', 'quick-prompts');
  for (const [label, prompt] of prompts) {
    const button = buttonEl(doc, label);
    button.disabled = state.sending;
    button.addEventListener('click', () => void sendMessage(mount, state, prompt));
    box.append(button);
  }
  return box;
}

function renderMessages(doc: Document, mount: HTMLElement, state: PanelState) {
  const messages = el(doc, 'div', 'messages');
  if (state.messages.length === 0) {
    const hint = el(doc, 'div', 'bubble bubble-assistant bubble-hint');
    hint.append(
      el(doc, 'div', 'bubble-role', 'AI'),
      el(doc, 'div', 'bubble-body', '已就绪。配置模型预设后，可以直接询问当前 Zotero 条目或 PDF 内容。'),
    );
    messages.append(hint);
    return messages;
  }

  state.messages.forEach((message, index) => messages.append(bubble(doc, mount, state, message, index)));
  return messages;
}

function renderInput(doc: Document, mount: HTMLElement, state: PanelState) {
  const composer = el(doc, 'div', 'composer');
  const row = el(doc, 'div', 'input-row');
  const input = doc.createElement('textarea');
  input.rows = 3;
  const status = el(doc, 'div', 'composer-status');

  const preset = selectedChatPreset(state);
  const ready = !!preset?.apiKey && !!preset.model && !state.sending;
  input.placeholder = preset
    ? state.sending
      ? '可以先写下一条，当前回复结束后再发送'
      : '问点什么... (Enter 发送，Shift+Enter 换行)'
    : '先添加一个模型预设。';
  input.disabled = !preset;
  input.value = state.draftText;
  input.style.height = 'auto';

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    const shouldSend =
      !state.sending &&
      event.key === 'Enter' &&
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
  for (const event of ['input', 'select', 'click', 'keyup', 'focus']) {
    input.addEventListener(event, () => updateStatus());
  }
  input.addEventListener('paste', (event: ClipboardEvent) => {
    const imageFiles = pastedImageFiles(event);
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addDraftImages(input.ownerDocument!, state, imageFiles).then(() => {
        updateStatus();
        renderPanel(mount, state);
      });
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!shouldCompactPastedText(text)) return;
    event.preventDefault();
    insertPastedTextMarker(input, state, text);
    updateStatus();
  });
  updateStatus(false);
  afterRender(mount, () => updateStatus(false));

  row.append(input);

  if (state.sending) {
    const stop = buttonEl(doc, '停止');
    stop.addEventListener('click', () => {
      state.abort?.abort();
      state.sending = false;
      renderPanel(mount, state);
    });
    row.append(stop);
    composer.append(
      renderComposerContextChips(doc, mount, state),
      row,
      renderDraftImages(doc, mount, state),
      renderComposerFooter(doc, mount, state, status),
    );
    return composer;
  }

  const send = buttonEl(doc, '发送');
  send.disabled = !ready;
  send.title = preset && !ready ? '请先填写 API Key 和 Model ID' : '';
  send.addEventListener('click', () => void sendMessage(mount, state, expandPasteMarkers(input.value, state)));
  row.append(send);
  composer.append(
    renderComposerContextChips(doc, mount, state),
    row,
    renderDraftImages(doc, mount, state),
    renderComposerFooter(doc, mount, state, status),
  );
  return composer;
}

function renderComposerContextChips(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
): HTMLElement {
  const selectedText = getStoredSelectedText(state.itemID);
  const row = el(doc, 'div', selectedText ? 'composer-context-row' : 'composer-context-row is-empty');
  if (!selectedText) return row;

  const chip = el(doc, 'div', 'composer-context-chip');
  chip.title = selectedText;
  chip.append(
    el(doc, 'span', 'composer-context-icon', '▣'),
    el(doc, 'span', 'composer-context-name', `PDF 选区 ${selectedText.length} 字`),
  );
  const preview = selectedText.length > 42 ? `${selectedText.slice(0, 42)}…` : selectedText;
  chip.append(el(doc, 'span', 'composer-context-preview', preview));
  const remove = buttonEl(doc, '×');
  remove.title = '本轮不带入这个 PDF 选区';
  remove.addEventListener('click', () => {
    ignoreSelectedTextForPrompt(mount, state.itemID);
    renderPanel(mount, state);
  });
  chip.append(remove);
  row.append(chip);
  return row;
}

function renderDraftImages(doc: Document, mount: HTMLElement, state: PanelState): HTMLElement {
  const tray = el(doc, 'div', state.draftImages.length ? 'draft-images' : 'draft-images is-empty');
  for (const image of state.draftImages) {
    const item = el(doc, 'div', 'draft-image');
    const img = doc.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name;
    const remove = buttonEl(doc, '×');
    remove.title = '移除截图';
    remove.addEventListener('click', () => {
      state.draftImages = state.draftImages.filter((candidate) => candidate.id !== image.id);
      renderPanel(mount, state);
    });
    item.append(img, el(doc, 'span', '', image.name), remove);
    tray.append(item);
  }
  return tray;
}

function renderComposerFooter(
  doc: Document,
  mount: HTMLElement,
  state: PanelState,
  status: HTMLElement,
): HTMLElement {
  const footer = el(doc, 'div', 'composer-footer');
  footer.append(status, renderYoloToggle(doc, mount, state));
  return footer;
}

function renderYoloToggle(doc: Document, mount: HTMLElement, state: PanelState): HTMLElement {
  const label = el(doc, 'label', 'yolo-toggle');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = state.agentPermissionMode === 'yolo';
  input.addEventListener('change', () => {
    state.agentPermissionMode = input.checked ? 'yolo' : 'default';
    const preset = selectedPreset(state);
    if (preset) {
      upsertPreset(state, withAgentPermissionMode(preset, state.agentPermissionMode));
      persist(state);
    }
    renderPanel(mount, state);
  });
  label.append(el(doc, 'span', 'yolo-toggle-text', 'YOLO'), input, el(doc, 'span', 'yolo-toggle-track'));
  label.title = state.agentPermissionMode === 'yolo'
    ? 'YOLO：本地工具无需审批直接执行'
    : 'Default：需要审批的本地工具会被拦截';
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
    const node = doc.createElement('span');
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
  const selected = Math.abs((input.selectionEnd ?? 0) - (input.selectionStart ?? 0));
  const parts: InputStatusPart[] = [{ text: `Ln ${cursor.line}, Col ${cursor.column}` }];
  if (selected > 0) {
    parts.push({ text: `${selected} selected`, className: 'composer-status-badge' });
  }
  if (state.pasteBlocks.length > 0) {
    const lines = state.pasteBlocks.reduce((sum, block) => sum + block.lineCount, 0);
    parts.push({
      text: `Pasted ${state.pasteBlocks.length} (+${lines} lines)`,
      className: 'composer-status-badge',
    });
  }
  if (state.draftImages.length > 0) {
    parts.push({
      text: `Images ${state.draftImages.length}`,
      className: 'composer-status-badge composer-status-badge-image',
    });
  }
  return parts;
}

function cursorPosition(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function clampOffset(offset: number, text: string): number {
  return Math.max(0, Math.min(offset, text.length));
}

function autoResizeInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  const maxHeight = 180;
  const next = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function shouldCompactPastedText(text: string): boolean {
  return countLines(text) > 5 || text.length > 900;
}

function insertPastedTextMarker(input: HTMLTextAreaElement, state: PanelState, text: string) {
  const id = state.nextPasteID++;
  const lineCount = countLines(text);
  const marker = `[Pasted text #${id} +${lineCount} lines]`;
  state.pasteBlocks.push({ id, marker, text, lineCount });

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n' : '';
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
    if (!item.type || !item.type.toLowerCase().startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

async function addDraftImages(
  doc: Document,
  state: PanelState,
  files: File[],
) {
  for (const file of files) {
    const dataUrl = await fileToDataUrl(doc, file);
    state.draftImages.push({
      id: `image-${Date.now()}-${state.nextPasteID++}`,
      name: file.name || `Screenshot ${state.draftImages.length + 1}`,
      mediaType: file.type || 'image/png',
      dataUrl,
      size: file.size,
    });
  }
}

function fileToDataUrl(doc: Document, file: File): Promise<string> {
  const Reader = doc.defaultView?.FileReader ?? FileReader;
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Failed to read image')));
    reader.readAsDataURL(file);
  });
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

async function sendMessage(mount: HTMLElement, state: PanelState, text: string) {
  const content = text.trim();
  const preset = selectedChatPreset(state);
  const images = state.draftImages.map((image) => ({ ...image }));
  if ((!content && images.length === 0) || !preset || state.sending) return;
  await ensureHistoryLoaded(mount, state);
  if (states.get(mount) !== state) return;
  if (!preset.apiKey || !preset.model) {
    state.editing = true;
    renderPanel(mount, state);
    return;
  }

  const history = state.messages.slice();
  const selectedText = getSelectedTextForPrompt(mount, state.itemID);
  const userMessage: Message = {
    role: 'user',
    content,
    ...(images.length ? { images } : {}),
    ...(selectedText ? { context: { selectedText } } : {}),
  };
  state.messages.push(userMessage);
  state.draftText = '';
  state.draftSelectionStart = 0;
  state.draftSelectionEnd = 0;
  state.draftHadFocus = true;
  state.skipNextDraftCapture = true;
  state.pasteBlocks = [];
  state.draftImages = [];
  void saveChatMessages(state.itemID, state.messages);
  await streamAssistant(mount, state, history, userMessage);
}

async function streamAssistant(
  mount: HTMLElement,
  state: PanelState,
  history: Message[],
  userMessage: Message,
) {
  const preset = selectedChatPreset(state);
  if (!preset || state.sending) return;

  state.sending = true;
  state.scrollToBottom = true;
  state.focusInput = true;
  renderPanel(mount, state);
  const assistantIndex = state.messages.length;
  const assistant: Message = { role: 'assistant', content: '' };
  state.messages.push(assistant);
  state.scrollToBottom = true;
  state.focusInput = true;
  renderPanel(mount, state);

  const controllerCtor = mount.ownerDocument!.defaultView!.AbortController;
  const controller = new controllerCtor();
  state.abort = controller;

  try {
    const contextLedger = formatContextLedger(history);
    if (userMessage.context?.selectedText) {
      userMessage.context = {
        ...userMessage.context,
        planMode: 'selected_text',
        plannerSource: 'selected',
        planReason: '用户当前选中了 PDF 文本，直接作为显式上下文发送',
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
    const baseContext = await buildSystemContextOnly(state.itemID, contextLedger);
    const tools = createZoteroAgentTools({
      source: zoteroContextSource,
      itemID: state.itemID,
      policy: contextPolicy,
      selectionAnnotation: () => getStoredSelectionAnnotation(state.itemID),
    });
    renderPanel(mount, state);

    const messagesForApi: Message[] = toApiMessages([...history, userMessage], {
      message: userMessage,
    }, contextPolicy);

    for await (const chunk of getProvider(preset).stream(
      messagesForApi,
      baseContext.systemPrompt,
      preset,
      controller.signal,
      {
        tools,
        maxToolIterations: contextPolicy.maxToolIterations,
        permissionMode: state.agentPermissionMode,
      },
    )) {
      if (chunk.type === 'text_delta') {
        assistant.content += chunk.text;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === 'thinking_delta') {
        assistant.thinking = `${assistant.thinking ?? ''}${chunk.text}`;
        updateMessageBubble(mount, assistantIndex, assistant);
      } else if (chunk.type === 'tool_call') {
        recordToolCall(userMessage, chunk);
        void saveChatMessages(state.itemID, state.messages);
        renderPanel(mount, state);
      } else if (chunk.type === 'error') {
        assistant.content += `\n[Error] ${chunk.message}`;
        updateMessageBubble(mount, assistantIndex, assistant);
        break;
      }
    }
  } catch (err) {
    assistant.content += `\n[Error] ${err instanceof Error ? err.message : String(err)}`;
    updateMessageBubble(mount, assistantIndex, assistant);
  } finally {
    state.sending = false;
    state.abort = undefined;
    void saveChatMessages(state.itemID, state.messages);
    state.scrollToBottom = true;
    state.focusInput = true;
    renderPanel(mount, state);
  }
}

async function buildSystemContextOnly(
  itemID: number | null,
  contextLedger: string,
): Promise<{ systemPrompt: string }> {
  const ctx = await buildContext(zoteroContextSource, itemID, 0);
  return { systemPrompt: contextAwareSystemPrompt(ctx.systemPrompt, contextLedger) };
}

function contextAwareSystemPrompt(systemPrompt: string, contextLedger: string): string {
  return `${systemPrompt}\n\nAgent policy: You can call local Zotero tools to read the current item metadata, PDF annotations, targeted PDF passages, exact PDF ranges, or the full PDF. You can also call permission-aware Zotero write tools when the user explicitly asks to save a note or annotation. Decide which tool is needed; the local harness only executes tools and enforces budgets. Use only currently attached context or tool output for paper-specific claims. The ledger below records previous Zotero context that may no longer be visible; do not treat it as available source text.\n\nPreviously sent context ledger (not currently attached):\n${contextLedger}`;
}

function recordToolCall(
  message: Message,
  chunk: {
    name: string;
    status: 'started' | 'completed' | 'error';
    summary?: string;
    context?: Message['context'];
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
  if (chunk.status !== 'started') {
    for (let index = nextTools.length - 1; index >= 0; index--) {
      const tool = nextTools[index];
      if (tool.name === chunk.name && tool.status === 'started') {
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

async function regenerateLastResponse(mount: HTMLElement, state: PanelState) {
  if (state.sending) return;
  await ensureHistoryLoaded(mount, state);
  if (states.get(mount) !== state) return;

  const assistantIndex = findLastAssistantIndex(state.messages);
  if (assistantIndex < 0) return;
  const userIndex = findPreviousUserIndex(state.messages, assistantIndex);
  if (userIndex < 0) return;

  const userMessage = state.messages[userIndex];
  const history = state.messages.slice(0, userIndex);
  state.messages = [...history, userMessage];
  void saveChatMessages(state.itemID, state.messages);
  await streamAssistant(mount, state, history, userMessage);
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

function getSelectedTextForPrompt(mount: HTMLElement, itemID: number | null): string {
  const win = mount.ownerDocument?.defaultView;
  return refreshActiveReaderSelection(win, itemID, false) || getStoredSelectedText(itemID);
}

function getStoredSelectedText(itemID: number | null): string {
  if (itemID == null) return '';
  const text = selectedTextByItem.get(itemID) ?? '';
  return text && ignoredSelectedTextByItem.get(itemID) !== text ? text : '';
}

function getStoredSelectionAnnotation(itemID: number | null): SelectionAnnotationDraft | null {
  if (itemID == null) return null;
  const draft = selectedAnnotationByItem.get(itemID) ?? null;
  return draft && ignoredSelectedTextByItem.get(itemID) !== draft.text ? draft : null;
}

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
    return shouldIgnoreSelectedText(ids, text) ? '' : text;
  }
  if (clearWhenEmpty) {
    clearStoredSelectedText(ids);
    return '';
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
      if (sidebar) updateSelectionIndicators(sidebar.mount, getSelectedItemID(win));
    }
  };
  readerAPI.registerEventListener(
    'renderTextSelectionPopup',
    readerSelectionHandler,
    addon.data.config.addonID,
  );
}

function unregisterReaderSelectionCapture() {
  const readerAPI = (Zotero as any).Reader;
  if (!readerSelectionHandler || !readerAPI?.unregisterEventListener) return;
  readerAPI.unregisterEventListener('renderTextSelectionPopup', readerSelectionHandler);
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

function updateSelectionIndicators(mount: HTMLElement, itemID: number | null) {
  const state = states.get(mount);
  const input = mount.querySelector('.input-row textarea') as HTMLTextAreaElement | null;
  const status = mount.querySelector('.composer-status') as HTMLElement | null;
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

function firstStoredSelectedText(ids: number[]): string {
  for (const id of ids) {
    const text = selectedTextByItem.get(id);
    if (text) return text;
  }
  return '';
}

function firstUsableStoredSelectedText(ids: number[]): string {
  for (const id of ids) {
    const text = selectedTextByItem.get(id);
    if (text && ignoredSelectedTextByItem.get(id) !== text) return text;
  }
  return '';
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

function ignoreSelectedTextForPrompt(mount: HTMLElement, itemID: number | null) {
  const reader = getActiveReader(mount.ownerDocument?.defaultView);
  const ids = readerItemIDs(reader, itemID);
  const text = firstStoredSelectedText(ids);
  for (const id of ids) {
    if (text) ignoredSelectedTextByItem.set(id, text);
    selectedTextByItem.delete(id);
    selectedAnnotationByItem.delete(id);
  }
}

function readerItemIDs(reader: unknown, fallbackItemID: number | null): number[] {
  const r = reader as {
    itemID?: number;
    _item?: { id?: number; parentID?: number };
  } | null;
  const ids = [fallbackItemID, r?._item?.id, r?._item?.parentID, r?.itemID].filter(
    (id): id is number => typeof id === 'number',
  );
  return [...new Set(ids)];
}

function readerAttachmentID(reader: unknown): number | null {
  const r = reader as {
    itemID?: number;
    _item?: { id?: number };
  } | null;
  return typeof r?._item?.id === 'number'
    ? r._item.id
    : typeof r?.itemID === 'number'
      ? r.itemID
      : null;
}

function getActiveReader(win: Window | null | undefined): any {
  const tabID = (win as any)?.Zotero_Tabs?.selectedID;
  return tabID ? (Zotero as any).Reader?.getByTabID?.(tabID) : null;
}

function safeSelectionText(win: unknown): string {
  try {
    return normalizeSelectedText((win as Window | undefined)?.getSelection?.()?.toString());
  } catch {
    return '';
  }
}

function firstText(values: string[]): string {
  return values.find(Boolean) ?? '';
}

function normalizeSelectedText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > contextPolicy.maxSelectedTextChars
    ? normalized.slice(0, contextPolicy.maxSelectedTextChars)
    : normalized;
}

function updateMessageBubble(mount: HTMLElement, index: number, message: Message) {
  const root = mount.querySelector(`[data-message-index="${index}"]`) as HTMLElement | null;
  const body = root?.querySelector('.bubble-body') as HTMLElement | null;
  if (!root || !body) return;
  const shouldStickToBottom = isMessagesNearBottom(mount);

  if (message.thinking) {
    renderMarkdownInto(ensureThinkingBody(root, body), message.thinking);
  }
  renderMarkdownInto(body, message.content);
  if (shouldStickToBottom) {
    scrollMessagesToBottom(mount);
  }
}

function ensureThinkingBody(root: HTMLElement, before: HTMLElement): HTMLElement {
  const existing = root.querySelector('.bubble-thinking-body') as HTMLElement | null;
  if (existing) return existing;

  const doc = root.ownerDocument!;
  const details = doc.createElement('details');
  details.className = 'bubble-thinking';
  details.open = true;
  const summary = doc.createElement('summary');
  summary.textContent = '思考过程';
  const body = doc.createElement('div');
  body.className = 'bubble-thinking-body';
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

function scrollMessagesToBottom(mount: HTMLElement) {
  const messages = mount.querySelector('.messages') as HTMLElement | null;
  if (!messages) return;
  messages.scrollTop = messages.scrollHeight;
}

function isMessagesNearBottom(mount: HTMLElement): boolean {
  const messages = mount.querySelector('.messages') as HTMLElement | null;
  if (!messages) return true;
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
}

function restoreMessagesScroll(
  mount: HTMLElement,
  state: PanelState,
  scrollToBottom: boolean,
) {
  const messages = mount.querySelector('.messages') as HTMLElement | null;
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
  const input = mount.querySelector('.input-row textarea') as HTMLTextAreaElement | null;
  if (!input || input.disabled) return;
  input.value = state.draftText;
  const start = clampOffset(state.draftSelectionStart, input.value);
  const end = clampOffset(state.draftSelectionEnd, input.value);
  input.selectionStart = start;
  input.selectionEnd = end;
  autoResizeInput(input);

  const status = mount.querySelector('.composer-status') as HTMLElement | null;
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
  const root = el(doc, 'div', `bubble bubble-${message.role}`);
  root.dataset.messageIndex = String(index);
  const head = el(doc, 'div', 'bubble-head');
  head.append(el(doc, 'div', 'bubble-role', message.role === 'user' ? 'You' : 'AI'));

  const actions = el(doc, 'div', 'bubble-actions');
  const copy = buttonEl(doc, '复制');
  copy.addEventListener('click', () => {
    void copyToClipboard(doc, messageToClipboard(message));
    flashButton(copy, '已复制');
  });
  actions.append(copy);

  if (message.role === 'assistant' && index === findLastAssistantIndex(state.messages)) {
    const retry = buttonEl(doc, '重试');
    retry.disabled = state.sending;
    retry.addEventListener('click', () => void regenerateLastResponse(mount, state));
    actions.append(retry);
  }

  const del = buttonEl(doc, '删除');
  del.disabled = state.sending;
  del.addEventListener('click', () => {
    state.messages = state.messages.filter((_, i) => i !== index);
    void saveChatMessages(state.itemID, state.messages);
    renderPanel(mount, state);
  });
  actions.append(del);
  head.append(actions);

  root.append(head);
  if (message.role === 'user') {
    renderMessageImages(doc, root, message.images);
  }
  if (message.role === 'assistant') {
    renderAssistantProcess(doc, root, state.messages[findPreviousUserIndex(state.messages, index)]);
  }
  if (message.role === 'assistant' && message.thinking) {
    const details = el(doc, 'details', 'bubble-thinking') as HTMLDetailsElement;
    details.open = true;
    details.append(
      el(doc, 'summary', '', '思考过程'),
    );
    const thinkingBody = el(doc, 'div', 'bubble-thinking-body');
    renderMarkdownInto(thinkingBody, message.thinking);
    details.append(thinkingBody);
    root.append(details);
  }
  const body = el(doc, 'div', 'bubble-body');
  renderMarkdownInto(body, message.content);
  root.append(body);
  return root;
}

function renderAssistantProcess(
  doc: Document,
  root: HTMLElement,
  sourceUser: Message | undefined,
) {
  if (!sourceUser?.context) return;

  const summary = contextSummaryLine(sourceUser);
  const tools = sourceUser.context.toolCalls;
  if (!summary && !tools?.length) return;

  const details = el(doc, 'details', 'assistant-process') as HTMLDetailsElement;
  details.open = true;
  details.append(el(doc, 'summary', '', summary ? `思考与上下文 · ${summary}` : '思考与上下文'));

  const body = el(doc, 'div', 'assistant-process-body');
  if (summary) {
    const chip = el(doc, 'div', 'bubble-context-chip', summary);
    if (sourceUser.context.planReason) chip.title = sourceUser.context.planReason;
    body.append(chip);
  }
  renderToolTrace(doc, body, tools);
  details.append(body);
  root.append(details);
}

function renderMessageImages(
  doc: Document,
  root: HTMLElement,
  images: Message['images'] | undefined,
) {
  if (!images?.length) return;
  const tray = el(doc, 'div', 'message-images');
  for (const image of images) {
    const figure = el(doc, 'figure', 'message-image');
    const img = doc.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name;
    const caption = el(doc, 'figcaption', '', image.name);
    figure.append(img, caption);
    tray.append(figure);
  }
  root.append(tray);
}

function renderToolTrace(
  doc: Document,
  root: HTMLElement,
  tools: NonNullable<Message['context']>['toolCalls'] | undefined,
) {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const box = el(doc, 'div', 'bubble-tool-trace');
  for (const tool of tools) {
    const row = el(doc, 'div', `bubble-tool-row tool-${tool.status}`);
    row.append(
      el(doc, 'span', 'bubble-tool-dot'),
      el(doc, 'span', 'bubble-tool-name', tool.name),
    );
    if (tool.summary) row.append(el(doc, 'span', 'bubble-tool-summary', tool.summary));
    box.append(row);
  }
  root.append(box);
}

function renderMarkdownInto(target: HTMLElement, markdown: string) {
  const doc = target.ownerDocument!;
  target.replaceChildren();
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.split('\n');
  let paragraph: string[] = [];
  let list: HTMLElement | null = null;
  let codeLines: string[] | null = null;
  let codeLanguage = '';

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = doc.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '));
    target.append(p);
    paragraph = [];
  };

  const flushList = () => {
    list = null;
  };

  const appendListItem = (text: string, ordered: boolean) => {
    flushParagraph();
    const tag = ordered ? 'ol' : 'ul';
    if (!list || list.tagName.toLowerCase() !== tag) {
      list = doc.createElement(tag);
      target.append(list);
    }
    const li = doc.createElement('li');
    appendInlineMarkdown(li, text);
    list.append(li);
  };

  const flushCode = () => {
    if (codeLines == null) return;
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    if (codeLanguage) code.className = `language-${codeLanguage}`;
    code.textContent = codeLines.join('\n');
    pre.append(code);
    target.append(pre);
    codeLines = null;
    codeLanguage = '';
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
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

    if (line.startsWith('> ')) {
      flushParagraph();
      flushList();
      const quote = doc.createElement('blockquote');
      appendInlineMarkdown(quote, line.slice(2));
      target.append(quote);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushCode();
  flushParagraph();
}

function appendInlineMarkdown(parent: HTMLElement, text: string) {
  const doc = parent.ownerDocument!;
  let cursor = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf('`', cursor);
    const boldStart = text.indexOf('**', cursor);
    const linkStart = text.indexOf('[', cursor);
    const starts = [codeStart, boldStart, linkStart].filter((index) => index >= 0);
    const next = starts.length ? Math.min(...starts) : -1;

    if (next < 0) {
      parent.append(doc.createTextNode(text.slice(cursor)));
      return;
    }
    if (next > cursor) {
      parent.append(doc.createTextNode(text.slice(cursor, next)));
    }

    if (next === codeStart) {
      const end = text.indexOf('`', next + 1);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const code = doc.createElement('code');
      code.textContent = text.slice(next + 1, end);
      parent.append(code);
      cursor = end + 1;
      continue;
    }

    if (next === boldStart) {
      const end = text.indexOf('**', next + 2);
      if (end < 0) {
        parent.append(doc.createTextNode(text.slice(next)));
        return;
      }
      const strong = doc.createElement('strong');
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
    const anchor = doc.createElement('a');
    anchor.href = link.href;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    appendInlineMarkdown(anchor, link.label);
    parent.append(anchor);
    cursor = link.end;
  }
}

function markdownHeadingLevel(line: string): number {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  return level > 0 && level <= 4 && line[level] === ' ' ? level : 0;
}

function unorderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) return trimmed.slice(2).trim();
  return null;
}

function orderedListText(line: string): string | null {
  const trimmed = trimListIndent(line);
  let index = 0;
  while (index < trimmed.length && isDigit(trimmed[index])) index++;
  if (index === 0 || trimmed[index] !== '.' || trimmed[index + 1] !== ' ') return null;
  return trimmed.slice(index + 2).trim();
}

function trimListIndent(line: string): string {
  let index = 0;
  while (line[index] === ' ' || line[index] === '\t') index++;
  return line.slice(index);
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function parseMarkdownLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  const closeLabel = text.indexOf(']', start + 1);
  if (closeLabel < 0 || text[closeLabel + 1] !== '(') return null;
  const closeHref = text.indexOf(')', closeLabel + 2);
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
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

function findPreviousUserIndex(messages: Message[], fromIndex: number): number {
  for (let i = fromIndex - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

async function copyToClipboard(doc: Document, text: string) {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  const root = doc.body ?? doc.documentElement;
  if (!root) return;
  root.append(textarea);
  textarea.select();
  doc.execCommand('copy');
  textarea.remove();
}

function flashButton(button: HTMLButtonElement, text: string) {
  const original = button.textContent || '';
  button.textContent = text;
  button.disabled = true;
  button.ownerDocument?.defaultView?.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 900);
}

function messageToClipboard(message: Message): string {
  if (message.role === 'user') {
    return [
      formatUserMessageForApi(message),
      formatImageAttachmentSummary(message),
    ].filter(Boolean).join('\n\n');
  }
  if (!message.thinking) return message.content;
  return `## 思考过程\n${message.thinking}\n\n## 回答\n${message.content}`;
}

function formatConversationMarkdown(state: PanelState): string {
  const item = state.itemID == null ? null : Zotero.Items.get(state.itemID);
  const title = item?.getField('title') || '未选择条目';
  const lines = [
    `# Zotero AI Chat - ${title}`,
    '',
    `- Item ID: ${state.itemID ?? 'none'}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
  ];

  for (const message of state.messages) {
    lines.push(`## ${message.role === 'user' ? 'You' : 'AI'}`, '');
    lines.push(...formatContextMarkdown(message));
    const imageSummary = formatImageAttachmentSummary(message);
    if (imageSummary) lines.push(imageSummary, '');
    if (message.thinking) {
      lines.push('### 思考过程', '', message.thinking, '');
    }
    lines.push(message.content, '');
  }

  return lines.join('\n');
}

function formatImageAttachmentSummary(message: Message): string {
  if (!message.images?.length) return '';
  const lines = ['### 截图附件'];
  message.images.forEach((image, index) => {
    lines.push(
      `- ${index + 1}. ${image.name} (${image.mediaType}, ${formatBytes(image.size)})`,
    );
  });
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function selectedPreset(state: PanelState): ModelPreset | null {
  return state.presets.find((p) => p.id === state.selectedId) ?? state.presets[0] ?? null;
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

function agentPermissionMode(preset: ModelPreset | null | undefined): AgentPermissionMode {
  return preset?.extras?.agentPermissionMode === 'yolo' ? 'yolo' : 'default';
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
  state.presets = index >= 0
    ? state.presets.map((p) => (p.id === next.id ? next : p))
    : [...state.presets, next];
}

function updateToolbarOption(mount: HTMLElement, preset: ModelPreset) {
  const option = Array.from(mount.querySelectorAll('.preset-switcher option')).find(
    (node) => (node as HTMLOptionElement).value === preset.id,
  ) as HTMLOptionElement | undefined;
  if (option) {
    option.textContent = `${preset.label} (${preset.provider} · ${preset.model || 'no model'})`;
  }
}

function updateSendControls(mount: HTMLElement, state: PanelState) {
  const preset = selectedChatPreset(state);
  const ready = !!preset?.apiKey && !!preset.model && !state.sending;
  const textarea = mount.querySelector('.input-row textarea') as HTMLTextAreaElement | null;
  const button = mount.querySelector('.input-row button') as HTMLButtonElement | null;
  if (textarea) {
    textarea.disabled = !preset;
  }
  if (button && button.textContent === '发送') {
    button.disabled = !ready;
    button.title = preset && !ready ? '请先填写 API Key 和 Model ID' : '';
  }
}

function makePreset(provider: ProviderKind): ModelPreset {
  return {
    id: makeId(),
    provider,
    label: provider === 'anthropic' ? 'Claude' : 'GPT',
    apiKey: '',
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: DEFAULT_MODELS[provider],
    maxTokens: 8192,
    extras: provider === 'openai'
      ? {
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          reasoningSummary: DEFAULT_REASONING_SUMMARY,
          agentPermissionMode: 'default',
        }
      : {
          agentPermissionMode: 'default',
        },
  };
}

function makeId(): string {
  return `preset-${Date.now()}-${Zotero.Utilities.randomString(6)}`;
}

function el(doc: Document, tag: string, className = '', text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function buttonEl(doc: Document, text: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.textContent = text;
  return button;
}

function inputEl(doc: Document, value: string, type = 'text'): HTMLInputElement {
  const input = doc.createElement('input');
  input.type = type;
  input.value = value;
  return input;
}

function selectEl(doc: Document, options: Array<[string, string]>): HTMLSelectElement {
  const select = doc.createElement('select');
  for (const [value, label] of options) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  return select;
}

function field(doc: Document, label: string, control: HTMLElement) {
  const wrapper = el(doc, 'label', 'prefs-field');
  wrapper.append(el(doc, 'span', '', label), control);
  return wrapper;
}

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
  const contextPane = doc.getElementById('zotero-context-pane');
  const parent = contextPane?.parentElement;
  if (!contextPane || !parent) {
    Zotero.debug('[Zotero AI Sidebar] Could not find Zotero pane container');
    return;
  }

  doc.getElementById(SPLITTER_ID)?.remove();
  doc.getElementById(COLUMN_ID)?.remove();

  const splitter = doc.createXULElement('splitter');
  splitter.id = SPLITTER_ID;
  splitter.setAttribute('resizebefore', 'closest');
  splitter.setAttribute('resizeafter', 'closest');
  splitter.setAttribute('collapse', 'after');
  splitter.setAttribute('orient', 'horizontal');
  splitter.append(doc.createXULElement('grippy'));

  const column = doc.createXULElement('vbox');
  column.id = COLUMN_ID;
  column.setAttribute('class', 'zai-column');
  column.setAttribute('width', '380');
  column.setAttribute('zotero-persist', 'width');
  column.addEventListener('wheel', (event: Event) => event.stopPropagation(), { passive: true });

  const link = doc.createElementNS(XHTML_NS, 'link') as HTMLLinkElement;
  link.rel = 'stylesheet';
  link.href = `chrome://${addon.data.config.addonRef}/content/sidebar.css`;

  const mount = doc.createElementNS(XHTML_NS, 'div') as HTMLElement;
  mount.id = ROOT_ID;
  mount.className = 'zai-root-independent';

  column.append(link, mount);
  parent.insertBefore(splitter, contextPane.nextSibling);
  parent.insertBefore(column, splitter.nextSibling);

  const state: WindowSidebarState = { column, splitter, mount };
  splitter.addEventListener('command', () => updateToggleButton(state));
  splitter.addEventListener('mouseup', () => updateToggleButton(state));
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

  renderMount(state.mount, getSelectedItemID(win));
  updateToggleButton(state);
}

function installToggleButton(win: Window, state: WindowSidebarState) {
  const doc = win.document;
  const toolbar = doc.getElementById('zotero-items-toolbar');
  if (!toolbar) return;

  doc.getElementById(TOGGLE_BUTTON_ID)?.remove();

  const button = doc.createXULElement('toolbarbutton');
  button.id = TOGGLE_BUTTON_ID;
  button.setAttribute('class', 'zotero-tb-button zai-toggle-button');
  button.setAttribute('label', 'AI');
  button.setAttribute('tooltiptext', '显示/隐藏 AI 对话');
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/ai-chat.svg`;
  button.setAttribute('image', icon);
  button.setAttribute('style', `list-style-image: url("${icon}");`);
  button.addEventListener('command', () => {
    setColumnCollapsed(win, state, !isColumnCollapsed(state));
  });

  const spacer = toolbar.querySelector('spacer[flex="1"]');
  toolbar.insertBefore(button, spacer ?? null);
  state.toggleButton = button;
  updateToggleButton(state);
}

function installFloatingToggle(win: Window, state: WindowSidebarState) {
  const doc = win.document;
  const stack = doc.getElementById('zotero-pane-stack') ?? doc.documentElement;
  if (!stack) return;
  doc.getElementById(FLOATING_TOGGLE_ID)?.remove();

  const button = doc.createElementNS(XHTML_NS, 'button') as HTMLButtonElement;
  button.id = FLOATING_TOGGLE_ID;
  button.className = 'zai-floating-toggle';
  button.type = 'button';
  button.title = '打开/隐藏 AI 对话';

  const icon = doc.createElementNS(XHTML_NS, 'img') as HTMLImageElement;
  icon.src = `chrome://${addon.data.config.addonRef}/content/icons/ai-chat.svg`;
  icon.alt = '';
  const label = doc.createElementNS(XHTML_NS, 'span');
  label.textContent = 'AI';
  button.append(icon, label);

  button.addEventListener('click', () => {
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
    state.column.setAttribute('collapsed', 'true');
    state.splitter.setAttribute('hidden', 'true');
  } else {
    column.collapsed = false;
    splitter.hidden = false;
    state.column.removeAttribute('collapsed');
    state.column.removeAttribute('hidden');
    state.splitter.removeAttribute('hidden');
    state.splitter.removeAttribute('state');
    if (!state.column.getAttribute('width')) {
      state.column.setAttribute('width', '380');
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
  const column = state.column as Element & { collapsed?: boolean; hidden?: boolean };
  return (
    column.collapsed === true ||
    column.hidden === true ||
    state.splitter.getAttribute('state') === 'collapsed' ||
    state.column.getAttribute('collapsed') === 'true' ||
    state.column.getAttribute('hidden') === 'true'
  );
}

function updateToggleButton(state: WindowSidebarState) {
  const collapsed = isColumnCollapsed(state);
  for (const button of [state.toggleButton, state.floatingButton]) {
    if (!button) continue;
    const tooltip = collapsed ? '打开 AI 对话' : '隐藏 AI 对话';
    button.setAttribute('tooltiptext', tooltip);
    button.setAttribute('title', tooltip);
    button.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    button.toggleAttribute('checked', !collapsed);
    button.classList.toggle('is-open', !collapsed);
    if (button === state.floatingButton) {
      button.toggleAttribute('hidden', !collapsed);
    }
  }
}

function patchItemSelection(win: Window, state: WindowSidebarState) {
  const pane = (win as any).ZoteroPane;
  if (typeof pane?.itemSelected !== 'function') return;

  const original = pane.itemSelected;
  const patched = function patchedItemSelected(this: unknown, ...args: unknown[]) {
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
  const pane = (win as any).ZoteroPane;
  const selected = pane?.getSelectedItems?.();
  const item = Array.isArray(selected) ? selected[0] : null;
  const id = item?.id;
  return typeof id === 'number' ? id : null;
}

declare global {
  interface Document {
    createXULElement(tagName: string): Element;
  }
}
