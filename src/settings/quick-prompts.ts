import type { PrefsStore } from './storage';

export type BuiltInPromptID = 'summary' | 'fullTextHighlight' | 'explainSelection';

export interface BuiltInPromptSettings {
  summary: string;
  fullTextHighlight: string;
  explainSelection: string;
}

export interface CustomPromptButton {
  id: string;
  label: string;
  prompt: string;
}

export interface QuickPromptSettings {
  builtIns: BuiltInPromptSettings;
  customButtons: CustomPromptButton[];
}

export const DEFAULT_SUMMARY_PROMPT =
  '请用中文总结这篇论文，包含：研究背景与问题、核心方法流程、关键公式或算法步骤、主要贡献和创新点、实验结果与主要结论、适用场景、局限性、可能反例与后续改进方向，最后给出一句话概括。';

export const DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT = [
  '请执行以下流程，对当前 PDF 标注重点：',
  '',
  '1. 先调用 zotero_get_current_item，读取标题、作者、年份和摘要；用摘要建立论文主线（研究问题、方法、结果、结论）。',
  '2. 再调用 zotero_get_reader_pdf_text，读取当前 Reader 的 PDF 文本层。注意：后续要高亮的 text 必须从这个工具输出中逐字复制，不要从 zotero_get_full_pdf 复制。',
  '3. 如果工具输出显示全文被截断（Truncated: yes / sent chars < total chars），请继续调用 zotero_get_reader_pdf_text 并传入 start/end 补读未覆盖的关键范围。',
  '4. 通读后，从 Reader 文本中选出 5–10 条最值得标注的重点句（论点、关键定义、核心结果、关键限制、贡献点等），优先选择能支撑摘要主线的正文原句；避免标摘要性的整段、避免标公式。如果摘要里有高度概括贡献/结论的关键句，最多标 1 条。',
  '5. 对每一条调用 zotero_annotate_passage：',
  '   - text 字段必须是 PDF 中的逐字原文，不要改写、不要翻译、不要省略标点。',
  '   - comment 字段用中文，简洁说明“这句话为什么重要”，≤ 80 字。',
  '   - color 字段不传，使用默认色。',
  '6. 全部标注完成后，再用一段中文总结：摘要主线、标了哪几句、正文补充了什么、可能漏掉的角度。',
  '',
  '注意：',
  '- 只有本次全文标注需要写入 PDF；不要调用与本任务无关的写工具。',
  '- 如果达到工具返回的 highlight limit，请停止写入并总结已保存内容。',
  '- 如果某句调用 zotero_annotate_passage 返回 "Passage not found"，可以稍微改写后重试（保持原句 80% 以上文字不变）；连续两次都找不到就放弃这句、继续下一条。',
].join('\n');

export const DEFAULT_EXPLAIN_SELECTION_PROMPT = [
  '请解释当前 PDF 选区的文字。默认结合本轮已附带的附近上下文分析：先说明选区本身在说什么，再说明它在上下文中的作用，以及为什么值得关注。如果当前选区是在提出观点、给出论据/证据、定义概念、说明方法细节、承接/转折、限制条件或结论，请明确说出它属于哪一类；如果是观点或论据，必须说清楚这句话在论证链条里的作用。',
  '',
  '如果已附带的附近上下文仍不足，且当前模型可以调用 Zotero 工具，请继续用 zotero_search_pdf 或 zotero_read_pdf_range 读取更多相邻内容后再判断；避免基于孤立句子作过度推断。凡现有证据不足以支持的判断，请明确标注为“基于当前上下文尚不能确定”。',
  '',
  '在解释正文之后，另起一段，以 `建议注释：` 开头，下面用 `- ` 列出 1-3 条简短要点（每条 ≤ 80 字），可以直接贴到 PDF 上当注释。建议注释只能写当前选区和已核对上下文支持的内容。如果当前没有可用 PDF 选区，请提示我先选中文本，并省略 `建议注释：` 段。',
].join('\n');

export const DEFAULT_QUICK_PROMPT_SETTINGS: QuickPromptSettings = {
  builtIns: {
    summary: DEFAULT_SUMMARY_PROMPT,
    fullTextHighlight: DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT,
    explainSelection: DEFAULT_EXPLAIN_SELECTION_PROMPT,
  },
  customButtons: [],
};

const KEY = 'extensions.zotero-ai-sidebar.quickPrompts';
const MAX_CUSTOM_BUTTONS = 12;
const MAX_LABEL_CHARS = 32;
const MAX_PROMPT_CHARS = 20_000;

export function loadQuickPromptSettings(prefs: PrefsStore): QuickPromptSettings {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_QUICK_PROMPT_SETTINGS;
  try {
    return normalizeQuickPromptSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_QUICK_PROMPT_SETTINGS;
  }
}

export function saveQuickPromptSettings(
  prefs: PrefsStore,
  settings: QuickPromptSettings,
): void {
  prefs.set(KEY, JSON.stringify(normalizeQuickPromptSettings(settings)));
}

export function normalizeQuickPromptSettings(value: unknown): QuickPromptSettings {
  const input = value && typeof value === 'object'
    ? (value as Partial<QuickPromptSettings>)
    : {};
  const builtIns = input.builtIns && typeof input.builtIns === 'object'
    ? (input.builtIns as Partial<BuiltInPromptSettings>)
    : {};
  return {
    builtIns: {
      summary: promptValue(builtIns.summary, DEFAULT_SUMMARY_PROMPT),
      fullTextHighlight: promptValue(
        builtIns.fullTextHighlight,
        DEFAULT_FULL_TEXT_HIGHLIGHT_PROMPT,
      ),
      explainSelection: promptValue(
        builtIns.explainSelection,
        DEFAULT_EXPLAIN_SELECTION_PROMPT,
      ),
    },
    customButtons: normalizeCustomButtons(input.customButtons),
  };
}

function normalizeCustomButtons(value: unknown): CustomPromptButton[] {
  if (!Array.isArray(value)) return [];
  const buttons: CustomPromptButton[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<CustomPromptButton>;
    const label = stringValue(item.label).slice(0, MAX_LABEL_CHARS);
    const prompt = stringValue(item.prompt).slice(0, MAX_PROMPT_CHARS);
    if (!label || !prompt) continue;
    const baseId = stringValue(item.id) || label;
    const id = uniqueID(baseId, seen);
    buttons.push({ id, label, prompt });
    if (buttons.length >= MAX_CUSTOM_BUTTONS) break;
  }
  return buttons;
}

function uniqueID(value: string, seen: Set<string>): string {
  const base = value
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `prompt-${seen.size + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) id = `${base}-${suffix++}`;
  seen.add(id);
  return id;
}

function promptValue(value: unknown, fallback: string): string {
  const prompt = stringValue(value).slice(0, MAX_PROMPT_CHARS);
  return prompt || fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
