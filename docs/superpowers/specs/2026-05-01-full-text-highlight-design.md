# 全文重点高亮 · 设计规格

**Status**: Draft (未实现)
**Date**: 2026-05-01
**Trigger**: 用户希望在 quick-prompts 加一个 `🔖 全文重点` 按钮，一键让 AI 通读 PDF 并对重点句产生 Zotero 高亮注释 + comment

## 1. 目标

一颗 `🔖 全文重点` 按钮（quick-prompts 行第三位）→ 模型读完整 PDF → **自动在 PDF 上创建 5–10 条 highlight annotation**，每条对应一句重点 + 一段 ≤ 80 字 comment。视觉上等同于用户自己用荧光笔标注。

完成后，用户在 Zotero Reader 中可见高亮，在条目附属的 annotations 列表中可见每条 comment，鼠标点高亮可看 comment 弹出。

## 2. 背景与约束

### 2.1 当前基础设施

- `src/context/retrieval.ts` 仅做纯文本字符偏移检索，**无坐标**。
- `src/context/agent-tools.ts:148 zotero_add_annotation_to_selection` 现有写工具**只接受**用户选区 popup 给的 `position` blob——无法用于纯文本→坐标场景。
- `src/context/agent-tools.ts:234 saveSelectionAnnotation`（已 `export`）封装了 `Zotero.Annotations.saveFromJSON` 调用，但同样依赖 popup 的 annotation blob。
- 无机制把任意一段 PDF 文本反查到 `{pageIndex, rects}`。

### 2.2 Zotero 写工具约束（CLAUDE.md "Non-Negotiables"）

- 不能有隐藏 Zotero 写。
- 写工具必须可见，需走 approval 或 YOLO 模式。
- 维持 Codex-style 模型驱动：harness 暴露结构化工具，模型决定何时调用，不做本地语义路由。

### 2.3 PDF.js 文档对象访问路径

- 通过 `Zotero.Reader._readers[N]._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument` 取 PDF.js document（私有路径，已被现有代码 `getActiveReaderSelection` 用过同类私有访问）。
- v1 要求**用户必须先在 Reader 里打开该 PDF**——不开即报错。

## 3. 高层架构

```
Sidebar UI
  • renderQuickPrompts: 加 🔖 全文重点 按钮 (sidebar.ts)
        ↓ click → sendMessage(triggerPrompt, { fullTextHighlight: true })
OpenAI Provider tool loop (openai.ts, v1 仅支持 OpenAI)
  • 本轮只暴露必要读工具 + zotero_annotate_passage(text, comment, color?)
        ↓
Harness write tool (agent-tools.ts, 新增)
  • 工具内部:
      1. 走 ToolSession，拿本轮 PdfLocator（会话内复用）
      2. 检查本轮写入 quota（硬上限）
      3. locator.locate(text) → {pageIndex, rects, sortIndex, ...} | null
      4. 调 Zotero.Annotations.saveFromJSON 直接写
      5. 返回结构化 result（成功 / 跳过 / 错误）
        ↓
PdfLocator (pdf-locator.ts, 新文件)
  • 取 pdfDocument 的 textContent (lazy per-page, 缓存到会话结束)
  • normalize → substring 搜 (失败降级编辑距离窗口)
  • char-range → rects (按 baseline Y 分组)
  • sortIndex 拼装
```

会话内 locator 单例：`createPdfLocator` 一次、整个全文重点流程复用、流程结束 dispose 释放 textContent 缓存。

**v1 provider 范围**：只支持 OpenAI preset。Anthropic 当前 adapter 不实现 tool loop，因此 `🔖 全文重点` 在 Anthropic preset 下禁用并提示"当前仅 OpenAI 工具循环支持批量写注释"。不要在 v1 文档里暗示 Anthropic 可用。

## 4. 模块详述

### 4.1 `src/context/pdf-locator.ts` (新建)

#### 4.1.1 公开 API

```ts
export interface LocateResult {
  pageIndex: number;            // 0-based
  pageLabel: string;            // 例如 "12" / "iv"
  rects: Array<[number, number, number, number]>;  // PDF user-space [x0,y0,x1,y1]
  sortIndex: string;            // Zotero 注释排序 key
  matchedText: string;          // PDF 中实际匹配到的文本
  confidence: number;           // 0..1
}

export interface PdfLocator {
  locate(needle: string, opts?: { minConfidence?: number }): Promise<LocateResult | null>;
  dispose(): void;
}

export async function createPdfLocator(reader: ZoteroReader): Promise<PdfLocator>;
```

#### 4.1.2 数据结构（内部）

```ts
interface ItemAnchor {
  itemIndex: number;
  pageIndex: number;
  startOffset: number;     // 在该页 pageText 中的起始 char offset
  endOffset: number;       // exclusive
  x: number; y: number;    // PDF user-space, baseline 起点
  width: number;
  height: number;
  itemString: string;      // 原始 item.str
}

interface PageBundle {
  pageIndex: number;
  pageLabel: string;
  pageText: string;        // 拼接后的文本
  anchors: ItemAnchor[];
  // normalized → original 索引映射，给 fuzzy match 反推用
  normalizedText: string;
  normalizedToOriginal: number[];  // normalizedToOriginal[i] = pageText 中原始 offset
}
```

#### 4.1.3 算法（4 步）

**步骤 1 — 取页 textContent + 拼 pageText 与 anchors**

```ts
const page = await pdfDocument.getPage(pageIndex + 1);   // PDF.js 是 1-based
const tc = await page.getTextContent({ disableCombineTextItems: false });
let pageText = '';
for (const [itemIndex, item] of tc.items.entries()) {
  const start = pageText.length;
  pageText += item.str;
  if (item.hasEOL) pageText += '\n';
  else if (item.str && !/\s$/.test(item.str)) pageText += ' ';
  const end = pageText.length;
  anchors.push({
    itemIndex,
    pageIndex,
    startOffset: start,
    endOffset: start + item.str.length,
    x: item.transform[4],
    y: item.transform[5],
    width: item.width,
    height: item.height,
    itemString: item.str,
  });
}
```

注意 `endOffset` 用 `start + item.str.length`（不含填充的分隔符），这样反查时分隔符不会被误算进 anchor。

**步骤 2 — normalize 双方做 substring 搜，失败降级编辑距离**

normalize 规则（双方共用）：
1. NFKC 归一（全角/半角）
2. 处理 PDF 断行连字符：`-\s*\n\s*` → 空（拼词）
3. 折叠 `\s+` → 单空格
4. 解开常见连字：`ﬁ→fi`、`ﬂ→fl`、`ﬃ→ffi` 等
5. 去 zero-width chars
6. lowercase

normalize 同时构建 `normalizedToOriginal` 数组：normalized 文本第 i 个字符对应原 pageText 中的 offset。

匹配流程：
1. `normalizedPageText.indexOf(normalizedNeedle)`——大多数命中走这条（注意方向：页文本包含待标句）
2. 失败 → 滑动窗口 + 编辑距离（窗口长度 = needle 长度，步进 = needle 长度 / 4），取距离最低的窗口
3. confidence = `1 - distance / max(len)`，低于 `minConfidence` 则 return null

**步骤 3 — char-range → rects（行分组）**

```ts
const overlapping = anchors.filter(a =>
  a.startOffset < matchEnd && a.endOffset > matchStart
);
// 按 baseline Y 分组（容差 ±2 user-space units）
const lines = groupByY(overlapping, 2);
// 每行算 rect
const rects = lines.map(line => {
  const x0 = Math.min(...line.map(a => xOfMatchStart(a, matchStart)));
  const x1 = Math.max(...line.map(a => xOfMatchEnd(a, matchEnd)));
  const y0 = Math.min(...line.map(a => a.y));
  const y1 = Math.max(...line.map(a => a.y + a.height));
  return [x0, y0, x1, y1];
});
```

部分覆盖（match 起点/终点切在 item 内部）：按 `(charIndex / itemString.length) * itemWidth` 做线性插值算 x。

**步骤 4 — sortIndex**

```ts
function buildSortIndex(pageIndex: number, offset: number, top: number): string {
  return [
    String(pageIndex).padStart(5, '0'),
    String(offset).padStart(6, '0'),
    String(Math.floor(top)).padStart(5, '0'),
  ].join('|');
}
```

`offset` 用**累积前 N-1 页 pageText 长度 + 当前页 matchStart**，即 PDF.js textContent 视角的全局字符偏移。**不**与 Zotero 全文 cache 对齐——两者抽取算法不同，强行对齐会引入大量不可控分歧。代价是：本批高亮内部排序正确，但和 Zotero 已存的非本批 annotation 之间排序可能与"按 PDF 顺序读"略有出入。这是可接受的折中（实机验证一下偏差幅度，必要时再改用 Zotero 全文 cache 的近邻匹配）。

#### 4.1.4 容错规则

- `pdfDocument.getPage` 抛错 → return null（页索引越界等）
- `getTextContent` 返回空 items → 视为该页无文本层，return null
- 匹配 confidence < minConfidence → return null
- 多页跨页匹配（v1 不支持）：按 page 独立搜，不跨页拼接 → 跨页句子在每页单独搜会全部低置信度 → 自然 return null

### 4.2 `src/context/agent-tools.ts` 新工具

v1 不把 `zotero_annotate_passage` 加进所有普通对话的工具集。新增一个工具会话入口：

```ts
export interface ZoteroAgentToolSession {
  tools: AgentTool[];
  dispose(): void;
}

export function createZoteroAgentToolSession(options: ToolFactoryOptions): ZoteroAgentToolSession;
```

普通对话继续走现有读工具 + `zotero_add_annotation_to_selection`。当 `options.fullTextHighlight === true` 时，本轮工具集**只**暴露：

1. `zotero_get_current_item`
2. `zotero_get_full_pdf`
3. `zotero_read_pdf_range`
4. `zotero_search_pdf`
5. `zotero_annotate_passage`

这样即使 YOLO 开启，模型也不能误调用其它写工具。

```ts
{
  name: 'zotero_annotate_passage',
  description: 'Create a Zotero PDF highlight annotation on a specific passage. Use after reading PDF text via zotero_get_full_pdf to mark key sentences. Provide the exact passage text (verbatim from the PDF) and a short comment. The harness locates the passage in the PDF and creates a highlight at that position.',
  requiresApproval: true,
  parameters: objectSchema({
    text: stringSchema('Exact passage from the PDF (verbatim, no paraphrasing).'),
    comment: stringSchema('Reading note (≤ 80 chars Chinese), explaining why this passage is important.'),
    color: stringSchema('Optional Zotero annotation color, e.g. #ffd400.'),
  }, ['text', 'comment']),
  execute: async (args) => {
    const parsed = objectArgs(args);
    const text = stringArg(parsed, 'text');
    const comment = truncate(stringArg(parsed, 'comment'), policy.maxFullTextHighlightCommentChars);
    if (!text) return errorResult('zotero_annotate_passage requires a non-empty `text`.');
    if (!comment) return errorResult('zotero_annotate_passage requires a non-empty `comment`.');
    if (!session.canWriteHighlight()) {
      return errorResult(`Highlight limit reached (${policy.maxFullTextHighlights}). Stop creating annotations and summarize the saved highlights.`);
    }

    const locator = await session.getOrCreateLocator();
    if (!locator) return errorResult('No Reader is currently open for this item. Please open the PDF in Zotero Reader and retry.');

    const result = await locator.locate(text, { minConfidence: policy.minLocateConfidence });
    if (!result) {
      return errorResult(`Passage not found in PDF (or low confidence): ${text.slice(0, 60)}...`);
    }

    const Z = getZoteroAnnotationAPI();
    const attachmentID = locator.attachmentID;
    const attachment = await Z.Items.getAsync(attachmentID);
    if (!attachment) return errorResult('PDF attachment is no longer available.');

    const json = {
      type: 'highlight',
      text: result.matchedText,
      comment,
      color: stringArg(parsed, 'color') || Z.Annotations.DEFAULT_COLOR,
      pageLabel: result.pageLabel,
      sortIndex: result.sortIndex,
      position: { pageIndex: result.pageIndex, rects: result.rects },
    };
    const saved = await Z.Annotations.saveFromJSON(attachment, json);
    session.recordSavedHighlight();
    return {
      output: [
        `[Saved annotation #${saved.id}]`,
        `Page: ${result.pageLabel}`,
        `Confidence: ${result.confidence.toFixed(2)}`,
        `Text: ${result.matchedText.slice(0, 100)}`,
        `Comment: ${comment}`,
      ].join('\n'),
      summary: `p.${result.pageLabel} 高亮 +${comment.length}字`,
      context: { planMode: 'annotation_write' },
    };
  }
}
```

**会话内 locator 复用与释放**：

```ts
const toolSession = createZoteroAgentToolSession({
  source: zoteroContextSource,
  itemID: state.itemID,
  policy: contextPolicy,
  selectionAnnotation: () => getStoredSelectionAnnotation(state.itemID),
  fullTextHighlight: options.fullTextHighlight,
  getActiveReader: () => getActiveReaderForItem(doc.defaultView, state.itemID),
});

try {
  // pass toolSession.tools to provider
} finally {
  toolSession.dispose();
}
```

不要用 `WeakMap<ToolFactoryOptions, PdfLocator>` 做隐式生命周期；`streamAssistant` 必须持有 `toolSession` 并在 `finally` 主动释放，避免 Reader 关闭后缓存仍被引用。

> 注意：`ToolFactoryOptions` 增加 `fullTextHighlight?: boolean` 和 `getActiveReader?: () => reader | null`。只有 fullTextHighlight 模式会调用 `getActiveReader`。

**为什么不复用 `saveSelectionAnnotation`**：那个函数依赖 `SelectionAnnotationDraft`（含 popup 给的 annotation blob 与 attachmentID），全文重点场景里我们自己手工构造 json 更直白；强行复用要给 `saveSelectionAnnotation` 加分支，污染抽象。

### 4.3 `src/modules/sidebar.ts` 改动

`renderQuickPrompts` 加第三项：

```ts
{
  label: '🔖 全文重点',
  prompt: TRIGGER_PROMPT,   // 见 §5
  disabled: selectedChatPreset(state)?.provider !== 'openai'
    || !hasOpenReader(state.itemID)
    || state.agentPermissionMode !== 'yolo',
  fullTextHighlight: true,  // 新 flag，触发 sendMessage 携带 reader 引用
},
```

**disabled 条件**：
- 当前 preset 不是 OpenAI → 提示"全文重点 v1 仅支持 OpenAI 工具循环"
- 当前 item 在 Reader 里没打开 → 提示"请先在 Reader 中打开此 PDF"
- 当前 permissionMode ≠ 'yolo' → 提示"批量写注释需要先开启 YOLO 模式"（v1 限制，见 §7）

`SendMessageOptions` 增加 `fullTextHighlight?: boolean`，`streamAssistant` 在 ToolFactoryOptions 里注入 `fullTextHighlight` 和 `getActiveReader` 回调，并改用 `createZoteroAgentToolSession` 管理工具集与 locator 生命周期。

### 4.4 `src/context/policy.ts` 新增上限

```ts
export const DEFAULT_CONTEXT_POLICY = {
  // ...existing fields...
  maxFullTextHighlights: 10,         // 本轮最多实际写入多少条，高于即工具拒绝
  maxFullTextHighlightCommentChars: 80,
  minLocateConfidence: 0.85,         // pdf-locator 默认置信阈值
};
```

`maxToolIterations` 仍作为总工具循环保险丝；`maxFullTextHighlights` 是写工具内的硬 quota。两者都需要：前者防止模型无限循环，后者防止 YOLO 下批量写入失控。

同时扩展 `ContextMode` union，加入 `'annotation_write'`，用于工具 trace / ledger 标记本轮发生了 Zotero 写入。

### 4.5 `zotero_get_full_pdf` 输出增强

为避免"全文重点"实际只覆盖被截断的前半篇，现有 `zotero_get_full_pdf` 需要在输出和 context 中显式暴露截断状态：

```text
[Paper full text]
Chars: 240000 / 382145
Truncated: yes
Range: 0-240000

...
```

context 增加：

```ts
{
  planMode: 'full_pdf',
  fullTextChars: sentChars,
  fullTextTotalChars: totalChars,
  fullTextTruncated: sentChars < totalChars,
  rangeStart: 0,
  rangeEnd: sentChars,
}
```

如果 `fullTextTruncated === true`，prompt 要求模型用 `zotero_read_pdf_range` 补读后续范围。v1 不强制自动分页，但必须给模型可见的截断信号；否则"全文重点"这个按钮名会误导用户。

## 5. Prompt 模板

按钮 click 触发的 user message（写死在 sidebar.ts 的 quick-prompts 里）：

```
请执行以下流程，对当前 PDF 标注重点：

1. 调用 zotero_get_full_pdf 一次，读取当前 PDF 文本。
2. 如果工具输出显示全文被截断（Truncated: yes / sent chars < total chars），请用 zotero_read_pdf_range 补读未覆盖的关键范围，尽量覆盖全文后再选择重点。
3. 通读后，从中选出 5–10 条最值得标注的重点句（论点、关键定义、核心结果、关键限制、贡献点等），避免标摘要性的整段、避免标公式。
4. 对每一条调用 zotero_annotate_passage：
   - text 字段必须是 PDF 中的逐字原文，不要改写、不要翻译、不要省略标点。
   - comment 字段用中文，简洁说明"这句话为什么重要"，≤ 80 字。
   - color 字段不传，使用默认色。
5. 全部标注完成后，再用一段中文总结：标了哪几句、整体读后感、可能漏掉的角度。

注意：
- 不要调用其它写工具。
- 本轮工具环境只允许 zotero_annotate_passage 这个批量写工具；如果达到工具返回的 highlight limit，请停止写入并总结已保存内容。
- 如果某句调用 zotero_annotate_passage 返回 "Passage not found"，可以稍微改写后重试（保持原句 80% 以上文字不变）；连续两次都找不到就放弃这句、继续下一条。
```

## 6. UI 流程

1. 用户点 `🔖 全文重点` → sidebar 检查 reader 已开 + YOLO 已开
2. `sendMessage(prompt, { fullTextHighlight: true })` 发起流式
3. bubble 里实时呈现：
   - 助手 reasoning（如有）
   - 每条工具调用 trace（已有 `renderToolTrace` 机制，复用）：
     - `zotero_get_full_pdf · 读 PDF 全文 32K/32K 字`
     - `zotero_annotate_passage · p.3 高亮 +56字`
     - `zotero_annotate_passage · p.5 ✗ Passage not found`
     - ...
   - 末尾总结段
4. 用户在 Zotero Reader 中切到该 PDF，可以立即看到新创建的高亮

**不去重**：同一句重复点击会叠多条。v1 不做去重（保持简单）。

## 7. 权限 / 审批

CLAUDE.md 要求"写工具必须可见且可审批"。当前 harness **没有交互式审批 UI**：`requiresApproval: true` 的工具在 default 模式下会被拒绝执行并返回"需要审批"，只有 YOLO 模式会执行。

全文重点一次会触发 5–10 次写入；在没有批量审批 UI 前，v1 不尝试模拟逐条审批。**v1 决策**：

- 按钮在非 YOLO 模式下 disabled，tooltip 说明"批量写注释需先开启 YOLO 模式（在设置里）"。
- 用户开 YOLO → 仅本轮受限工具集中的 `zotero_annotate_passage` 可写入，并受 `maxFullTextHighlights` 硬上限限制。
- v1.5 再考虑批量审批 UI（一次确认整批）。

这等价于让用户**显式开启 YOLO 表达"我了解后果"**，符合"不能隐藏写"。

## 8. 失败模式

| 场景 | 工具行为 | 模型应对 | 用户可见 |
|---|---|---|---|
| Reader 未打开 | errorResult `请在 Reader 里打开此 PDF` | 模型停手并把这句话转给用户 | 第一条 trace 即报错 |
| PDF 无文本层（扫描版） | locator 取 textContent 全空 → errorResult `该 PDF 没有文本层，请先 OCR` | 同上 | 第一条 trace 即报错 |
| 模型给的句子搜不到 | `Passage not found` | 改写一次重试，仍失败放弃 | trace 显示 ✗ |
| confidence < 0.85 | `low confidence X.XX` | 同上 | trace 显示 ✗ |
| sortIndex 格式不被接受 | `saveFromJSON` 抛错（待实机验证） | 模型放弃这条 | trace 显示 ✗ + 错误信息 |
| 多页跨页句 | 各页低置信，全 return null | 改写为单句重试 | trace 显示 ✗ |
| 写入超过上限 | `Highlight limit reached (10)` | 立即停止写入并总结已保存内容 | trace 显示 ✗ + limit |
| `maxToolIterations` 用尽 | tool loop 自动停止（已有机制） | — | bubble 末尾不出现总结段 |

## 9. 测试策略

### 9.1 单测

`tests/context/pdf-locator.test.ts`，用手工捏造的 mini fixture（mock pdfDocument，2 页 × 3 items × 2 行）：
- 完美匹配 → 返回正确 rects
- 跨行匹配 → 返回 2 个 rect（按 Y 分组）
- 模糊匹配（差一个空格 / NFKC 归一前后） → 仍返回，confidence ≥ 0.85
- 完全 miss → null
- 断行连字符（`pre-\nfix` 实际是 `prefix`）→ 仍命中
- 连字（`ﬁeld` ↔ `field`）→ 仍命中

`tests/context/agent-tools.test.ts` 加 `zotero_annotate_passage`：
- 正常调用 → 触发 mock saveFromJSON、返回 success result
- locator return null → return errorResult
- 缺 text / 缺 comment → errorResult
- color 透传
- 超过 `maxFullTextHighlights` → 不调用 saveFromJSON，返回 limit error
- fullTextHighlight 模式下工具集不包含 `zotero_add_annotation_to_selection`

provider / sidebar 测试：
- Anthropic preset 下 `🔖 全文重点` disabled，tooltip 说明 v1 仅支持 OpenAI
- OpenAI + Reader 未开 / YOLO 未开分别 disabled
- `zotero_get_full_pdf` 输出包含 total/sent/truncated 元数据

### 9.2 实机验证

实机阶段第一步**只写一条**：选用户手头已有的 π0.5 PDF，让模型挑一句标注，肉眼对比 Zotero Reader 中是否定位准确。

第二步：让模型批量标 5 条，看其中是否出现错位/漏行。

第三步：调 `minConfidence` 看 trade-off：调高减少错误标注但漏掉更多；调低反之。

## 10. 已采纳决定

| # | 决定项 | 取值 | 理由 |
|---|---|---|---|
| 1 | `disableCombineTextItems` | `false`（合并模式） | rect 行级精度足够，数量少，文件干净 |
| 2 | `minConfidence` 阈值 | `0.85` | 平衡漏标 vs 误标 |
| 3 | v1 是否要求 Reader 开着 | 是（v1 限制） | 避免引入 PDFWorker 直读路径，缩短 v1 |
| 4 | 句数上限 | prompt 5–10，工具硬上限 10 | prompt 负责产品意图，工具 quota 负责安全边界 |
| 5 | 复用 `saveSelectionAnnotation` 还是工具直调 | 工具直调 `saveFromJSON` | 避免污染 selection 抽象 |
| 6 | 审批模式 | v1 要求 YOLO 必开（按钮在非 YOLO 下 disabled） | 5-10 条审批太烦；显式 YOLO 表达知情同意 |
| 7 | provider 支持 | v1 仅 OpenAI | 当前 Anthropic adapter 没有 tool loop |
| 8 | 工具暴露范围 | fullTextHighlight 本轮限制工具集 | 避免 YOLO 下误调用其它写工具 |

## 11. 文件级改动清单（实施时使用）

| 文件 | 动作 | 估算行数 |
|---|---|---|
| `src/context/pdf-locator.ts` | 新建 | ~300 |
| `tests/context/pdf-locator.test.ts` | 新建 | ~150 |
| `src/context/agent-tools.ts` | 加 `createZoteroAgentToolSession`、受限工具集、`zotero_annotate_passage`、写入 quota、locator 生命周期 | +130 |
| `tests/context/agent-tools.test.ts` | 加新工具用例 | +60 |
| `src/modules/sidebar.ts` | quick-prompts 加按钮、OpenAI/Reader/YOLO disabled、`SendMessageOptions.fullTextHighlight`、`getActiveReader` 注入、toolSession dispose | +70 |
| `addon/content/sidebar.css` | 工具 trace 行 + 按钮 hover/disabled | +20 |
| `src/context/policy.ts` | 加 `maxFullTextHighlights`、`maxFullTextHighlightCommentChars`、`minLocateConfidence` | +8 |
| `src/context/types.ts` | `ContextMode` 加 `annotation_write`，全文截断 context 字段 | +8 |
| `src/providers/anthropic.ts` | 不实现工具循环；如需，仅补 disabled 测试无需改 provider | +0 |
| `CLAUDE.md` Code Reference Map | 增 pdf-locator 条目 | +3 |
| `docs/HARNESS_ENGINEERING.md` | 增写工具协议说明（如需） | +20 |

合计 **~800 行**（含测试）。

## 12. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| PDF.js 跨 Zotero 版本（7/8/9）私有路径不一致 | 高 | 多路径 try（参考 `getActiveReaderSelection`），实机验证 |
| sortIndex 格式 Zotero 不接受 | 中 | 实机 dump 一条用户手选 highlight 比对，错了再调 |
| 双栏 / 复杂排版 PDF 的 line 分组失效 | 中 | Y 容差 ±2 不一定够，可能要按字号自适应 |
| 长论文（30+ 页）`getTextContent` 性能 | 低 | lazy + 缓存，预期可接受 |
| 长论文超过 `policy.fullPdfTokenBudget` → `zotero_get_full_pdf` 截断 → 模型可能漏读后文 | 中 | `zotero_get_full_pdf` 输出 total/sent/truncated；prompt 要求用 `zotero_read_pdf_range` 补读；v2 考虑自动分页喂入 |
| 模型给的"重点句"质量差 | 中（产品风险） | prompt 改进；后续可让用户配置主题倾向 |
| sortIndex offset 与 Zotero 全文 cache 不对齐 | 低 | 本批内部排序正确即可；跨批排序偏差在可接受范围（见 §4.1.3 步骤 4） |
| YOLO 下误写其它工具 | 高 | fullTextHighlight 本轮限制工具集，只暴露 `zotero_annotate_passage` 这个写工具 |

## 13. Out of Scope（v2/v3）

- 跨页句子支持
- 自动去重（同一段重复点击不再重复创建）
- 颜色 / 类别区分（论点 / 限制 / 结果分色）
- 后台直读 PDF（不要求 Reader 打开）
- 批量审批 UI（替代 YOLO 必开）
- Anthropic tool loop 支持全文重点
- "一键删除本批注释"撤销机制
- 与 zotero_add_annotation_to_selection 的统一抽象层

## 14. 实施分阶段

1. **Phase 1**：pdf-locator 单测先过（fixture-only），不接 Zotero。
2. **Phase 2**：实机一次性 debug 函数 dump 当前 reader 的 textContent + 用户已存的高亮 sortIndex，对照算法输出验证 PDF.js 数据形态。
3. **Phase 3**：接通 agent-tools，单条标注实机验证。
4. **Phase 4**：开按钮 + prompt，批量标注实机验证。
5. **Phase 5**：edge case（扫描版、双栏、跨页、连字）回归 + 测试加强。
