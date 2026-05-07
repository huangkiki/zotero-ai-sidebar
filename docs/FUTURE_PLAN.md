# Future Plan

本文档记录已经讨论过、但当前暂不实现的功能方向，避免后续重新研究。

## PDF 图文选区提问（暂缓）

状态：暂缓。当前版本继续优先保证纯文字选区提问、解释选区、任务队列和跳转标记稳定，不在本轮实现自动图文匹配。

### 背景

在论文 PDF 中，用户可能选中包含图片、图注、子图说明和正文的混合区域。PDF 的文本层经常与视觉布局不一致，尤其在多栏论文、跨页图、复杂图表、图片内部文字和乱码文本层中，直接把 PDF 选区文本发送给模型会出现：

- 图像区域被解析成严重乱码。
- 视觉上相邻的图片和图注，在文本层中并不相邻。
- 多个子图 `(a)`、`(b)`、`Fig. 6`、`Fig. 7` 的说明可能被错误绑定到另一张图。
- 自动拆分多个图片时，可能出现“图片 #1 搭配了图片 #2 的说明”的错配。

### 当前结论

这种图文提问方式仍然可能将图片和文字匹配错误。更稳妥的方向不是强行做精确匹配，而是采用保守的“图文区域截图”策略：

- 可靠文字继续使用 Zotero 官方选区思路获取：`_selectionRanges + chars`。
- 严重乱码不发送给模型，改为过滤并用 `[Image #n]` 标记替代。
- 图片区域截图时，尽量把图片、子图标题、图注和局部说明包含在同一张截图里。
- 多图边界不确定时，优先合并成更大的图文截图，而不是错误拆成多张。
- 只有在 `(a)`、`(b)`、`Fig. n` 等结构和几何位置都比较明确时，才考虑拆成多张图。

### 候选设计

后续如果实现，可以增加一个 `getSelectedPdfContextForPrompt()`，返回结构化上下文：

```ts
{
  text: string;
  images: MessageImage[];
  diagnostics?: {
    filteredGibberishLines: number;
    imageRegionCount: number;
    mappingConfidence: "high" | "medium" | "low";
  };
}
```

提示词中的组织方式可以是：

```text
[Image #1: Fig. 6，包含环境图片和完整图注]
Fig. 6: Evaluation environments...
```

对于明确的多子图：

```text
[Image #1: Fig. 7(a)，包含 rollout 图片和 (a) 说明]
[Image #2: Fig. 7(b)，包含定量结果图片和 (b) 说明]

Fig. 7 shared caption for Image #1 and Image #2:
Fig. 7: Evaluation in real homes...
```

对于边界不明确的多图：

```text
[Image #1: Fig. 7 整体图文区域，包含所有子图、子图说明和完整图注]
```

### Zotero 官方思路参考

- 文字选区：参考 Zotero Reader 的朗读/选区实现，使用 selection range 的字符索引，而不是 DOM selection 或纯 rect 反推文本。
- 图片区域：参考 Zotero Area/Image annotation 的做法，用 PDF `position.rects` 通过 PDF.js 渲染区域截图。
- 第一版应优先保证“不严重错配”，而不是追求自动精确拆分。

### 暂不实现范围

- 暂不做复杂图文自动分组。
- 暂不做 OCR 识别图片内部文字。
- 暂不做跨页图文匹配。
- 暂不把该功能接入当前任务队列和跳转标记逻辑。
