# Zotero AI Sidebar · 优化选项分析

**Status**: Options Analysis · **未决定**
**Date**: 2026-05-01
**Purpose**: 梳理对照 codex / claudian / zotero 三个参考源后,本插件可继续优化的所有候选方向,逐项给出痛点、可行路径与代价。本文件**不**做最终选择,仅作为决策前的工作备忘。后续选定方向后,会在同目录另写 `*-design.md` spec。

---

## 1. 事实底盘扫描

> 以下结论均源自 2026-05-01 当日仓库快照(`master @ 5a2600a`)与未提交的 `docs/superpowers/plans/2026-04-30-zotero-ai-sidebar.md` 改动。如代码后续演进,数字需重新核对。

### 1.1 与三个参考源的对齐情况

| 参考项 | 现状 | 偏差/位置 |
|---|---|---|
| Codex 模型驱动工具循环 | OpenAI Responses 路径完整(`src/providers/openai.ts:82` `OpenAIProvider`,`maxToolIterations=100` 安全闸) | **Anthropic adapter 完全没有 tool loop**——`src/providers/anthropic.ts:11`,文件头注释自承 `_options.tools` 被忽略;切到 Claude preset 时全部 Zotero 工具(annotations / search_pdf / pdf_range / full_pdf / reader_pdf_text / annotate_passage)失效 |
| Codex `needs_follow_up` 形状 / 无语义意图表 | `docs/HARNESS_ENGINEERING.md` 显式声明遵守 | ✓ |
| Codex 上下文 ledger(不回放旧全文) | `src/context/message-format.ts:1-431` 实现 retain + ledger | ✓ |
| Codex approval / YOLO 模式 | `agentPermissionMode: 'default' \| 'yolo'`;写工具 `requiresApproval` | **无 approval UI**——default 模式只能整体拒绝,没有"逐项询问"路径,等同于"全堵 / 全放"二档开关 |
| Claudian `MessageRenderer` / `ThinkingBlockRenderer` / `ToolCallRenderer` / 锚定底滚动 | 全部塞在 `src/modules/sidebar.ts`(4081 行,30+ 个 `render*` 函数,5 个 `// ====` 分区) | 未拆模块,**无任何 sidebar 单测**(`tests/ui/store.test.ts` 仅 37 行覆盖纯 reducer) |
| Zotero 写工具可见 trace + Markdown export | `message-format.ts` 实现 | ✓ |
| Zotero 7/8/9 manifest 兼容 | `addon/manifest.json` `strict_min_version`/`strict_max_version` | ✓(commit `6b93da7` 已扩到 9) |

### 1.2 代码体积分布(`src/`,共 7744 行)

```
src/modules/sidebar.ts        4081  ← 最大单体
src/context/pdf-locator.ts    1104  ← 全文高亮坐标定位
src/context/agent-tools.ts     686
src/providers/openai.ts        437
src/context/message-format.ts  431
src/context/retrieval.ts       281
src/context/zotero-source.ts   185
src/providers/anthropic.ts     140  ← 缺工具回路
src/context/policy.ts           89
```

### 1.3 测试覆盖

`tests/` 共 1666 行:`context/*` 5 文件、`providers/*` 3 文件、`settings/*` 2 文件、`ui/store.test.ts` 1 文件(37 行,只测纯 reducer)。**`src/modules/sidebar.ts` 4081 行无任何单元测试**。

### 1.4 在途未提交工作

`docs/superpowers/plans/2026-04-30-zotero-ai-sidebar.md` 有 `+703 / -358` 改动(`git diff --stat HEAD`),tail 已经包含 "Reader-Scoped Annotation Retrieval" follow-up——plan 在演化中,优化设计要避免和它冲突。

---

## 2. 白话版 · 每条优化解决什么实际问题

> 这一节面向"用户实际感受",不谈架构。每条都讲三件事:**现在你会撞到什么 → 改完后会怎样 → 如果不修,代价在哪**。

### 2.1 维度 A · 让 Claude 也能干活

**现在你撞到的问题**:你在 preset 里加了 Claude 4.7(因为它中文好、推理强、prompt caching 还能省钱)。然后你点 "🔖 全文重点",或问 "帮我搜论文里讲 attention 那一段",AI 回你 "我没法做这个"——因为 Anthropic adapter 根本不接 Zotero 工具,只能纯聊天。

**改完之后**:同样的 preset、同样的提问,Claude 一样能调 `zotero_search_pdf` / `zotero_annotate_passage` / `zotero_get_full_pdf` 等全部工具。挑 OpenAI 还是 Claude 只看模型能力和价格,不再被"工具支持"锁死。

**不修的代价**:Claude preset 现在是个半成品。CLAUDE.md 里 "新模型上线日就能用"的目标,只对 OpenAI 系成立;Anthropic 那边每出一个新模型,工具能力都还得再等开发。

### 2.2 维度 B · 把 4081 行的 sidebar.ts 拆开

**现在你(以及任何修代码的人)撞到的问题**:想改一个细节——让 tool call 卡片好看一点、让 selected text badge 在某个状态下不显示、调一下流式滚动行为——都要在 4081 行单文件里翻 30 多个 `render*` 函数。改一处容易碰坏另一处:之前为修"滚动跳"误伤过草稿持久,加新按钮可能漏掉别处的 keydown 监听。没有任何单元测试兜底。

**改完之后**:`MessageRenderer` / `ToolCallTrace` / `ThinkingBlock` / `Composer` / `Toolbar` 等各成一个文件,每个有自己的单测。改 A 不影响 B,加新 renderer(比如行内引用卡片)不需要 review 4000 行 diff。

**不修的代价**:是**隐性税**,直接表现你不会觉得——但每次发版升级,你会感觉"奇怪,之前 X 是好的怎么这版又坏了"。每个新功能都付一次"挪石头税";每个 bug 修复有概率反弹老 bug。维度 E(视觉抛光)和维度 C(approval UI)都会因为 sidebar.ts 是个单体而难做,所以 B 拖着不修,会反向卡住其他维度。

### 2.3 维度 C · 给写工具一个真正可用的 approval

**现在你撞到的问题**:点 "🔖 全文重点",AI 想往 PDF 上加 5 条高亮——default 模式下被堵住,报 "tool requires approval"。唯一能让它真写的办法:开 YOLO 模式。但 YOLO 一开,从此 AI 想加什么注释都直接落到 PDF 上,加错了你要一条一条手动删。

**改完之后**:default 模式下,AI 要写注释时 sidebar 弹一张卡片——"模型想在第 3 页高亮这 5 句话,内容是 X / Y / Z,批准 / 修改 / 拒绝";你点批准它就写,点拒绝它就跳过。**真正可用的中间档**,不再是"全堵 / 全放"二档开关。

**不修的代价**:写工具实际不可用。"AI 帮我标重点"这件事,要么不让它做,要么放任它乱做——大部分用户会选前者,导致写工具是放在那里看的。

### 2.4 维度 D · 让 AI 看得见你的整个图书馆

**现在你撞到的问题**:选中一篇论文,你能问 "这篇讲了什么";但你**不能**问 "我去年 Foundation Models collection 里有几篇用了 contrastive loss",也不能问 "找出我读过的所有提到 Mamba 的论文"。AI 只看见当前 item,看不到其他资料。

**改完之后**:AI 多了 `zotero_search_library({ query, collection? })` 类工具,能跨 collection 找符合条件的条目,带元数据返回。你的图书馆变成 AI 可以"翻书"的真实文献库,而不只是"当前打开那一页"。

**不修的代价**:跨论文的研究问题(写综述、复现对比、追一个概念在多年文献里的演化)还是只能手动开一堆 Zotero 标签页,自己人肉串联。这是能力扩展不是缺陷修复——不修不会"坏",只是"做不到"。

### 2.5 维度 E · 让 AI 输出本身好读

**现在你撞到的问题**:AI 回复里如果有公式,显示成原始 LaTeX 字符 `\sum_{i=1}^n`;代码块没语法高亮,一坨灰底白字;思考过程是平铺的黑字 `<thinking>...</thinking>` 跟正文混在一起。读 AI 输出本身比读论文还累。

**改完之后**:KaTeX 把公式渲染成数学体;代码块按语言语法高亮;思考块默认折叠成 "Claude 思考了 12s",点开才展开;tool call 是一张可点开看 input/output 的卡片(Claudian 风格)。

**不修的代价**:用户每读一段 AI 输出都多付一份"翻译 markdown 源码"的认知成本。功能不缺,体验掉档,但不致命。

### 2.6 维度 F · 让插件不抖、不慢、不贵

**现在你(可能)撞到的问题**:用 Claude 多轮对话每轮感觉都贵——也许是 prompt cache 没命中,每轮重发整篇 paper metadata;流式输出有时一卡一卡;Zotero 9 上某个按钮失灵。但**这些目前都是猜测**,没有指标可看。

**改完之后**:先有可信诊断(本地 telemetry / debug log 骨架),针对真问题精准修。不是先做"性能大改造"。

**不修的代价**:没有指标的"性能优化"基本是迷信编程。但反过来——**贸然乱改也不一定有收益**,所以 F 排序靠后:它是"等被某个具体性能问题咬到再开工"的维度。

---

## 3. 优化维度全景(六类·技术视角)

按"投入产出比"主观排序,但**不当作结论**。每项给出痛点边界与代价量级,具体子方案在选定后再展开(维度 A 已展开,见 §4)。

| 维度 | 痛点 | 可行性边界 | 代价量级 |
|---|---|---|---|
| **A. Provider 一致性** | Anthropic 路径无 tool loop,Claude 4.7 在工具使用上的优势在本插件里被阉割 | 必须改:Anthropic adapter 流式协议要扩出 `tool_use` 块、`tool_result` 回灌、续 stream | 中(~1 周量级) |
| **B. UI 架构拆分** | `sidebar.ts` 4081 行单体,所有 Claudian renderer 升级都要改这一个文件;无单测 | 是纯重构;风险在不漏行为(键盘、滚动锁、草稿持久、流式增量) | 中-高 |
| **C. 写工具 approval UI** | default 模式下写工具被结构化错误堵住;只有 YOLO 才能用 | 需要 UI(气泡/卡片) + 工具循环里的暂停态 | 中 |
| **D. 跨条目能力** | 现仅 single-item 上下文;多论文比较 / collection 检索无工具入口 | 需新增 `zotero_search_library` / `zotero_get_items` 类工具,涉及检索层(Zotero search API 或外部 embedding) | 高 |
| **E. 阅读体验抛光** | Markdown 渲染、代码块语法高亮、KaTeX、表格、tool trace 卡片视觉、思考块折叠交互 | 纯 UI,但点多;依赖 B 拆分以避免改 4000+ 行单文件 | 中(碎) |
| **F. 鲁棒性 / 性能** | Anthropic prompt cache hit 率、流式抖动、Zotero 8/9 兼容点、错误重试 | 要先有指标 telemetry 才能谈 | 视诊断结果 |

### 3.1 一个高层结构性观察(供决策参考,非结论)

A 是能力天花板;B 解开 A/C/E 的实现路径(在 4000+ 行单文件里加 approval UI、Anthropic 工具调用 trace、新 renderer 都会持续制造合并冲突);C 让写工具真正在 default 模式可用而不只是 YOLO 玩具。D/E/F 是能力扩展或抛光,不在核心路径上。

但这是"自顶向下"的看法。如果你的实际诉求是 D(库级检索)或 E(视觉抛光),路径会完全不同——D 几乎不依赖 A/B 就能开工,E 严重依赖 B。

---

## 4. 维度 A 详展开:tool loop 应该住在哪里

(B–F 暂不展开子方案;选定后另写。)

### 4.1 当前事实

`src/providers/openai.ts` 中,`OpenAIProvider.stream()` 自己跑完整个工具回路:`while` 循环 + `function_call` 解析 + `function_call_output` 回灌 + `maxToolIterations` 安全闸 + ledger 通知,共 437 行里很大一部分。`AnthropicProvider.stream()` 仅做单轮 streaming,根本没有 loop。

### 4.2 三条路径

#### A1. 在 Anthropic 复制一份 loop

- **做法**:`AnthropicProvider.stream()` 内部自己实现 `tool_use` 内容块的解析、`tool_result` 的拼回、续 stream。
- **优点**:openai.ts 不动,改动局部。
- **代价**:两份 iteration 控制流共存。任何 ledger / 安全闸 / 截断策略 / approval 钩子的演进都要改两处;未来如再加 Gemini / xAI provider,要写第三份。
- **与 codex 形状对照**:codex-rs `core/src/session/turn.rs` 的 `needs_follow_up` 循环住在 `Session`,不是 `ModelClient`;A1 是反向对齐。

#### A2. 抽出 `runAgentTurn(provider, ...)` harness 顶层循环

- **做法**:Provider 退化成"流一个 turn,把 `tool_call` / `tool_result_request` 块作为 `StreamChunk` 类型 yield 出来";harness 持有 iteration 计数、tool 验证/执行、截断、ledger 写入、approval 钩子。
- **优点**:
  1. 单一来源真理,新加 provider 只写"一个 turn 的流式协议适配"。
  2. 与 codex `Session::run_turn` 形状一致——HARNESS_ENGINEERING.md 引用的设计点。
  3. **直接服务 C(approval UI)**:approval 必须在"工具被解析出来 → 真正执行"之间插入暂停态。harness 顶层暴露 `onToolCallApprove(call) => Promise<'approve'|'deny'>` 钩子是自然位置。
  4. **服务 B(拆分)**:sidebar 调用面从 `provider.stream(messages, tools, ...)` 改为 `runAgentTurn({ provider, tools, hooks })`,sidebar 摆脱 provider 实现细节。
- **代价**:
  1. 重构 OpenAI 现有 loop——风险在不漏掉边界条件(replay item、reasoning summary、`store: false` 下的 ID 处理)。
  2. `StreamChunk` 协议要扩:新增 `tool_call_request` / `tool_call_result` / `iteration_advance` 等类型,所有消费者(sidebar 流式渲染、tests)都要相应更新。

#### A3. 中间路线:抽 `ToolExecutor`,iteration 仍在 provider

- **做法**:把"工具验证 + 执行 + 截断 + ledger 写入"抽成 `ToolExecutor` 类共享;两个 provider 各自的 loop 都通过它执行单次 tool call。
- **优点**:OpenAI 改动最小;Anthropic 不用从零写工具执行。
- **代价**:iteration 计数、安全闸、approval 仍分散在 provider 里——和 A1 一样的"两份控制流"问题,只是把"工具执行"这一面共享了。**对 C(approval UI)无帮助**,因为 approval 钩子要插在 iteration 控制流里,而 iteration 还在 provider 里。

### 4.3 比较矩阵

| 维度 | A1 复制 loop | A2 harness 顶层 loop | A3 共享 ToolExecutor |
|---|---|---|---|
| 改动量 | 小 | 大 | 中 |
| 与 codex 形状对齐 | 反向 | 一致 | 部分 |
| 加第三个 provider 的边际成本 | 高(写第三份 loop) | 低(写一个 turn 适配) | 中(写 loop,共享执行) |
| 服务 C(approval) | 需各自再加 | 自然钩子 | 仍需各自加 |
| 服务 B(拆分) | 中性 | 推动 sidebar 解耦 | 中性 |
| 风险点 | 持续偿还 | 一次性重构,需保边界条件 | 中等;伪解法风险(看似共享,核心仍分散) |

### 4.4 待决策的子问题(选定路径后才需要回答)

无论选 A1/A2/A3,以下都要决定,但子问题的具体形态依路径而异:

- **Anthropic streaming 协议适配**:`tool_use` 在 `content_block_start` / `content_block_delta`(`input_json_delta`) / `content_block_stop` 上分批到达——是攒齐再 emit 一次 `tool_call_request`,还是流式 emit partial JSON?
- **Tool 定义的跨 provider 适配**:OpenAI 的 `function` 工具规格 vs. Anthropic `tools` 字段的 schema 差异,要不要在 `AgentTool` 中央定义里同时产出两套 spec?
- **Prompt caching**:Anthropic 已有 system 上的 `cache_control: ephemeral`(`anthropic.ts:36`);tool 定义那一段是否也加 cache?这影响多轮 tool loop 的成本。
- **Reasoning / thinking 内容块**:Anthropic 的 `thinking_delta` 已在适配中;tool loop 续轮时如何在 ledger 里区分 thinking 与 text?

---

## 5. 维度 B–F 决策时需要回答的关键问题

> 不展开子方案,只列"选定该方向后第一个要回答的问题",作为决策时的提示。

- **B(UI 架构拆分)**:目标是"解开 4081 行单文件",但拆分单元是按 **render 角色**(MessageRenderer / ToolCallRenderer / ThinkingBlock / Composer / Toolbar)还是按 **生命周期**(mount/state/event/effect)?Claudian 是前者。是否同时引入 React-in-ItemPane,还是保持纯原生 DOM(CLAUDE.md 提示过避免再次引入 React 到 Zotero pane,因为崩溃行为)?
- **C(approval UI)**:approval 卡片是**阻塞式**(模型暂停等待) 还是 **乐观式**(默认通过,显示"已自动批准,可撤回")?这一选择会影响 tool loop 控制流的形状。
- **D(跨条目)**:库级检索用 **Zotero 内置搜索 API**(关键字 + 元数据),还是引入 **embedding 索引**(更准但要存模型/索引文件,涉及隐私和本地存储)?
- **E(阅读抛光)**:Markdown 渲染换成完整 markdown-it pipeline,还是只做现状增强?KaTeX/代码块按需 lazy load 吗(性能)?
- **F(鲁棒性/性能)**:先做 **观测**(加 telemetry / 日志骨架)还是先做 **修复**(凭直觉改 prompt cache 标记、流抖动)?没有指标的"性能优化"通常是迷信编程。

---

## 6. 待决策清单

> 这些是把这份分析推进到下一步设计前必须由用户回答的事项。

1. **优先级排序**:六类维度按什么顺序进行?是否接受 A → B → C 这条主线,还是要换路径(例如先做 D 跨条目能力)?
2. **维度 A 路径**:A1 / A2 / A3 三条中选哪条?
3. **Spec 拆分粒度**:接下来的 design spec 是**一篇覆盖整条主线**(A+B+C 一起),还是**每个维度一篇**(`*-anthropic-tools-design.md` / `*-sidebar-decomposition-design.md` / `*-approval-ui-design.md`)?后者更可独立交付,前者可见整体形态。
4. **作用域护栏**:是否允许在选定维度里**顺手**修复邻近坏味道(例如做 B 时清理 `agent-tools.ts` 686 行的过长函数),还是严格保持"surgical changes"?

---

## 7. 不在范围内(本次不考虑)

- 替换 `react-markdown` / 引入新 UI 框架的整体改造。
- 改 Zotero 插件 manifest 或 prefs 存储格式。
- 任何依赖网络的检索改造(embedding 服务、远程语义索引)——除非维度 D 被选中且明确选了 embedding 路径。
- 翻新 release 流程 / CI;`docs/RELEASE.md` 已稳定。
