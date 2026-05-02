import { initLocale } from './utils/locale';
import { createZToolkit } from './utils/ztoolkit';
import {
  refreshSidebarPreferences,
  registerSidebar,
  registerSidebarForWindow,
  unregisterSidebar,
  unregisterSidebarForWindow,
} from './modules/sidebar';
import {
  registerPreferences,
  unregisterPreferences,
} from './modules/preferences';
import { getProvider } from './providers/factory';
import type { Message } from './providers/types';
import {
  DEFAULT_QUICK_PROMPT_SETTINGS,
  loadQuickPromptSettings,
  normalizeQuickPromptSettings,
  saveQuickPromptSettings,
  type QuickPromptSettings,
} from './settings/quick-prompts';
import {
  loadPresets,
  normalizePresetList,
  savePresets,
  zoteroPrefs,
} from './settings/storage';
import {
  DEFAULT_TOOL_SETTINGS,
  loadToolSettings,
  normalizeToolSettings,
  saveToolSettings,
  type McpApprovalMode,
  type McpServerSettings,
  type ToolSettings,
  type WebSearchMode,
} from './settings/tool-settings';
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  MODEL_SUGGESTIONS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  REASONING_SUMMARY_OPTIONS,
  type ModelPreset,
  type ProviderKind,
  type ReasoningEffort,
  type ReasoningSummary,
} from './settings/types';
import {
  loadUiSettings,
  normalizeUiSettings,
  saveUiSettings,
  type UiSettings,
} from './settings/ui-settings';
import { pullFromCloud, pushToCloud, testSyncConnection } from './sync';
import {
  loadSyncAccount,
  saveSyncAccount,
  type SyncAccount,
} from './sync/account';

// Plugin lifecycle hooks invoked by `addon/bootstrap.js`.
//
// INVARIANT on startup ordering (each promise gates the next safely):
//   1. initializationPromise — Zotero core data layer is ready (DB, items).
//   2. unlockPromise        — user-facing UI/data is unlocked (no master pw).
//   3. uiReadyPromise       — main window XUL tree exists; safe to inject.
// Skipping any of these crashes the plugin on cold start with "Zotero is
// not ready yet" because we touch DOM and item APIs immediately.
//
// REF: Zotero source `chrome/content/zotero/xpcom/zotero.js` for promise
//      contract; zotero-plugin-template README for hook signatures.
async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Per-window setup BEFORE the global `registerSidebar` so each window
  // has its FTL locale strings and ztoolkit ready by the time the column
  // renders. `registerSidebar` then iterates getMainWindows() again to
  // mount the column DOM in each — it's idempotent (see registerSidebarForWindow).
  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  registerSidebar();
  await registerPreferences();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`);
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`);
  registerSidebarForWindow(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterSidebarForWindow(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterPreferences();
  ztoolkit.unregisterAll();
  unregisterSidebar();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

// Hooks below are kept for the bootstrap.js dispatch table. Preference-load
// events are handled here; other hook bodies stay as placeholders until needed.
async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: unknown },
) {}

async function onPrefsEvent(type: string, data: { [key: string]: unknown }) {
  if (type !== 'load') return;
  const win = data.window as Window | undefined;
  if (!win?.document) return;
  setupPreferencesPane(win);
}

function setupPreferencesPane(win: Window): void {
  const doc = win.document;
  const root = byID<HTMLElement>(doc, 'zotero-ai-sidebar-tool-settings');
  if (!root) return;

  renderPresetSettings(doc);
  renderUiSettings(doc);
  renderPromptSettings(doc);
  renderToolSettings(doc);
  renderSyncSettings(doc);

  if (root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';

  byID<HTMLButtonElement>(doc, 'zai-preset-add-openai')?.addEventListener(
    'click',
    () => {
      const preset = makePreset('openai');
      const presets = [...readPresetControls(doc), preset];
      renderPresetRows(doc, presets);
      openPresetRow(doc, preset.id);
      updatePresetSaveButton(doc);
      setStatus(doc, 'zai-preset-status', '已新增 OpenAI 配置，保存后生效。');
    },
  );
  byID<HTMLButtonElement>(doc, 'zai-preset-add-anthropic')?.addEventListener(
    'click',
    () => {
      const preset = makePreset('anthropic');
      const presets = [...readPresetControls(doc), preset];
      renderPresetRows(doc, presets);
      openPresetRow(doc, preset.id);
      updatePresetSaveButton(doc);
      setStatus(doc, 'zai-preset-status', '已新增 Anthropic 配置，保存后生效。');
    },
  );
  byID<HTMLButtonElement>(doc, 'zai-preset-save')?.addEventListener('click', () => {
    void savePresetControlsWithConnectivity(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-ui-save')?.addEventListener('click', () => {
    saveUiSettings(zoteroPrefs(), readUiSettingsControls(doc));
    renderUiSettings(doc);
    refreshSidebarPreferences();
    setStatus(doc, 'zai-ui-status', '显示设置已保存，侧边栏已刷新。');
    flashButton(byID<HTMLButtonElement>(doc, 'zai-ui-save'), '已保存');
  });

  byID<HTMLButtonElement>(doc, 'zai-custom-prompt-add')?.addEventListener(
    'click',
    () => addCustomPromptRow(doc, { id: makeId('prompt'), label: '', prompt: '' }),
  );
  byID<HTMLButtonElement>(doc, 'zai-prompt-save')?.addEventListener('click', () => {
    savePromptControls(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-prompt-reset')?.addEventListener('click', () => {
    populateBuiltInPromptControls(doc, DEFAULT_QUICK_PROMPT_SETTINGS);
    savePromptControls(doc, '已恢复默认提示词并立即生效。');
  });

  byID<HTMLButtonElement>(doc, 'zai-mcp-add')?.addEventListener('click', () => {
    addMcpRow(doc, {
      id: makeId('mcp'),
      enabled: true,
      serverLabel: 'mcp',
      serverUrl: '',
      allowedTools: [],
      requireApproval: 'never',
    });
  });
  byID<HTMLButtonElement>(doc, 'zai-tool-save')?.addEventListener('click', () => {
    const settings = readToolSettingsControls(doc);
    saveToolSettings(zoteroPrefs(), settings);
    renderToolSettings(doc);
    refreshSidebarPreferences();
    setStatus(doc, 'zai-tool-status', '联网/MCP配置已保存，下一次请求立即使用。');
  });
  byID<HTMLButtonElement>(doc, 'zai-color-save')?.addEventListener('click', () => {
    const settings = readToolSettingsControls(doc);
    saveToolSettings(zoteroPrefs(), settings);
    renderToolSettings(doc);
    refreshSidebarPreferences();
    setStatus(doc, 'zai-tool-status', 'PDF 注释颜色预设已保存，下一次请求立即使用。');
    flashButton(byID<HTMLButtonElement>(doc, 'zai-color-save'), '已保存');
  });
  byID<HTMLButtonElement>(doc, 'zai-tool-reset-color-guide')?.addEventListener('click', () => {
    const settings = readToolSettingsControls(doc);
    saveToolSettings(zoteroPrefs(), {
      ...settings,
      annotationColorGuide: DEFAULT_TOOL_SETTINGS.annotationColorGuide,
    });
    renderToolSettings(doc);
    refreshSidebarPreferences();
    setStatus(doc, 'zai-tool-status', 'PDF 注释颜色预设已恢复默认并立即生效。');
    flashButton(byID<HTMLButtonElement>(doc, 'zai-tool-reset-color-guide'), '已重置');
  });
  byID<HTMLButtonElement>(doc, 'zai-config-export-file')?.addEventListener('click', () => {
    void exportConfigBackupFile(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-config-import-file')?.addEventListener('click', () => {
    void importConfigBackupFile(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-config-generate')?.addEventListener('click', () => {
    generateConfigBackupJson(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-config-copy')?.addEventListener('click', () => {
    void copyConfigBackupJson(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-config-import-text')?.addEventListener('click', () => {
    importConfigBackupFromText(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-config-clear')?.addEventListener('click', () => {
    const area = byID<HTMLTextAreaElement>(doc, 'zai-config-json');
    if (area) area.value = '';
    setStatus(doc, 'zai-config-status', '手动备份文本已清空。');
  });
  byID<HTMLButtonElement>(doc, 'zai-sync-save')?.addEventListener('click', () => {
    const account = readSyncAccountControls(doc);
    saveSyncAccount(zoteroPrefs(), account);
    renderSyncSettings(doc);
    setStatus(doc, 'zai-sync-status', 'WebDAV 账号已保存。');
    flashButton(byID<HTMLButtonElement>(doc, 'zai-sync-save'), '已保存');
  });
  byID<HTMLButtonElement>(doc, 'zai-sync-test')?.addEventListener('click', () => {
    void runSyncTest(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-sync-push')?.addEventListener('click', () => {
    void runSyncPush(doc);
  });
  byID<HTMLButtonElement>(doc, 'zai-sync-pull')?.addEventListener('click', () => {
    void runSyncPull(doc);
  });
}

async function runSyncTest(doc: Document): Promise<void> {
  // Reading from controls (not prefs) lets the user test without first
  // clicking "Save account" — common path for first-time setup.
  const account = readSyncAccountControls(doc);
  setStatus(doc, 'zai-sync-status', '正在测试 WebDAV 连接…');
  const result = await testSyncConnection(account);
  setStatus(doc, 'zai-sync-status', result.message, !result.ok);
  if (result.ok) {
    saveSyncAccount(zoteroPrefs(), account);
    renderSyncSettings(doc);
    flashButton(byID<HTMLButtonElement>(doc, 'zai-sync-test'), '已连接');
  }
}

async function runSyncPush(doc: Document): Promise<void> {
  const account = readSyncAccountControls(doc);
  saveSyncAccount(zoteroPrefs(), account);
  setStatus(doc, 'zai-sync-status', '正在打包并上传到云端…');
  const result = await pushToCloud(zoteroPrefs(), account);
  setStatus(doc, 'zai-sync-status', result.message, !result.ok);
  if (result.ok) {
    renderSyncSettings(doc);
    flashButton(byID<HTMLButtonElement>(doc, 'zai-sync-push'), '已上传');
  }
}

async function runSyncPull(doc: Document): Promise<void> {
  const account = readSyncAccountControls(doc);
  saveSyncAccount(zoteroPrefs(), account);
  const ok = doc.defaultView?.confirm(
    '从云端下载会按时间戳合并对话历史，并直接覆盖本地账号、显示、提示词、联网/MCP 配置。继续？',
  ) ?? true;
  if (!ok) {
    setStatus(doc, 'zai-sync-status', '已取消下载。');
    return;
  }
  setStatus(doc, 'zai-sync-status', '正在从云端下载并应用配置…');
  const result = await pullFromCloud(zoteroPrefs(), account);
  setStatus(doc, 'zai-sync-status', result.message, !result.ok);
  if (result.ok) {
    renderPresetSettings(doc);
    renderUiSettings(doc);
    renderPromptSettings(doc);
    renderToolSettings(doc);
    renderSyncSettings(doc);
    refreshSidebarPreferences();
    flashButton(byID<HTMLButtonElement>(doc, 'zai-sync-pull'), '已下载');
  }
}

const CONFIG_BACKUP_SCHEMA = 'zotero-ai-sidebar.config.v1';

interface ConfigBackup {
  schema: typeof CONFIG_BACKUP_SCHEMA;
  exportedAt: string;
  presets: ModelPreset[];
  uiSettings: UiSettings;
  quickPrompts: QuickPromptSettings;
  toolSettings: ToolSettings;
}

interface ParsedConfigBackup {
  presets?: ModelPreset[];
  uiSettings?: UiSettings;
  quickPrompts?: QuickPromptSettings;
  toolSettings?: ToolSettings;
  sections: string[];
}

function buildConfigBackup(): ConfigBackup {
  return {
    schema: CONFIG_BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    presets: loadPresets(zoteroPrefs()),
    uiSettings: loadUiSettings(zoteroPrefs()),
    quickPrompts: loadQuickPromptSettings(zoteroPrefs()),
    toolSettings: loadToolSettings(zoteroPrefs()),
  };
}

function configBackupJson(): string {
  return JSON.stringify(buildConfigBackup(), null, 2);
}

function configBackupFileName(): string {
  return `zotero-ai-sidebar-config-${new Date().toISOString().slice(0, 10)}.json`;
}

async function exportConfigBackupFile(doc: Document): Promise<void> {
  try {
    const path = await pickConfigBackupFile(doc, 'save');
    if (!path) {
      setStatus(doc, 'zai-config-status', '已取消导出。');
      return;
    }
    await Zotero.File.putContentsAsync(path, configBackupJson());
    setStatus(doc, 'zai-config-status', `配置备份已保存：${path}`);
    flashButton(byID<HTMLButtonElement>(doc, 'zai-config-export-file'), '已导出');
  } catch (err) {
    setStatus(doc, 'zai-config-status', fileErrorMessage('导出失败', err), true);
  }
}

async function importConfigBackupFile(doc: Document): Promise<void> {
  try {
    const path = await pickConfigBackupFile(doc, 'open');
    if (!path) {
      setStatus(doc, 'zai-config-status', '已取消导入。');
      return;
    }
    const contents = await Zotero.File.getContentsAsync(path, 'utf-8');
    if (typeof contents !== 'string') throw new Error('配置文件不是文本内容');
    const raw = contents;
    importConfigBackupRaw(doc, raw, '配置文件', 'zai-config-import-file');
  } catch (err) {
    setStatus(doc, 'zai-config-status', fileErrorMessage('导入失败', err), true);
  }
}

function generateConfigBackupJson(doc: Document): void {
  const area = byID<HTMLTextAreaElement>(doc, 'zai-config-json');
  if (!area) return;
  const backup = buildConfigBackup();
  area.value = JSON.stringify(backup, null, 2);
  area.focus();
  area.select();
  setStatus(
    doc,
    'zai-config-status',
    `已生成配置 JSON：账号 ${backup.presets.length} 个，自定义按钮 ${backup.quickPrompts.customButtons.length} 个。内容可能包含 API Key。`,
  );
  flashButton(byID<HTMLButtonElement>(doc, 'zai-config-generate'), '已生成');
}

async function copyConfigBackupJson(doc: Document): Promise<void> {
  const area = byID<HTMLTextAreaElement>(doc, 'zai-config-json');
  if (!area) return;
  if (!area.value.trim()) generateConfigBackupJson(doc);
  await writeTextToClipboard(doc, area.value);
  setStatus(doc, 'zai-config-status', '配置 JSON 已复制。内容可能包含 API Key。');
  flashButton(byID<HTMLButtonElement>(doc, 'zai-config-copy'), '已复制');
}

function importConfigBackupFromText(doc: Document): void {
  const area = byID<HTMLTextAreaElement>(doc, 'zai-config-json');
  const raw = area?.value.trim() ?? '';
  if (!raw) {
    setStatus(doc, 'zai-config-status', '请先粘贴配置 JSON。', true);
    return;
  }
  importConfigBackupRaw(doc, raw, '文本', 'zai-config-import-text');
}

function importConfigBackupRaw(
  doc: Document,
  raw: string,
  source: string,
  buttonID?: string,
): void {
  const parsed = parseConfigBackup(raw);
  if (typeof parsed === 'string') {
    setStatus(doc, 'zai-config-status', parsed, true);
    return;
  }
  const ok = doc.defaultView?.confirm(
    `导入会覆盖当前已保存的 ${parsed.sections.join('、')} 配置，确定继续？`,
  ) ?? true;
  if (!ok) return;

  if (parsed.presets) savePresets(zoteroPrefs(), parsed.presets);
  if (parsed.uiSettings) saveUiSettings(zoteroPrefs(), parsed.uiSettings);
  if (parsed.quickPrompts) {
    saveQuickPromptSettings(zoteroPrefs(), parsed.quickPrompts);
  }
  if (parsed.toolSettings) saveToolSettings(zoteroPrefs(), parsed.toolSettings);

  renderPresetSettings(doc);
  renderUiSettings(doc);
  renderPromptSettings(doc);
  renderToolSettings(doc);
  refreshSidebarPreferences();
  setStatus(
    doc,
    'zai-config-status',
    `已从${source}导入：${parsed.sections.join('、')}。侧边栏已刷新。`,
  );
  if (buttonID) flashButton(byID<HTMLButtonElement>(doc, buttonID), '已导入');
}

async function pickConfigBackupFile(
  doc: Document,
  mode: 'open' | 'save',
): Promise<string | null> {
  const win = doc.defaultView;
  if (!win?.browsingContext) {
    throw new Error('当前窗口不支持文件选择器');
  }
  const nsFilePicker = Components.interfaces.nsIFilePicker;
  const filePickerClass = (
    Components.classes as unknown as Record<
      string,
      { createInstance(iid: typeof nsFilePicker): nsIFilePicker }
    >
  )['@mozilla.org/filepicker;1'];
  const picker = filePickerClass.createInstance(nsFilePicker);
  picker.init(
    win.browsingContext,
    mode === 'save' ? '导出配置文件' : '导入配置文件',
    mode === 'save' ? nsFilePicker.modeSave : nsFilePicker.modeOpen,
  );
  picker.appendFilter('JSON 配置文件', '*.json');
  picker.appendFilters(nsFilePicker.filterAll ?? 1);
  picker.defaultExtension = 'json';
  if (mode === 'save') picker.defaultString = configBackupFileName();

  const result = await new Promise<nsIFilePicker.ResultCode>((resolve) => {
    picker.open({ done: resolve });
  });
  if (result === nsFilePicker.returnCancel) return null;
  if (mode === 'save') {
    if (result !== nsFilePicker.returnOK && result !== nsFilePicker.returnReplace) {
      return null;
    }
  } else if (result !== nsFilePicker.returnOK) {
    return null;
  }
  return picker.file?.path ?? null;
}

async function writeTextToClipboard(doc: Document, text: string): Promise<void> {
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  const area = doc.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const root = doc.body ?? doc.documentElement;
  if (!root) return;
  root.append(area);
  area.select();
  doc.execCommand('copy');
  area.remove();
}

function fileErrorMessage(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${prefix}：${detail}`;
}

function parseConfigBackup(raw: string): ParsedConfigBackup | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '配置 JSON 解析失败，请检查是否完整复制。';
  }
  if (!isRecord(parsed)) return '配置 JSON 顶层必须是对象。';

  const sections: string[] = [];
  const result: ParsedConfigBackup = { sections };
  if (hasOwn(parsed, 'presets')) {
    if (!Array.isArray(parsed.presets)) return '配置里的 presets 必须是数组。';
    result.presets = normalizePresetList(parsed.presets);
    sections.push('账号');
  }
  if (hasOwn(parsed, 'uiSettings')) {
    if (!isRecord(parsed.uiSettings)) return '配置里的 uiSettings 必须是对象。';
    result.uiSettings = normalizeUiSettings(parsed.uiSettings);
    sections.push('显示');
  }
  if (hasOwn(parsed, 'quickPrompts')) {
    if (!isRecord(parsed.quickPrompts)) return '配置里的 quickPrompts 必须是对象。';
    result.quickPrompts = normalizeQuickPromptSettings(parsed.quickPrompts);
    sections.push('提示词');
  }
  if (hasOwn(parsed, 'toolSettings')) {
    if (!isRecord(parsed.toolSettings)) return '配置里的 toolSettings 必须是对象。';
    result.toolSettings = normalizeToolSettings(parsed.toolSettings);
    sections.push('联网/MCP');
  }
  if (sections.length === 0) {
    return '没有找到可导入的配置段：presets / quickPrompts / toolSettings。';
  }
  return result;
}

function renderPresetSettings(doc: Document): void {
  renderPresetRows(doc, loadPresets(zoteroPrefs()));
  updatePresetSaveButton(doc);
  setStatus(doc, 'zai-preset-status', '已加载账号配置。');
}

function renderUiSettings(doc: Document): void {
  const settings = loadUiSettings(zoteroPrefs());
  setInputValue(doc, 'zai-ui-user-label', settings.userProfile.label);
  setInputValue(doc, 'zai-ui-user-avatar', settings.userProfile.avatar);
  setInputValue(doc, 'zai-ui-assistant-label', settings.assistantProfile.label);
  setInputValue(doc, 'zai-ui-assistant-avatar', settings.assistantProfile.avatar);
  const position = byID<HTMLSelectElement>(doc, 'zai-ui-actions-position');
  if (position) position.value = settings.messageActionsPosition;
  const layout = byID<HTMLSelectElement>(doc, 'zai-ui-actions-layout');
  if (layout) layout.value = settings.messageActionsLayout;
  setStatus(doc, 'zai-ui-status', '已加载显示设置。');
}

function readUiSettingsControls(doc: Document): UiSettings {
  const position = byID<HTMLSelectElement>(doc, 'zai-ui-actions-position');
  const layout = byID<HTMLSelectElement>(doc, 'zai-ui-actions-layout');
  return normalizeUiSettings({
    userProfile: {
      label: byID<HTMLInputElement>(doc, 'zai-ui-user-label')?.value,
      avatar: byID<HTMLInputElement>(doc, 'zai-ui-user-avatar')?.value,
    },
    assistantProfile: {
      label: byID<HTMLInputElement>(doc, 'zai-ui-assistant-label')?.value,
      avatar: byID<HTMLInputElement>(doc, 'zai-ui-assistant-avatar')?.value,
    },
    messageActionsPosition: position?.value,
    messageActionsLayout: layout?.value,
  });
}

function setInputValue(doc: Document, id: string, value: string): void {
  const inputNode = byID<HTMLInputElement>(doc, id);
  if (inputNode) inputNode.value = value;
}

function renderSyncSettings(doc: Document): void {
  const account = loadSyncAccount(zoteroPrefs());
  setInputValue(doc, 'zai-sync-url', account.webdavUrl);
  setInputValue(doc, 'zai-sync-username', account.username);
  setInputValue(doc, 'zai-sync-password', account.password);
  setInputValue(doc, 'zai-sync-folder', account.remoteFolder);
  const meta = byID<HTMLElement>(doc, 'zai-sync-meta');
  if (meta) meta.textContent = formatSyncMeta(account);
}

function readSyncAccountControls(doc: Document): SyncAccount {
  const existing = loadSyncAccount(zoteroPrefs());
  return {
    ...existing,
    webdavUrl: byID<HTMLInputElement>(doc, 'zai-sync-url')?.value ?? existing.webdavUrl,
    username:
      byID<HTMLInputElement>(doc, 'zai-sync-username')?.value ?? existing.username,
    password:
      byID<HTMLInputElement>(doc, 'zai-sync-password')?.value ?? existing.password,
    remoteFolder:
      byID<HTMLInputElement>(doc, 'zai-sync-folder')?.value ?? existing.remoteFolder,
  };
}

function formatSyncMeta(account: SyncAccount): string {
  const parts: string[] = [];
  parts.push(account.lastPushAt ? `上次上传：${account.lastPushAt}` : '上次上传：未上传');
  parts.push(account.lastPullAt ? `上次下载：${account.lastPullAt}` : '上次下载：未下载');
  return parts.join(' · ');
}

function renderPresetRows(doc: Document, presets: ModelPreset[]): void {
  const list = byID<HTMLElement>(doc, 'zai-preset-list');
  if (!list) return;
  list.replaceChildren();
  if (presets.length === 0) {
    list.append(el(doc, 'div', 'zai-pref-help', '还没有模型配置。点击 + OpenAI 或 + Anthropic 新增。'));
    return;
  }
  for (const preset of presets) list.append(presetRow(doc, preset));
  attachPresetDirtyListeners(doc);
  updatePresetSaveButton(doc);
}

function openPresetRow(doc: Document, id: string): void {
  const row = doc.querySelector(
    `.zai-preset-row[data-id="${cssEscape(id)}"]`,
  ) as HTMLDetailsElement | null;
  if (row) row.open = true;
}

function presetRow(doc: Document, preset: ModelPreset): HTMLElement {
  const card = doc.createElement('details');
  card.className = 'zai-subcard zai-preset-row';
  card.dataset.id = preset.id;
  card.open = !preset.apiKey || !preset.model;
  const title = doc.createElement('summary');
  title.className = 'zai-subcard-title zai-preset-summary';
  const main = el(doc, 'span', 'zai-preset-summary-main');
  main.append(
    el(doc, 'strong', '', preset.label || preset.provider),
    el(doc, 'span', 'zai-preset-summary-meta', presetSummary(preset)),
  );
  title.append(main);
  const remove = button(doc, '删除');
  remove.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    card.remove();
  });
  title.append(remove);

  const provider = select(doc, [
    ['openai', 'OpenAI 兼容'],
    ['anthropic', 'Anthropic'],
  ], preset.provider);
  provider.dataset.field = 'provider';
  const label = input(doc, preset.label);
  label.dataset.field = 'label';
  const apiKey = input(doc, preset.apiKey, 'password');
  apiKey.dataset.field = 'apiKey';
  const baseUrl = input(doc, preset.baseUrl);
  baseUrl.dataset.field = 'baseUrl';
  const modelList = createModelListControl(
    doc,
    (preset.models?.length ? preset.models : [preset.model]).filter(Boolean),
    preset.provider,
  );
  const maxTokens = input(doc, String(preset.maxTokens || 8192), 'number');
  maxTokens.dataset.field = 'maxTokens';
  const reasoningSummary = select(doc, REASONING_SUMMARY_OPTIONS, preset.extras?.reasoningSummary ?? DEFAULT_REASONING_SUMMARY);
  reasoningSummary.dataset.field = 'reasoningSummary';

  const syncProvider = () => {
    const isOpenAI = provider.value === 'openai';
    reasoningSummary.disabled = !isOpenAI;
  };
  provider.addEventListener('change', () => {
    const kind = provider.value as ProviderKind;
    if (!label.value.trim()) label.value = kind === 'anthropic' ? 'Claude' : 'GPT';
    if (!baseUrl.value.trim()) baseUrl.value = DEFAULT_BASE_URLS[kind];
    modelList.setProvider(kind);
    if (modelList.models().length === 0 && DEFAULT_MODELS[kind]) {
      modelList.setModels([DEFAULT_MODELS[kind]]);
    }
    syncProvider();
    updatePresetSaveButton(doc);
  });
  syncProvider();

  card.append(
    title,
    grid(doc, [
      ['Provider', provider],
      ['名称', label],
      ['API Key', apiKey],
      ['Base URL', baseUrl],
      ['Models', modelList.element],
      ['Max tokens', maxTokens],
      ['Reasoning Summary', reasoningSummary],
    ]),
  );
  return card;
}

function presetSummary(preset: ModelPreset): string {
  const modelCount = preset.models?.length ?? (preset.model ? 1 : 0);
  const modelText =
    modelCount > 1
      ? `${preset.model || preset.models?.[0]} +${modelCount - 1}`
      : preset.model || '未填写模型';
  const base = preset.baseUrl || DEFAULT_BASE_URLS[preset.provider] || '默认 Base URL';
  return `${preset.provider} · ${modelText} · ${base}`;
}

interface ModelListControl {
  element: HTMLElement;
  models(): string[];
  setModels(models: string[]): void;
  setProvider(provider: ProviderKind): void;
}

function createModelListControl(
  doc: Document,
  initialModels: string[],
  initialProvider: ProviderKind,
): ModelListControl {
  const wrap = el(doc, 'div', 'zai-model-control');
  const selected = el(doc, 'div', 'zai-model-selected');
  const side = el(doc, 'div', 'zai-model-side');
  const hidden = textarea(doc, '');
  hidden.dataset.field = 'models';
  hidden.className = 'zai-model-hidden';

  let provider = initialProvider;
  const currentModels = () => {
    const values: string[] = [];
    selected.querySelectorAll('.zai-model-chip-input').forEach((node: Element) => {
      const value = (node as HTMLInputElement).value.trim();
      if (value) values.push(value);
    });
    return values;
  };

  const sync = () => {
    const models = dedupe(currentModels());
    hidden.value = models.join('\n');
    refreshSuggestions();
    updatePresetSaveButton(doc);
  };

  const addChip = (value: string) => {
    const chip = el(doc, 'span', 'zai-model-chip');
    const model = input(doc, value);
    model.className = 'zai-model-chip-input';
    model.placeholder = '自定义模型 ID';
    model.addEventListener('input', sync);
    const remove = button(doc, '×');
    remove.className = 'zai-model-chip-remove';
    remove.title = '删除此模型';
    remove.addEventListener('click', () => {
      chip.remove();
      sync();
    });
    chip.append(model, remove);
    selected.append(chip);
  };

  const setModels = (models: string[]) => {
    selected.replaceChildren();
    for (const model of dedupe(models)) addChip(model);
    sync();
  };

  const addModel = (model: string) => {
    const trimmed = model.trim();
    if (!trimmed || currentModels().includes(trimmed)) return;
    addChip(trimmed);
    sync();
  };

  const refreshSuggestions = () => {
    side.replaceChildren();
    const customRow = el(doc, 'div', 'zai-model-custom-row');
    const custom = input(doc, '');
    custom.placeholder = '输入自定义模型 ID';
    const addCustom = button(doc, '+ 添加');
    const commitCustom = () => {
      addModel(custom.value);
      custom.value = '';
    };
    addCustom.addEventListener('click', commitCustom);
    custom.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commitCustom();
    });
    customRow.append(custom, addCustom);

    if (provider === 'openai') {
      side.append(el(doc, 'div', 'zai-model-side-title', 'OpenAI 预设模型'));
      const selectedModels = new Set(currentModels());
      const suggestions = el(doc, 'div', 'zai-model-suggestions');
      for (const model of MODEL_SUGGESTIONS.openai) {
        const pick = button(doc, selectedModels.has(model) ? `✓ ${model}` : `+ ${model}`);
        pick.disabled = selectedModels.has(model);
        pick.addEventListener('click', () => addModel(model));
        suggestions.append(pick);
      }
      side.append(suggestions);
    } else {
      side.append(el(doc, 'div', 'zai-model-side-title', '自定义模型'));
    }
    side.append(customRow);
  };

  wrap.append(selected, side, hidden);
  setModels(initialModels);
  return {
    element: wrap,
    models: currentModels,
    setModels,
    setProvider: (nextProvider) => {
      provider = nextProvider;
      refreshSuggestions();
    },
  };
}

function readPresetControls(doc: Document): ModelPreset[] {
  const previous = new Map(loadPresets(zoteroPrefs()).map((preset) => [preset.id, preset]));
  return Array.from(doc.querySelectorAll('.zai-preset-row')).map((row) => {
    const card = row as HTMLElement;
    const provider = controlValue(card, 'provider') === 'anthropic' ? 'anthropic' : 'openai';
    const models = splitList(controlValue(card, 'models'));
    const fallbackModel = DEFAULT_MODELS[provider];
    const model = models[0] || fallbackModel;
    const prior = previous.get(card.dataset.id ?? '');
    const extras = provider === 'openai'
      ? {
          ...(prior?.extras ?? {}),
          reasoningEffort: reasoningEffortValue(prior?.extras?.reasoningEffort),
          reasoningSummary: reasoningSummaryValue(controlValue(card, 'reasoningSummary')),
        }
      : prior?.extras;
    return {
      id: card.dataset.id || makeId('preset'),
      provider,
      label: controlValue(card, 'label') || (provider === 'anthropic' ? 'Claude' : 'GPT'),
      apiKey: controlValue(card, 'apiKey'),
      baseUrl: controlValue(card, 'baseUrl') || DEFAULT_BASE_URLS[provider],
      model,
      models: models.length ? models : model ? [model] : [],
      maxTokens: Number(controlValue(card, 'maxTokens')) || 8192,
      extras,
    };
  });
}

async function savePresetControlsWithConnectivity(doc: Document): Promise<void> {
  const save = byID<HTMLButtonElement>(doc, 'zai-preset-save');
  const previous = loadPresets(zoteroPrefs());
  const rawPresets = readPresetControls(doc).filter(
    (preset) => preset.apiKey || preset.baseUrl || preset.model || preset.models?.length,
  );
  for (const preset of rawPresets) {
    if (!preset.apiKey.trim()) {
      setStatus(doc, 'zai-preset-status', `${preset.label} API Key 为空，未保存。`, true);
      return;
    }
    if (!preset.model.trim()) {
      setStatus(doc, 'zai-preset-status', `${preset.label} Model 为空，未保存。`, true);
      return;
    }
  }
  save?.setAttribute('disabled', 'true');
  const priorByID = new Map(previous.map((preset) => [preset.id, preset]));
  const needsTest = rawPresets.filter((preset) => {
    const prior = priorByID.get(preset.id);
    return !prior || presetConnectivitySignature(prior) !== presetConnectivitySignature(preset);
  });
  if (needsTest.length) {
    setStatus(doc, 'zai-preset-status', `正在测试 ${needsTest.length} 个新增/变更配置；通过后保存...`);
  } else {
    setStatus(doc, 'zai-preset-status', '配置未改变，直接保存...');
  }
  const saved: ModelPreset[] = [];
  try {
    for (const preset of rawPresets) {
      if (!needsTest.some((item) => item.id === preset.id)) {
        saved.push(preset);
        continue;
      }
      const result = await testPresetConnectivity(preset);
      saved.push(result.preset);
      setStatus(doc, 'zai-preset-status', result.message);
    }
    savePresets(zoteroPrefs(), saved);
    renderPresetRows(doc, loadPresets(zoteroPrefs()));
    updatePresetSaveButton(doc);
    refreshSidebarPreferences();
    setStatus(doc, 'zai-preset-status', '连接测试通过，账号配置已保存，侧边栏已刷新。');
  } catch (err) {
    setStatus(doc, 'zai-preset-status', sanitizedTestError(err, rawPresets), true);
  } finally {
    save?.removeAttribute('disabled');
  }
}

function attachPresetDirtyListeners(doc: Document): void {
  const controls = Array.from(
    doc.querySelectorAll(
      '.zai-preset-row input, .zai-preset-row textarea, .zai-preset-row select',
    ),
  ) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
  for (const control of controls) {
    control.addEventListener('input', () => updatePresetSaveButton(doc));
    control.addEventListener('change', () => updatePresetSaveButton(doc));
  }
}

function updatePresetSaveButton(doc: Document): void {
  const save = byID<HTMLButtonElement>(doc, 'zai-preset-save');
  if (!save) return;
  const current = readPresetControls(doc).filter(
    (preset) => preset.apiKey || preset.baseUrl || preset.model || preset.models?.length,
  );
  const saved = loadPresets(zoteroPrefs());
  const changed = presetListSignature(current) !== presetListSignature(saved);
  const hasNew = current.some(
    (preset) => !saved.some((existing) => existing.id === preset.id),
  );
  save.disabled = !changed;
  save.textContent = hasNew ? '测试并保存新增账号' : '保存账号配置';
  save.title = changed ? '' : '账号配置没有新增或未保存改动';
}

function presetListSignature(presets: ModelPreset[]): string {
  return JSON.stringify(
    presets.map((preset) => ({
      id: preset.id,
      provider: preset.provider,
      label: preset.label,
      apiKey: preset.apiKey,
      baseUrl: preset.baseUrl,
      model: preset.model,
      models: preset.models ?? [],
      maxTokens: preset.maxTokens,
      extras: preset.extras ?? {},
    })),
  );
}

function presetConnectivitySignature(preset: ModelPreset): string {
  return JSON.stringify({
    provider: preset.provider,
    apiKey: preset.apiKey,
    baseUrl: preset.baseUrl,
    model: preset.model,
    maxTokens: preset.maxTokens,
    reasoningEffort: preset.extras?.reasoningEffort,
    reasoningSummary: preset.extras?.reasoningSummary,
    omitMaxOutputTokens: preset.extras?.omitMaxOutputTokens,
  });
}

async function testPresetConnectivity(
  preset: ModelPreset,
): Promise<{ message: string; preset: ModelPreset }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    if (preset.provider === 'openai') {
      return await testOpenAIConnectivity(preset, controller.signal);
    }
    const messages: Message[] = [{ role: 'user', content: 'Reply OK.' }];
    let sawAnyChunk = false;
    for await (const chunk of getProvider(preset).stream(
      messages,
      'Connectivity test. Reply with OK only.',
      { ...preset, maxTokens: Math.min(Math.max(preset.maxTokens || 256, 256), 512) },
      controller.signal,
    )) {
      if (chunk.type === 'error') throw new Error(chunk.message);
      sawAnyChunk = true;
      if (chunk.type === 'text_delta' || chunk.type === 'usage') break;
    }
    return {
      preset,
      message: sawAnyChunk
        ? `连接成功：${preset.provider} / ${preset.model}`
        : `连接完成：${preset.provider} / ${preset.model}`,
    };
  } finally {
    clearTimeout(timeout);
  }
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
  const withoutMaxTokens = await requestOpenAIConnectivity(preset, signal, false);
  if (!withoutMaxTokens.ok) throw new Error(openAITestErrorMessage(withoutMaxTokens));
  return {
    preset: withOmitMaxOutputTokens(preset, true),
    message:
      `连接成功：${preset.provider} / ${preset.model}` +
      '（服务不支持 Max tokens，已保存为不发送）',
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
    instructions: 'Connectivity test. Reply OK only.',
    input: [{ role: 'user', content: 'Reply OK.' }],
    ...(includeMaxOutputTokens ? { max_output_tokens: 256 } : {}),
    reasoning: {
      effort: preset.extras?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      ...(preset.extras?.reasoningSummary === 'none'
        ? {}
        : {
            summary:
              preset.extras?.reasoningSummary ?? DEFAULT_REASONING_SUMMARY,
          }),
    },
    stream: true,
    store: false,
  };
  const response = await fetch(openAIResponsesUrl(preset.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${preset.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  return { ok: false, status: response.status, body: await response.text() };
}

function openAIResponsesUrl(baseUrl: string): string {
  const root = baseUrl.trim() || 'https://api.openai.com/v1';
  return `${root.replace(/\/+$/, '')}/responses`;
}

function isUnsupportedMaxOutputTokens(body: string): boolean {
  return /unsupported parameter:\s*max_output_tokens|max_output_tokens.*unsupported/i.test(
    body,
  );
}

function openAITestErrorMessage(
  result: Exclude<OpenAITestResult, { ok: true }>,
): string {
  return `HTTP ${result.status}: ${result.body || 'no body'}`;
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

function sanitizedTestError(err: unknown, presets: ModelPreset[]): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const preset of presets) {
    if (preset.apiKey) message = message.split(preset.apiKey).join('[API_KEY]');
  }
  if (message.toLowerCase().includes('abort')) return '连接超时或已取消，未保存。';
  return `连接失败：${message}。未保存。`;
}

function renderPromptSettings(doc: Document): void {
  const settings = loadQuickPromptSettings(zoteroPrefs());
  populateBuiltInPromptControls(doc, settings);
  const custom = byID<HTMLElement>(doc, 'zai-custom-prompts');
  custom?.replaceChildren();
  for (const buttonConfig of settings.customButtons) addCustomPromptRow(doc, buttonConfig);
  setStatus(doc, 'zai-prompt-status', '已加载提示词配置。');
}

function populateBuiltInPromptControls(
  doc: Document,
  settings: QuickPromptSettings,
): void {
  const wrap = byID<HTMLElement>(doc, 'zai-built-in-prompts');
  if (!wrap) return;
  wrap.replaceChildren(
    builtInPromptControl(doc, 'summary', '总结论文', settings.builtIns.summary, DEFAULT_QUICK_PROMPT_SETTINGS.builtIns.summary),
    builtInPromptControl(doc, 'fullTextHighlight', '全文重点', settings.builtIns.fullTextHighlight, DEFAULT_QUICK_PROMPT_SETTINGS.builtIns.fullTextHighlight),
    builtInPromptControl(doc, 'explainSelection', '解释选区', settings.builtIns.explainSelection, DEFAULT_QUICK_PROMPT_SETTINGS.builtIns.explainSelection),
  );
}

function builtInPromptControl(
  doc: Document,
  field: string,
  label: string,
  value: string,
  defaultValue: string,
): HTMLElement {
  const wrap = el(doc, 'div', 'zai-built-in-prompt');
  const head = el(doc, 'div', 'zai-prompt-head');
  head.append(el(doc, 'span', '', label));
  const reset = button(doc, 'Reset');
  reset.addEventListener('click', () => {
    const area = wrap.querySelector('textarea') as HTMLTextAreaElement | null;
    if (area) area.value = defaultValue;
  });
  head.append(reset);
  const area = textarea(doc, value);
  area.dataset.prompt = field;
  wrap.append(head, area);
  return wrap;
}

function addCustomPromptRow(
  doc: Document,
  config: { id: string; label: string; prompt: string },
): void {
  const list = byID<HTMLElement>(doc, 'zai-custom-prompts');
  if (!list) return;
  const card = el(doc, 'div', 'zai-subcard zai-custom-prompt-row');
  card.dataset.id = config.id;
  const title = el(doc, 'div', 'zai-subcard-title');
  title.append(el(doc, 'span', '', '自定义按钮'));
  const remove = button(doc, '删除');
  remove.addEventListener('click', () => card.remove());
  title.append(remove);
  const label = input(doc, config.label);
  label.dataset.field = 'label';
  const prompt = textarea(doc, config.prompt);
  prompt.dataset.field = 'prompt';
  card.append(title, grid(doc, [['按钮名称', label], ['提示词', prompt]]));
  list.append(card);
}

function savePromptControls(doc: Document, okMessage = '提示词已保存，侧边栏按钮立即刷新。'): void {
  const result = readPromptControls(doc);
  if (typeof result === 'string') {
    setStatus(doc, 'zai-prompt-status', result, true);
    return;
  }
  saveQuickPromptSettings(zoteroPrefs(), result);
  renderPromptSettings(doc);
  refreshSidebarPreferences();
  setStatus(
    doc,
    'zai-prompt-status',
    `${okMessage} 当前自定义按钮：${customPromptLabels(result)}`,
  );
  flashButton(byID<HTMLButtonElement>(doc, 'zai-prompt-save'), '已保存');
}

function readPromptControls(doc: Document): QuickPromptSettings | string {
  const summary = promptText(doc, 'summary');
  const fullTextHighlight = promptText(doc, 'fullTextHighlight');
  const explainSelection = promptText(doc, 'explainSelection');
  if (!summary || !fullTextHighlight || !explainSelection) {
    return '内置快捷按钮的提示词不能为空。';
  }
  const customButtons = [];
  for (const node of Array.from(doc.querySelectorAll('.zai-custom-prompt-row'))) {
    const row = node as HTMLElement;
    const label = controlValue(row, 'label');
    const prompt = controlValue(row, 'prompt');
    if (!label && !prompt) continue;
    if (!label || !prompt) return '自定义按钮必须同时填写名称和提示词。';
    customButtons.push({ id: row.dataset.id || makeId('prompt'), label, prompt });
  }
  return { builtIns: { summary, fullTextHighlight, explainSelection }, customButtons };
}

function customPromptLabels(settings: QuickPromptSettings): string {
  return settings.customButtons.length
    ? settings.customButtons.map((button) => button.label).join('、')
    : '无';
}

function renderToolSettings(doc: Document): void {
  const settings = loadToolSettings(zoteroPrefs());
  const webSearch = byID<HTMLSelectElement>(doc, 'zai-tool-web-search');
  if (webSearch) webSearch.value = settings.webSearchMode;
  const colorGuide = byID<HTMLTextAreaElement>(
    doc,
    'zai-tool-annotation-color-guide',
  );
  if (colorGuide) colorGuide.value = settings.annotationColorGuide;
  const list = byID<HTMLElement>(doc, 'zai-mcp-list');
  list?.replaceChildren();
  for (const server of settings.mcpServers ?? []) addMcpRow(doc, server);
  setStatus(doc, 'zai-tool-status', '已加载联网/MCP配置。');
}

function addMcpRow(doc: Document, server: McpServerSettings): void {
  const list = byID<HTMLElement>(doc, 'zai-mcp-list');
  if (!list) return;
  const card = el(doc, 'div', 'zai-subcard zai-mcp-row');
  card.dataset.id = server.id;
  const title = el(doc, 'div', 'zai-subcard-title');
  const enabled = doc.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = server.enabled;
  enabled.dataset.field = 'enabled';
  title.append(el(doc, 'span', '', 'MCP Server'), labelWrap(doc, enabled, '启用'));
  const remove = button(doc, '删除');
  remove.addEventListener('click', () => card.remove());
  title.append(remove);
  const serverLabel = input(doc, server.serverLabel);
  serverLabel.dataset.field = 'serverLabel';
  const serverUrl = input(doc, server.serverUrl);
  serverUrl.dataset.field = 'serverUrl';
  const allowedTools = input(doc, server.allowedTools.join(', '));
  allowedTools.dataset.field = 'allowedTools';
  allowedTools.placeholder = '留空表示不限制工具；或填写 search, read_pdf';
  const approval = select(doc, [
    ['never', 'Never - 不需要审批'],
    ['always', 'Always - 请求审批'],
  ], server.requireApproval);
  approval.dataset.field = 'requireApproval';
  card.append(
    title,
    grid(doc, [
      ['Label', serverLabel],
      ['Server URL', serverUrl],
      ['Allowed tools', allowedTools],
      ['Approval', approval],
    ]),
  );
  list.append(card);
}

function readToolSettingsControls(doc: Document): ToolSettings {
  const existing = loadToolSettings(zoteroPrefs());
  const webSearch = byID<HTMLSelectElement>(doc, 'zai-tool-web-search');
  const mcpServers: McpServerSettings[] = [];
  for (const node of Array.from(doc.querySelectorAll('.zai-mcp-row'))) {
    const row = node as HTMLElement;
    const serverLabel = controlValue(row, 'serverLabel') || 'mcp';
    const serverUrl = controlValue(row, 'serverUrl');
    const enabled = checkboxValue(row, 'enabled');
    if (!serverLabel && !serverUrl) continue;
    mcpServers.push({
      id: row.dataset.id || makeId('mcp'),
      enabled,
      serverLabel,
      serverUrl,
      allowedTools: splitList(controlValue(row, 'allowedTools')),
      requireApproval: approvalValue(controlValue(row, 'requireApproval')),
    });
  }
  return {
    ...existing,
    webSearchMode: webSearchModeValue(webSearch?.value ?? 'disabled'),
    annotationColorGuide:
      byID<HTMLTextAreaElement>(doc, 'zai-tool-annotation-color-guide')?.value ??
      existing.annotationColorGuide,
    mcpServers,
  };
}

function promptText(doc: Document, key: string): string {
  const area = doc.querySelector(`textarea[data-prompt="${key}"]`) as HTMLTextAreaElement | null;
  return area?.value.trim() ?? '';
}

function controlValue(root: ParentNode, field: string): string {
  const control = root.querySelector(`[data-field="${field}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return control?.value.trim() ?? '';
}

function checkboxValue(root: ParentNode, field: string): boolean {
  const control = root.querySelector(`[data-field="${field}"]`) as HTMLInputElement | null;
  return !!control?.checked;
}

function webSearchModeValue(value: string): WebSearchMode {
  return value === 'cached' || value === 'live' ? value : 'disabled';
}

function approvalValue(value: string): McpApprovalMode {
  return value === 'always' ? 'always' : 'never';
}

function reasoningEffortValue(value: unknown): ReasoningEffort {
  return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)
    ? (value as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

function reasoningSummaryValue(value: string): ReasoningSummary {
  return ['auto', 'concise', 'detailed', 'none'].includes(value)
    ? (value as ReasoningSummary)
    : DEFAULT_REASONING_SUMMARY;
}

function splitList(value: string): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of value.split(/[\n,]/)) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    list.push(entry);
  }
  return list;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function makePreset(provider: ProviderKind): ModelPreset {
  const model = DEFAULT_MODELS[provider];
  return {
    id: makeId('preset'),
    provider,
    label: provider === 'anthropic' ? 'Claude' : 'GPT',
    apiKey: '',
    baseUrl: DEFAULT_BASE_URLS[provider],
    model,
    models: model ? [model] : [],
    maxTokens: 8192,
    extras: provider === 'openai'
      ? {
          reasoningEffort: DEFAULT_REASONING_EFFORT,
          reasoningSummary: DEFAULT_REASONING_SUMMARY,
          agentPermissionMode: 'default',
        }
      : { agentPermissionMode: 'default' },
  };
}

function grid(doc: Document, rows: Array<[string, HTMLElement]>): HTMLElement {
  const wrap = el(doc, 'div', 'zai-pref-grid');
  for (const [label, control] of rows) {
    wrap.append(el(doc, 'label', '', label), control);
  }
  return wrap;
}

function labelWrap(doc: Document, control: HTMLElement, text: string): HTMLElement {
  const label = el(doc, 'label', 'zai-inline');
  label.append(control, doc.createTextNode(text));
  return label;
}

function input(doc: Document, value: string, type = 'text'): HTMLInputElement {
  const node = doc.createElement('input');
  node.type = type;
  node.value = value;
  return node;
}

function textarea(doc: Document, value: string): HTMLTextAreaElement {
  const node = doc.createElement('textarea');
  node.value = value;
  return node;
}

function select<T extends string>(
  doc: Document,
  options: Array<[T, string]>,
  value: string,
): HTMLSelectElement {
  const node = doc.createElement('select');
  for (const [optionValue, label] of options) {
    const option = doc.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    node.append(option);
  }
  node.value = value;
  return node;
}

function button(doc: Document, text: string): HTMLButtonElement {
  const node = doc.createElement('button');
  node.type = 'button';
  node.textContent = text;
  return node;
}

function el(
  doc: Document,
  tag: string,
  className = '',
  text?: string,
): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(
  doc: Document,
  id: string,
  message: string,
  danger = false,
): void {
  const status = byID<HTMLElement>(doc, id);
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('zai-danger', danger);
}

function flashButton(button: HTMLButtonElement | null, text: string): void {
  if (!button) return;
  const original = button.textContent ?? '';
  button.textContent = text;
  button.ownerDocument?.defaultView?.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function byID<T extends HTMLElement>(doc: Document, id: string): T | null {
  return doc.getElementById(id) as T | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(
  value: Record<string, unknown>,
  key: string,
): value is Record<string, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
