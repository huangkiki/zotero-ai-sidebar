# MCP 与 Skill 在本插件里的设计取舍（brainstorm）

`docs/TOOLS_AND_MCP.md` 已经写清楚了三类能力的边界（本地 AgentTool / 托管 web_search / MCP）。本文聚焦更上一层的问题：

- MCP 真正值得用在哪些场景？
- 「skill」这个概念在本插件里到底指什么？是否应该新增独立的 skill 系统？

## TL;DR（60 秒读完）

> 本文经过 5 轮迭代，逐次自我反驳。底下结论已剔除前几轮被推翻的论点。

### MCP 怎样使用？

**「能用但用不到」。** 现状直接保留，**不要加预设 URL 列表，不要做嵌入式 MCP 客户端**。

理由（[迭代 2 验证](#二mcp-应该用在哪)、[迭代 4 反驳](#71-事实更正anthropic-已经有官方agent-skills)）：

1. OpenAI Responses 托管 MCP 要求 server URL **公网可达**（[OpenAI 文档](https://platform.openai.com/docs/guides/tools-connectors-mcp)）。`headers` 是用来传 token，不会反向通道。
2. 学术常见 MCP server（[Semantic Scholar](https://github.com/FujishigeTemma/semantic-scholar-mcp)、[OpenReview](https://github.com/openreview/openreview-mcp)、[arXiv](https://github.com/blazickjp/arxiv-mcp-server)）**全部是社区自部署**，没有官方托管 URL。
3. 自部署 + 公网化的能力，对一般 Zotero 学术用户接近 0%。
4. 真正想要 Semantic Scholar / OpenReview 等服务，**直接做内置 AgentTool（fetch API）比包 MCP 协议更直接、更可控**（参考现有 `paper_search_arxiv`）。

**当前 MCP 能力定位**：留给少数已经有公网 MCP server 的高级用户。UI 加两条诚实提示即可：私网 URL 黄字警告 + Base URL 兼容性说明。

**Anthropic 没有 hosted MCP**（截至 2026-05），所以 MCP 在 Anthropic 路径上零参与。

### Skill 怎样使用？

「Skill」一词在本插件上下文里有**两层含义**，分开处理：

| 层 | 是什么 | 怎么用 |
| --- | --- | --- |
| **本地层** | 用户能在 UI 上点的 prompt 快捷方式（slash + 按钮），即现有 `/arxiv-search`、`/web-search`、「总结 / 全文重点 / 解释选区」 | 合并成单一 `PromptShortcut` 模型，统一编辑，统一渲染（[详见 7.4 UX 草稿](#74-promptshortcut-设置面板-ux-草稿concrete)） |
| **服务端层** | Anthropic 官方 [Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)（folders of instructions/scripts，Messages API 走 code execution tool） | 未来用一个独立配置项接入（skill_id 列表）；不要混进 PromptShortcut |

**严禁的第三层**：跑代码的本地 skill（LangChain 风格 agent / 意图路由）。CLAUDE.md 明确禁止。

### 最终优先级（[详见 7.3](#73-最终优先级迭代-4-收敛版)）

| # | 项 | 类型 | 触达 | 优先级 |
| --- | --- | --- | --- | --- |
| **PR-1** | 写工具 shortcut 加 🔒 警示 | UI 补丁 | 全部用户 | ⭐⭐⭐ 立即可做、< 50 行 |
| PR-5 | Anthropic 客户端工具循环 | provider 平权 | Anthropic 用户 | ⭐⭐⭐ 独立可做 |
| PR-2/3/4 | PromptShortcut 重构 | 抽象统一 | 全部用户 | ⭐⭐ 顺序依赖 |
| PR-6 | MCP UI 期望管理（私网 URL 警告 + 兼容性提示） | UX 诚实 | MCP 用户 | ⭐⭐ 小补丁 |
| PR-7 | Semantic Scholar 内置 AgentTool | 工具扩展 | 关心引用图谱用户 | ⭐ 看需求 |
| PR-8 | 清理 legacy `arxivMcp` 字段 | 卫生 | 无 | ⭐ 顺手做 |
| ✗ | 嵌入式 MCP 客户端 | 重型 | < 5% 用户 | ❌ 撤回（[迭代 4](#反-3mcp-方案-b--嵌入式客户端是不是-over-engineering)） |

**只能做一件事就做 PR-1**：写工具 shortcut 加 🔒 视觉警示。低风险，可见收益，不阻塞任何后续工作。完整 PR 列表见 [§九](#九执行清单迭代-5-收尾)。

### 三句话结尾

- **MCP**：留给真·远端服务，UI 诚实即可，不要假装贴 URL 即用。学术服务做成内置 AgentTool 更值。
- **Skill**：合并 slash + quick prompt 成一个 `PromptShortcut`；Anthropic Agent Skills 是另一码事，未来再接。
- **平权大于优化**：让 Anthropic 跑通客户端工具循环，比给 MCP 加 preset 对一般用户更有感。

---

> 下面是完整推理过程（5 轮迭代，包含被推翻的中间结论）。如果你只关心结论，可以止于此处。



## 一、现状速查

| 能力面 | 在哪 | 谁触发 | 谁执行 | 用户可编辑 |
| --- | --- | --- | --- | --- |
| 本地 AgentTool（`zotero_*`、`paper_*`） | `src/context/agent-tools.ts`、`paper-tools.ts` | 模型 | 插件 | 否 |
| Hosted web_search | `src/providers/openai.ts:445` | 模型 | OpenAI 端 | 仅开关 + cached/live |
| MCP server | 同上，`mcpServers` 数组 | 模型 | 远端 MCP server | 是（label/url/allowed_tools/approval） |
| Slash command（`/arxiv-search`、`/web-search`） | `src/ui/slash-commands.ts` | 用户键入 | 仅做 prompt 展开 | 否（写死在代码里） |
| Quick prompt（summary / full-text-highlight / explain-selection / 自定义） | `src/settings/quick-prompts.ts` | 用户点按钮 | 仅做 prompt 注入 | 是（首选项） |

关键观察：

1. 「跑代码的工具」全部在 AgentTool / web_search / MCP 三类里。
2. 「prompt 模板」分裂成两套：slash command（写死） + quick prompt（可编辑）。功能高度重叠。
3. MCP 入口已经做好了，但目前用户不知道填什么 URL，所以默认空表是正确状态。

## 二、MCP 应该用在哪

判断 MCP 的核心标准：**这件事必须由独立服务做，并且没法做成本地 AgentTool**。

### 现实约束（迭代 2 验证）

把「场景值得」和「场景能用」分开。两个硬约束决定后者：

1. **目前没有「贴 URL 即用」的官方托管 MCP**（验证于 2026-05）。常见学术服务的 MCP server 全部是社区实现：
   - Semantic Scholar：[FujishigeTemma/semantic-scholar-mcp](https://github.com/FujishigeTemma/semantic-scholar-mcp)、[zongmin-yu/semantic-scholar-fastmcp-mcp-server](https://github.com/zongmin-yu/semantic-scholar-fastmcp-mcp-server)、[JackKuo666/semanticscholar-MCP-Server](https://github.com/JackKuo666/semanticscholar-MCP-Server)、[hamid-vakilzadeh/AIRA-SemanticScholar](https://github.com/hamid-vakilzadeh/AIRA-SemanticScholar)
   - OpenReview：官方 [openreview/openreview-mcp](https://github.com/openreview/openreview-mcp) 和 [anyakors/openreview-mcp-server](https://github.com/anyakors/openreview-mcp-server)
   - arXiv：[blazickjp/arxiv-mcp-server](https://github.com/blazickjp/arxiv-mcp-server)、Docker 镜像 [`mcp/arxiv-mcp-server`](https://hub.docker.com/r/mcp/arxiv-mcp-server)、[arxiv-mcp-server PyPI](https://pypi.org/project/arxiv-mcp-server/)
   - 这些都需要用户自己 `pip install` / `docker run`，并把端口暴露出来。

2. **OpenAI Responses 托管 MCP 要求 server URL 公网可达**（[platform.openai.com/docs/guides/tools-connectors-mcp](https://platform.openai.com/docs/guides/tools-connectors-mcp)）。`headers` 字段是用来传鉴权 token 的，不会建立反向通道。所以即便用户在本机起好了 arxiv-mcp，也不能直接填 `http://localhost:8000` —— OpenAI 服务器的出站请求到不了用户机器。

   实际可用路径只有三条：
   - 把 MCP 部署到公网 VPS / Cloud Run / Railway / Modal。
   - 用 ngrok / cloudflared / Tailscale Funnel 把 localhost 暴露出去。
   - 用插件**自己**做 MCP 客户端（见下面「方案 B」）。

结论：如果坚持走 OpenAI 托管 MCP 路线，MCP 在本插件的实际可用面接近 0——除了愿意自部署 + 公网化的高级用户。这显著重排了 v1 brainstorm 里的优先级。

### 两条 MCP 接入路径

| 方案 | 谁说 MCP 协议 | 用户负担 | 插件代码量 | 适用 provider |
| --- | --- | --- | --- | --- |
| **A：OpenAI 托管 MCP**（当前实现） | OpenAI 服务器 ↔ 远端 MCP server | 高：自部署 + 公网 | 低（已写完） | 仅 OpenAI Responses 兼容 |
| **B：插件内嵌 MCP 客户端**（未实现） | 插件 ↔ 本机/远端 MCP server，再把 MCP 工具重新登记成本地 `AgentTool` 给模型 | 低：装一个 npm/pip 包就够 | 中：要写 MCP client + 生命周期管理 | OpenAI、Anthropic 都行 |

方案 B 的吸引力：

- **解锁 localhost MCP**：用户 `npx arxiv-mcp-server`，插件用 stdio 或 HTTP 接住。
- **Provider 中立**：MCP 工具被翻译成 `AgentTool`，Anthropic/OpenAI 都可用，不再被 hosted MCP 限制。
- **审批 UI 更可控**：approval flow 走插件本地 UI，不依赖 OpenAI 的 `mcp_approval_request` 事件。

代价：

- 需要引入 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 或自己实现 JSON-RPC 客户端。
- Zotero 7/8/9 的 XPI 沙箱里启动子进程不一定容易（XPCOM/Components.classes 路径），可能需要 HTTP MCP 而非 stdio。
- MCP server 的发现 / 启停由用户负责，插件只做客户端连接。

短期建议：**先不做方案 B**，但把它作为「MCP 进阶路线」记下来；现状方案 A 留给愿意自部署的高级用户，UI 上加一行说明。

### 真正适合 MCP 的方向（按价值排序，下调表述）

1. **跨论文的检索 / 引用图谱**
   - 候选服务：Semantic Scholar、OpenReview、Connected Papers、CORE、Crossref。
   - 这些天然就是远端服务、需要 API key 鉴权、工具集稳定但不该打包进 XPI。
   - 用户提问「这篇论文有哪些后续工作 / 引用」「相关综述」时，结构化 API 优于 web_search。
   - 当前生态：以上服务有社区 MCP 实现（链接见上节），但**没有官方托管 URL**；用户必须自部署或用 tunnel。

2. **私有知识库 / 实验室内部数据**
   - 课题组的论文笔记、内部 wiki、引用库的远端镜像。
   - 这些一定是用户自己部署，不可能内置。
   - MCP 配置项（label/url/allowed_tools/approval）已经够用。

3. **重型外部能力**
   - 例：本地跑的 vector DB、引文管理服务、PDF OCR/翻译服务。
   - 不适合塞进 Zotero 插件运行时（依赖大、二进制问题），但用户可以本地起一个 MCP server。

### 不适合做成 MCP 的方向（哪怕看起来像）

- 当前 Zotero 条目 / Reader / 标注 / 笔记 → 必须本地 AgentTool（已是）。
- 固定且轻量的 arXiv 元数据 / ar5iv HTML → 已是本地 AgentTool（v0.1.x → v0.2.0 已经把它从 MCP 退回本地）。
- 「我希望模型搜网页」→ web_search，不要再包一层 MCP。
- 「我希望模型按某个流程办事」→ 那是 prompt 模板（quick prompt / slash），不是工具。

### 建议的 MCP 体验改进（基于上面的现实约束重排）

1. **配置时讲清门槛**：MCP 列表上方加一段说明，明确两件事：(i) 服务器需要公网 URL（或 ngrok / cloudflared 暴露的本机端口）；(ii) Base URL 必须支持 hosted MCP（多数自定义 OpenAI 代理不支持）。把这两点前置，比让用户加完一行错配置后超时再去 `openai.ts:704` 看错误码强。
2. **预设是「文档指针」而不是 URL**：`+ 添加预设` 下拉填的不是「URL」，而是「常见 MCP server 的 GitHub 链接 + server_label 默认值 + allowed_tools 默认值」。点选后跳到一个简短的「这是什么 / 如何部署」面板，URL 仍由用户自填。比 v1 brainstorm 想象的「贴 URL 即用」更诚实。
3. **审批 UI 落地**：`requireApproval='always'` 会卡循环，前端需要 inline approval 框。`openai.ts:580` 已经识别 `mcp_approval_request` 事件；接 UI 是中等改动。否则 `always` 模式实际不可用，应当在用户选 `always` 时给出红字提示。
4. **方案 B（嵌入 MCP 客户端）记入 backlog**：暂不实现。如果未来 MCP 生态更活跃、OpenAI 不放开公网约束、或希望兼容 Anthropic，再考虑投入做。
5. **清理 legacy `arxivMcp`**：`tool-settings.ts:6` 留的字段已无运行时引用，下个 minor 版本可以删除。

## 三、「skill」在本插件里到底指什么

注意：「skill」一词在不同上下文意思完全不同。先把三种含义分开。

| 含义 | 例子 | 谁执行 |
| --- | --- | --- |
| (a) 用户层 prompt 快捷方式 | Claude Code slash command、Anthropic Skill、本插件 `/arxiv-search`、quick prompt 按钮 | 模型（只是塞 prompt 进去） |
| (b) prompt + 工具序列的「配方」 | 本插件 `fullTextHighlight`：长 prompt 指挥模型先读 reader、再选句、再调 annotate | 模型自主调度 |
| (c) 局部跑在 harness 里的代码 | LangChain agent、自定义 RAG 前置处理、本地意图路由 | 插件代码 |

本项目 CLAUDE.md 明确禁止 (c)：「不要做本地关键词、正则或语义意图路由」。所以**本插件的 skill 概念只能是 (a) + (b)**。

### 当前 skill 体系的问题

- 同一类东西分裂成两套：slash command（写死、不可编辑）和 quick prompt（可编辑、有按钮）。
- 自定义按钮可以有任意 prompt，但不能绑定 slash 触发。
- slash command 不能在 UI 里看到列表（除非用户自己输 `/`），不利于发现。
- 「fullTextHighlight」其实是 (b) 类——它在 prompt 里指挥工具序列。但和「summary」（纯文字总结，不调工具）放在同一个数据结构里，没有视觉区分，让用户分不清「这个按钮会写 PDF」。

### 建议：把 slash 和 quick prompt 合并成统一的 PromptShortcut

形状（迭代 2 收敛版本）：

```ts
interface PromptShortcut {
  id: string;                     // 持久化用，stable
  label: string;                  // 按钮文字 / 设置面板标题
  slash?: string;                 // 可选，例如 '/arxiv-search'
  prompt: string | ((args: string) => string);
                                   // 静态字符串或带 args 的展开
  showButton: boolean;            // 在底栏显示按钮
  builtIn: boolean;               // true 时 prompt 可被 reset 成默认值
  hint?: 'writesAnnotations' | 'usesWebSearch' | null;
                                   // 仅 UI 提示，不做执行约束
}
```

迁移映射（v0.2.x → v0.3.x）：

| 现有 | 新 PromptShortcut | 备注 |
| --- | --- | --- |
| `quick-prompts.summary` | `{ id: 'summary', slash: '/summary', showButton: true, builtIn: true }` | 加 slash 是顺手的事 |
| `quick-prompts.fullTextHighlight` | `{ id: 'full-highlight', slash: '/highlight', hint: 'writesAnnotations', ... }` | 写 PDF，UI 加锁标 |
| `quick-prompts.explainSelection` | `{ id: 'explain', slash: '/explain', ... }` | |
| `quick-prompts.customButtons[i]` | `{ ...item, builtIn: false, showButton: true }` | 自定义按钮自动迁移 |
| `slash-commands.SLASH_COMMANDS[/arxiv-search]` | `{ id: 'arxiv-search', slash: '/arxiv-search', showButton: false, builtIn: true, prompt: <existing fn> }` | 不再硬编码在 ts |
| `slash-commands.SLASH_COMMANDS[/web-search]` | `{ id: 'web-search', slash: '/web-search', hint: 'usesWebSearch', showButton: false, builtIn: true }` | UI 提示需要 web_search 已开启 |

实施步骤草图：

1. 新建 `src/settings/prompt-shortcuts.ts`：定义 `PromptShortcut` 类型 + 默认列表 + load/save 一次成型；保持 `MAX_*` 常量。
2. 一次性迁移：第一次 load 时如果发现旧 `quickPrompts` 键，把 `builtIns + customButtons` 合并成 shortcut 列表写回新键 `extensions.zotero-ai-sidebar.promptShortcuts`，不做反复 normalize。
3. 删除 `src/ui/slash-commands.ts`，把 `expandSlashCommandMessage` 改写成消费 shortcut 列表（保持函数名不变，调用点 `src/modules/sidebar.ts:1101` 不动）。
4. UI：底栏按钮渲染逻辑从「内置三个 + 自定义」改成「showButton=true 的全部」。`hint='writesAnnotations'` 时加 🔒 图标，YOLO 关闭时 hover 提示原因。
5. Slash 自动补全已存在 `matchingSlashCommands(token)`：改成消费同一份列表。
6. Tests：`tests/settings/prompt-shortcuts.test.ts` 覆盖 (a) 默认值，(b) 旧→新迁移，(c) slash 唯一性，(d) `hint` 字段不影响 prompt 输出。

不要做的事（v1 已经写过，再次确认）：

- 不要给 PromptShortcut 加 `requiredTools: string[]`。`hint` 只用于 UI；不要让 prompt 假装能强约束模型工具选择。
- 不要做远端 shortcut 仓库 / 插件市场。共享配方就用 JSON 导入导出（一行 `JSON.stringify(shortcuts)`）。
- 不要把 PromptShortcut 和 MCP 配置混在一个 UI 面板里 —— 一个是 prompt，一个是 tool，混了反而难解释。

### Anthropic adapter 的 skill 缺口

`docs/TOOLS_AND_MCP.md` 里写了：Anthropic adapter 当前忽略 `tools`。这意味着所有 (b) 类 skill 在 Anthropic 选项下会失效（模型会按 prompt 里说的工具名说话，但其实没有 tool schema 给它）。

两种解决方向：

- 短期：UI 层在选 Anthropic 时禁用「全文高亮 / 解释选区」按钮，提示切换 OpenAI Responses。
- 长期：实现 Anthropic 的工具循环（`messages` API 已支持 tool_use/tool_result），让两套 provider 真的能力对齐。

## 四、给当前版本的具体下一步建议（迭代 2 重排）

价值/成本重估的关键发现：MCP 的现实可用面比 v1 想象的窄（公网 URL 约束 + 没有官方托管 server），所以 PromptShortcut 和 Anthropic 工具循环的相对价值上升。

按可实现性 × 价值排序：

1. **统一 slash + quick prompt → PromptShortcut**（中改、价值高）  
   迁移路径见上节。一处编辑、一处展示，slash 和按钮同步。受益面是 100% 用户。

2. **Anthropic 工具循环**（大改、价值高）  
   `src/providers/anthropic.ts` 当前忽略 `tools`，导致 `fullTextHighlight`/`explainSelection` 两个 (b) 类 shortcut 在 Anthropic 下不可用。`messages` API 已经支持 `tool_use`/`tool_result`，按 OpenAI adapter 的形态实现一遍即可。受益面：所有 Anthropic 用户。

3. **MCP UI 期望管理**（小改、价值中）  
   配置面板加「公网 URL + Base URL 兼容性」前置说明；预设改成「文档指针」而非 URL；选 `always` 时红字提示「需要审批 UI（暂未实现）」。这些是诚实成本，避免用户跳坑。

4. **MCP `always` 审批 UI 真正落地**（小改、价值取决于是否有人会用 always 模式）  
   `mcp_approval_request` 事件已识别，需要前端弹一个 inline approval 框。

5. **MCP 方案 B（嵌入客户端）做技术调研**（中改、价值待定）  
   只调研：Zotero XPI 能否启动子进程或建立 stdio MCP 连接？能否复用 Anthropic adapter 的 tool_use 形态？产出一份 spike 报告，不写代码。

6. **删除 `tool-settings.ts:6` 里的 legacy `arxivMcp` 字段**（清理，做不做无所谓，下个 minor 顺手做）。

一句话总结：

- **MCP 留给「真·远端服务」**：跨论文检索、私有知识库、重型外部能力。但目前 MCP 的实际可用面被「公网 URL + Base URL 兼容」两条约束限制，对一般用户接近 0；UI 应该诚实地说明门槛，而不是包装成「贴 URL 即用」。
- **「Skill」就是 prompt 模板**：合并 slash 和 quick prompt 成单一 `PromptShortcut`，别引入第三种「跑代码的 skill」概念。
- **Provider 平权很重要**：让 Anthropic 也跑工具循环，比 MCP 优化对一般用户更有感。

## 五、技术调研（迭代 3）

把迭代 2 留下的三个未知项做完。结论用于校准上面的优先级表。

### A. Zotero XPI 沙箱能否承载嵌入式 MCP 客户端？

结论：**可以**。HTTP 起步零成本，stdio 中等成本。

证据：

- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)：「plugins continue to provide full access to platform internals (XPCOM, file access, etc.)」。`Services`、`Cc`、`Ci` 在 bootstrap scope 里直接可用。和普通 WebExtension 不同。
- HTTP 请求：用 `fetch()` 或 `Zotero.HTTP.request` 直接打 `http://localhost:<port>/mcp`，无沙箱障碍。MCP Streamable HTTP transport 与 SSE 都可走 `fetch`（SSE 解析自己写或用现成 npm）。
- 子进程：`Components.classes['@mozilla.org/process/util;1']` 可启动外部进程；管道 IO 用 `nsIPipe`。已知 [zotero-better-bibtex](https://github.com/retorquere/zotero-better-bibtex) 等插件在生产里这样做。
- 依赖：`@modelcontextprotocol/sdk` 是纯 TypeScript，可以打到 XPI 里；不依赖 Node 内置（除非走 stdio child_process，需自己包一层）。

实操路线：

1. **第一步只支持 HTTP MCP**。用户 `npx arxiv-mcp-server --http --port 8000`，插件配 `http://localhost:8000/mcp`。完全够用，不需要子进程管理。
2. **远期可加 stdio MCP**。在偏好里支持 `command + args`，插件用 nsIProcess 起进程，pipe 接 stdio。但生命周期管理（Zotero 关闭时 kill 子进程）需要谨慎。
3. **复用 AgentTool 类型**：MCP 工具列表拉到本地后，每个工具包成一个 `AgentTool`，注入到 OpenAI 和 Anthropic 共用的工具池里。这样 provider 中立，不绑死 Responses API。

风险：

- Zotero 主线程上跑长连接 SSE 的稳定性需验证（Zotero 启动/关闭、网络中断、reload 插件）。
- MCP server 协议变化时插件 SDK 得跟。建议锚定 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 的稳定版本号。

### B. Anthropic 工具循环：复用 vs 平行实现？

结论：**平行实现**。共享一个小辅助函数 `executeAgentTool`，其余分开。

证据：

- `src/providers/anthropic.ts` 当前 140 行，只处理流式文本/思考增量，注释里明确写 `_options.tools` is intentionally ignored（第 9 行）。
- `src/providers/openai.ts` 的工具循环代码在 ~400-510 行段落，包括 function_call 收集、JSON 参数解析、本地工具执行、`function_call_output` 注入、hosted MCP 事件转 chunk。和 Responses API 的 `input` 数组、function_call 类型紧耦合。
- Anthropic Messages API 的工具协议形态完全不同：`tool_use` content block + `tool_result` content block，stop_reason 为 `tool_use` 时表示需要执行工具，下一轮把 `assistant`（含 tool_use 块）+ `user`（含 tool_result 块）追加进 messages 重新调用 stream。
- 共用什么：`executeAgentTool(call, tools, signal)` 这一层。共用不了的是消息构造、流事件解码、hosted tool 描述。

实施草图：

```ts
// src/providers/anthropic.ts 新增工具循环（伪代码）
async *streamWithTools(messages, system, preset, signal, options) {
  const conversation = toAnthropicMessages(messages);
  while (true) {
    const stream = await client.messages.stream({
      model, max_tokens, system, messages: conversation,
      tools: options.tools.map(toAnthropicToolSpec),
    }, { signal });
    const collected = await collectStream(stream);  // text + tool_uses
    yield* collected.chunks;                         // text/thinking deltas
    if (collected.stopReason !== 'tool_use') return;

    // 执行所有 tool_use，构造下一轮
    const toolResults = [];
    for (const use of collected.toolUses) {
      const tool = options.tools.find(t => t.name === use.name);
      const result = await executeAgentTool(tool, use.input, signal);
      toolResults.push({ type: 'tool_result', tool_use_id: use.id,
                         content: result.output, is_error: result.isError });
      yield { type: 'tool_call', name: use.name, status: result.status };
    }
    conversation.push({ role: 'assistant', content: collected.content });
    conversation.push({ role: 'user', content: toolResults });
  }
}
```

成本估算：

- 新代码：~250-350 行 in `anthropic.ts`（工具循环主干 + spec 转换 + 流事件解析）。
- 测试：~80-120 行 in `tests/providers/anthropic.test.ts`（覆盖 single-tool、multi-tool、tool error、abort）。
- 重构：把 `executeAgentTool` 从 `openai.ts:399-428` 抽到 `src/providers/_tool-runtime.ts`。

注意：

- Anthropic Messages API **没有** hosted MCP 类型（截至 2026-05）。所以 MCP 进 Anthropic 路径必须走方案 B（嵌入式客户端，重新登记成 AgentTool）。这强化了 A 节的结论。
- Hosted web_search 在 Anthropic 也是另一套 [server tools](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool)，和 OpenAI 形态不同。短期可以先不做。

### C. PromptShortcut 迁移 id 稳定性

结论：**没有 risk**，机械转换即可，user 自定义 id 已经稳定。

证据：

- `src/settings/quick-prompts.ts:124-134` 的 `uniqueID()` 已经持久化用户自定义按钮的 id；老配置升级到新结构时 id 不变。
- 内置三项是固定 key (`summary` / `fullTextHighlight` / `explainSelection`)，用作新 PromptShortcut 的 id 即可。
- `src/ui/slash-commands.ts:11` 的两条 slash 是 `name: '/arxiv-search'`、`/web-search`；新结构里 id 取 `arxiv-search` / `web-search`，slash 字段保留全名。

迁移代码草图（一次性，第一次 load 时执行）：

```ts
// src/settings/prompt-shortcuts.ts (新文件)
const NEW_KEY = 'extensions.zotero-ai-sidebar.promptShortcuts';
const OLD_KEY = 'extensions.zotero-ai-sidebar.quickPrompts';

export function loadPromptShortcuts(prefs: PrefsStore): PromptShortcut[] {
  const raw = prefs.get(NEW_KEY);
  if (raw) return parseShortcuts(raw);

  // Migrate from quickPrompts (one-shot)
  const legacyRaw = prefs.get(OLD_KEY);
  const legacy = legacyRaw
    ? normalizeQuickPromptSettings(JSON.parse(legacyRaw))
    : DEFAULT_QUICK_PROMPT_SETTINGS;
  const shortcuts: PromptShortcut[] = [
    builtIn('summary', '总结', '/summary', legacy.builtIns.summary),
    builtIn('fullTextHighlight', '全文重点', '/highlight',
            legacy.builtIns.fullTextHighlight, 'writesAnnotations'),
    builtIn('explainSelection', '解释选区', '/explain',
            legacy.builtIns.explainSelection),
    ...legacy.customButtons.map((b) => ({
      id: b.id, label: b.label, prompt: b.prompt,
      showButton: true, builtIn: false, hint: null,
    })),
    builtIn('arxiv-search', 'arXiv 搜索', '/arxiv-search',
            ARXIV_SEARCH_PROMPT, null, /* showButton */ false),
    builtIn('web-search', '联网搜索', '/web-search',
            WEB_SEARCH_PROMPT, 'usesWebSearch', /* showButton */ false),
  ];
  prefs.set(NEW_KEY, JSON.stringify(shortcuts));
  // GOTCHA: 不要立即删除 OLD_KEY，保留一个版本作为 rollback 安全网
  return shortcuts;
}
```

后续清理：

- 在 v0.4.x 删除 `OLD_KEY` 和 `src/settings/quick-prompts.ts`。
- `src/ui/slash-commands.ts` 在迁移完成的 v0.3.0 就可以删除（其逻辑被 PromptShortcut 取代）。
- `tests/settings/quick-prompts.test.ts` + `tests/ui/slash-commands.test.ts` 转写成 `tests/settings/prompt-shortcuts.test.ts`，覆盖 (a) 默认值、(b) 旧→新迁移、(c) 自定义 id 保留、(d) slash 唯一性、(e) hint 字段不影响 prompt 输出。

## 六、综合结论

迭代 3 之后的判断：

1. **PromptShortcut 重构是最值得做的下一步**：低风险（迁移机械）、高收益（统一 UX）、解锁后续工作（slash 用户可编辑、hint 字段为「写工具」UI 警告做铺垫）。
2. **Anthropic 工具循环是第二优先**：~300 行新代码 + 80 行测试，和 OpenAI 平行而非共享，保持代码清晰。受益面是 100% 的 Anthropic 用户。
3. **MCP 方案 B（嵌入式客户端）值得在 Anthropic 工具循环之后立项**：技术可行，能绕开 OpenAI 公网 URL 约束，且和 Anthropic 工具循环共享同一份 AgentTool 注入路径。但优先级低于 1、2，因为它依赖外部 MCP 生态。
4. **MCP 方案 A（OpenAI hosted MCP）保留现状不再加功能**：UI 上仅做期望管理（公网 URL 警告、`always` 红字）；不做预设 URL，不做 approval UI。
5. **legacy `arxivMcp` 字段在 v0.3.0 顺手删除**。

如果只能做一件事，做 **PromptShortcut 重构**：受益面最广、依赖最少、为后续 Anthropic 工具循环和 MCP 方案 B 都铺好路。

## 七、对自己的反驳 + Anthropic Agent Skills 的更正（迭代 4）

前面三轮都是顺着自己的论点写的，缺了批判。本节专门唱反调，加上一个迭代 1-3 都漏掉的事实更正。

### 7.1 事实更正：Anthropic 已经有官方「Agent Skills」

迭代 1-3 把「skill」一词当成「Claude Code slash 风格的 prompt 快捷方式」处理。这是不完整的。

事实（[Anthropic Agent Skills 文档](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), [github.com/anthropics/skills](https://github.com/anthropics/skills)）：

- Anthropic 已经把 **Agent Skills** 作为正式 API feature 推出。形态是「folders of instructions, scripts, and resources that agents discover and load dynamically」。
- 调用路径：Messages API 的 **code execution tool**，参数 `container = { type, skill_id, version }`。每次请求最多 8 个 skill。
- 已有官方 skill：PowerPoint / Excel / Word / PDF 文档处理。开源仓库收集社区贡献。
- **执行位置**：Anthropic 服务器端（受 code execution tool 控制），不是客户端。

这意味着「skill」在 Anthropic 上下文里有两个层面：

| 层面 | 谁实现 | 在本插件里的对应 |
| --- | --- | --- |
| **官方 Agent Skills**（Anthropic 服务端） | Anthropic + 用户上传 | 等价于 hosted MCP / hosted web_search：插件传 skill_id 进 request，服务端执行 |
| **prompt 快捷方式**（本插件「skill」一词的本意） | 插件本地、纯 prompt | 即 PromptShortcut |

所以本文之前的结论（「skill 就是 prompt 模板」）只适用于第二层。如果未来想接入第一层，UI 里要单独一行「Anthropic Agent Skills」配置（skill_id 列表），和 PromptShortcut 不混。优先级低于 Anthropic 工具循环 (#2)：先要有 tool loop，才轮得到 code execution + skills。

### 7.2 反对自己 — 三条 priorities 的反向论证

#### 反 #1（PromptShortcut 重构）：是不是本来就够用？

反方论点：

- 现有 slash + quick prompt 虽然分裂，但用户实际都从「按钮」入口（discoverable），slash 是高级用法。两套并存对**新手**不构成 UX 问题。
- 重构是 **breaking change**：迁移 prefs key、删除两个文件、改 UI 渲染、改测试。如果迁移代码有 bug，老用户的自定义按钮丢失。损失不可逆。
- 真正的痛点不是「分裂」而是「`fullTextHighlight` 会写 PDF，但 UI 不警示」。这个痛点用一行 if 和 🔒 图标就能解，不需要重构。

我的回应：

- 痛点列表：①「写工具」无 UI 警示（中等）、② slash 不可编辑（小，多数用户不用 slash）、③ 自定义按钮不能绑 slash（小）。痛点 ① 不需要重构就能解。
- 但重构换来的是：导出/导入（按 JSON 一行就行）、Anthropic Agent Skills 接入面（如果 skill_id 也作为 shortcut 列表的一项可以统一查找）、未来 MCP 方案 B 的工具警告（hint 字段统一处理）。
- 风险化解：迁移先**只读旧键**，新键写完后旧键保留两个版本作为 rollback。
- 调整后判断：仍然推荐做，但不是阻塞性 — 可以并行做痛点 ① 的快速修复，让重构慢慢来。

#### 反 #2（Anthropic 工具循环）：是不是只服务一小撮用户？

反方论点：

- 大部分使用 Zotero AI Sidebar 的用户填的是 OpenAI 兼容 base URL（DeepSeek、Doubao、月之暗面、本地 Ollama 走 OpenAI 协议都属此列）。原生 Anthropic 用户可能 < 30%。
- 实现 Anthropic 工具循环需要 ~350 行新代码，要再写一份消息构造、流事件解码、tool_use/tool_result 协议。维护成本翻倍。
- 而且 Anthropic 没有 hosted MCP，hosted web_search 是另一个产品形态 — 写完 tool loop 还要再补 hosted tool 适配，否则 provider 平权只到一半。

我的回应：

- 「OpenAI 兼容 base URL」的说法部分对：但很多代理只支持 chat completions，不支持 Responses API（也就是不支持函数工具）。这种用户当前已经无法用 Zotero 工具，他们要么换原生 Anthropic 要么忍受没工具。
- 350 行代码不是大数。和 OpenAI 工具循环一样，写完不会频繁改。
- hosted tool 适配可以另算账：先实现 function tool loop，hosted web_search/skills 后面再补。这样 #2 的范围其实是 **client-side tool loop only**，不包括 hosted tool 平权。
- 调整后判断：Anthropic 工具循环优先级**保持 #2**，但范围明确是「客户端工具循环」，不承诺 hosted 平权。

#### 反 #3（MCP 方案 B / 嵌入式客户端）：是不是 over-engineering？

反方论点：

- 真的有用户会本地起一个 MCP server 然后让 Zotero 插件连吗？现实里这是高级用户场景，<5%。
- 引入 `@modelcontextprotocol/sdk` 给 XPI 加约 200KB 体积，新增协议升级的维护负担。
- 如果只是为了 arXiv，本插件已经有内置 `paper_*` 工具；如果是 Semantic Scholar，可以直接做成内置 AgentTool（用 API key 走 fetch），完全不用 MCP。
- MCP 在生态里的实际用户是 IDE / Agent runtime 工程师，不是 Zotero 学术用户。Zotero 用户更可能愿意为 Semantic Scholar / OpenReview 装一个 Zotero 插件，而不是自部署 MCP server。

我的回应：

- 这是**最强的反驳**。重新考虑：方案 B 的真正用户面可能比想象的小，而内置 AgentTool 路线（直接 `fetch` Semantic Scholar API）能 cover 80% 学术 MCP server 的功能，且不依赖 MCP 协议。
- 调整后判断：**降级 #3。** 改为：「如果 Semantic Scholar 是常见请求，做一个内置 `paper_search_semantic_scholar` AgentTool（仿 `paper_search_arxiv`），比嵌入 MCP 更直接。」MCP 方案 B 推到 backlog，直到生态有不可替代的 server（如 Anthropic 的 PDF skill 类）出现。
- 这进一步强化：**MCP 在本插件的实际价值比 v1/v2 估计的还小。** 真正的杠杆在「直接做内置 AgentTool」。

### 7.3 最终优先级（迭代 4 收敛版）

| # | 项 | 类型 | 改动量 | 受益面 | 反驳后是否保留 |
| --- | --- | --- | --- | --- | --- |
| 1a | **`fullTextHighlight` 等写工具加 🔒 警示**（一次性小补丁） | 痛点修复 | < 50 行 | 所有用户 | ✅ 优先做，独立于重构 |
| 1b | **PromptShortcut 重构**（slash + quick prompt 合并） | 抽象统一 | ~400 行 + tests | 所有用户 | ✅ 保留，但不阻塞 |
| 2 | **Anthropic 客户端工具循环**（不含 hosted tool） | 平权 | ~350 行 + tests | Anthropic 用户 | ✅ 保留 |
| 3 | **学术服务做内置 AgentTool 而非 MCP**（如 paper_search_semantic_scholar） | 直连 API | ~150 行/服务 | 关心引用图谱的用户 | ✅ 替代了原 MCP 方案 B |
| 4 | MCP Path A UI 期望管理 + approval UI | UX | ~150 行 | 极少数公网 MCP 用户 | ⚠️ 降级，仅做期望管理，不做 approval UI |
| 5 | 删除 legacy `arxivMcp` 字段 | 清理 | -50 行 | 无 | ✅ 顺手做 |
| ✗ | MCP Path B（嵌入 MCP 客户端） | 重型 | ~600+ 行 | < 5% 用户 | ❌ **撤回**，改为内置 AgentTool 路径（即 #3） |
| 备 | Anthropic Agent Skills 接入（hosted） | 平权 | 中等 | Anthropic 用户 | 💡 待 #2 落地后再考虑 |

### 7.4 PromptShortcut 设置面板 UX 草稿（concrete）

现状（`addon/content/preferences.xhtml`）：

```
┌─ 账号与模型 ──────────────────────┐
│ ...                                │
└────────────────────────────────────┘
┌─ 快捷提示词按钮 ──────────────────┐
│  内置：[总结] [全文重点] [解释选区]│
│  自定义：[+ 新增按钮]              │
│  [保存提示词] [Reset 默认提示词]   │
└────────────────────────────────────┘
┌─ 联网与 MCP ──────────────────────┐
│ Web search 模式: [关闭 ▼]          │
│ MCP Servers: [+ MCP Server]        │
└────────────────────────────────────┘
```

PromptShortcut 收敛后（迭代 4 草案，名字仍叫「快捷提示词按钮」）：

```
┌─ 快捷提示词按钮 ──────────────────────────────────┐
│ 在底栏显示按钮，或 / 输入快捷指令；点 ⚙ 编辑提示词 │
│                                                    │
│ ┌─ 总结        /summary       [按钮 ☑]  ⚙ 🔄 ────┐│
│ │   prompt 预览（前 80 字）...                  │ │
│ └────────────────────────────────────────────────┘│
│ ┌─ 全文重点 🔒 /highlight     [按钮 ☑]  ⚙ 🔄 ────┐│
│ │   🔒 = 会写入 PDF 标注；YOLO 关闭时按钮变灰    │ │
│ │   prompt 预览...                              │ │
│ └────────────────────────────────────────────────┘│
│ ┌─ 解释选区    /explain       [按钮 ☑]  ⚙ 🔄 ────┐│
│ └────────────────────────────────────────────────┘│
│ ┌─ arXiv 搜索  /arxiv-search  [按钮 ☐]  ⚙ ───────┐│
│ │   仅 / 输入；不在底栏显示                      │ │
│ └────────────────────────────────────────────────┘│
│ ┌─ 联网搜索 🌐 /web-search    [按钮 ☐]  ⚙ ───────┐│
│ │   🌐 = 需要先在「联网」开启 web_search          │ │
│ └────────────────────────────────────────────────┘│
│                                                    │
│ + 新增 shortcut    [导入 JSON] [导出 JSON]         │
│ [保存] [全部 Reset 内置默认值]    ✓ 已保存         │
└────────────────────────────────────────────────────┘
```

要点：

- 一行 = 一个 shortcut。`☑/☐` 控制是否在底栏显示按钮（隐藏的仍能 / 触发）。
- ⚙ 展开提示词编辑器（textarea），🔄 仅 builtIn 项可见，按下 reset 单条到默认值。
- `🔒 writesAnnotations` / `🌐 usesWebSearch` 是 hint 字段渲染。Hint 不影响提交内容，只影响 UI。
- 无 hint 列表：看起来就是普通按钮。
- 「全部 Reset 内置默认值」按钮替代旧的 `zai-prompt-reset`，仅 reset `builtIn=true` 的条目。
- JSON 导入导出实现「分享配方」需求；远端 marketplace 不做。

### 7.5 更新后的「一句话总结」（迭代 5 进一步收敛）

- **MCP 在本插件接近过度配置：** 真正适合的服务（Semantic Scholar、OpenReview）做成内置 AgentTool（直连 API）比走 MCP 协议**更直接、更可控、更适合学术用户**。MCP UI 留给少数公网部署的高级用户，做诚实的期望管理就好。
- **「Skill」在本插件指 prompt 快捷方式（PromptShortcut）。** Anthropic 官方的 Agent Skills 是另一回事（服务端执行），未来可作为独立配置项接入 — 不要混进 PromptShortcut。
- **Provider 平权 > MCP 优化：** 让 Anthropic 跑通客户端工具循环对一般用户感知更强；hosted tool 平权可以延后。
- **如果真的只能做一件事，做 7.3 表里的 #1a（一次性小补丁）：** 给写工具加 🔒 警示。低风险、可见收益、不阻塞任何后续工作。

## 八、场景压力测试（迭代 5）

把前面的设计放进真实交互里看看哪里裂开。每个场景列：触发步骤 → 当前行为 → 预期/差距。

### 8.1 场景 A：模型切换 + shortcut 触发的组合

步骤：用户开 OpenAI preset，把 `/highlight` 点到底栏按钮 → 切换到 Anthropic preset → 点同一个按钮。

当前行为（验证于 `src/modules/sidebar.ts:911`）：

```
return "全文重点 v1 仅支持 OpenAI 工具循环";
```

已经有 ad-hoc 守卫，但是：

- 错误信息只是文字，不指向修复（用户不知道要切哪个 preset）。
- 同样的检查在 `:1190`（`/web-search` 阻断）、`:1383`（联网开关图标）、`:1574`（其它 OpenAI-only 路径）重复出现。守卫散落是技术债。

PromptShortcut 设计里要补的字段：

```ts
interface PromptShortcut {
  // ...上面的字段
  requiresLocalTools?: boolean;   // 例如全文重点：要 zotero_* 工具循环
  requiresWebSearch?: boolean;    // 例如 /web-search：要 webSearchMode != disabled
}
```

注意：这两个字段**仅做 UI 守卫**（按钮变灰、tooltip 解释、disabled 时点击给出可执行的错误「请切换到 OpenAI 兼容模型 / 启用 Web search」）。它们 **不** 用于强约束模型 — 模型仍然只看到 prompt 文字。这与迭代 1 「不要 requiredTools」的原则不冲突：那条原则反对的是「让 prompt 假装能强约束模型工具选择」，这里要做的是「让 UI 知道按钮在当前 provider 下可不可用」。

迭代 4 的 hint 字段（'writesAnnotations' / 'usesWebSearch'）和这两个 requires* 是**两类东西**：hint 是装饰（图标），requires* 是行为门控。建议保留两套字段。

### 8.2 场景 B：Shortcut 在流式 / 多轮工具调用过程中的取消

步骤：用户点 `/highlight` → 模型开始流，调用 `zotero_annotate_passage` 7 次 → 第 4 次后用户按 Stop / 切论文 / 关 Zotero。

当前行为：

- 已写入的标注（前 3 个）确实存到 Zotero item 上，关掉 Reader 也不丢。
- AbortSignal 会让 OpenAI stream 终止；正在 in-flight 的工具执行会抛 AbortError。
- 第 4 次 annotate 调用如果在数据库写到一半，Zotero 的 `Zotero.Annotations.saveFromJSON` 是事务性的，要么写成功要么不写。

差距：

- UI 没有「已部分完成」标识。用户看到的是「响应被中断」而不是「保存了 3/N 个标注」。
- 历史 ledger（context history）里这次 turn 是 partial，没有显式标记。下一轮模型看历史时可能困惑。

不需要在 PromptShortcut 重构里解决，但写工具的 shortcut 加 🔒 警示时，可以顺手在错误信息里说「已保存 N/M 个标注」。

### 8.3 场景 C：导入恶意/损坏的 JSON

步骤：用户从 PR 评论里 copy 一段 PromptShortcut JSON 粘贴到导入对话框 → 里面有 `id: "<script>"`、`prompt: 100MB 的字符串`、`slash: "/.."` 类型的奇怪值。

设计层防御（沿用 `quick-prompts.ts` 已有 normalize 模式）：

- 导入入口必须走 `normalizePromptShortcuts(JSON.parse(raw))`，不直接 set。
- `MAX_PROMPT_CHARS = 20000` 已存在，导入时先按这个截断。
- `slash` 必须 `^/[a-z][a-z0-9-]{0,31}$`；不合规丢弃 slash 字段，shortcut 本身仍可用作按钮。
- `id` 经过 `uniqueID()` 强制 `[A-Za-z0-9_-]`。
- 字段名白名单：未知字段直接丢，不做透传。
- 导入数量上限沿用 `MAX_CUSTOM_BUTTONS = 12`（自定义按钮数量），加上 builtIns 总条数 ≤ 20。

iteration 4 的 UX 草稿提到「导入 JSON / 导出 JSON」按钮，文档里要明确这一段防御逻辑。

### 8.4 场景 D：Slash 命名冲突

步骤：用户新增自定义按钮 → 起 slash 为 `/summary`（已被内置 `summary` shortcut 占用）。

期望行为：

- 保存时校验，提示「该 slash 已被 summary 使用」。
- 不允许保存（save 按钮 disabled 或弹错）。
- builtIn shortcut 的 slash 可以编辑（用户也许想换名字），但要保证全局唯一。

实现成本：在 normalize 里做一次重复扫描，UI 在 onChange 时给即时反馈即可。

### 8.5 场景 E：Reader 里没有 PDF / 选区

步骤：用户在没打开 PDF 的 item 上点 `/highlight`。

当前行为：内置 prompt 第 2 步要 `zotero_get_reader_pdf_text`，工具会返回 error。Loop 拿到 error 后由模型决定继续还是放弃。多数情况下模型会停止并报告「无法读取 PDF」。

差距：用户看到的错误经过模型转述，可能不准确（模型有时会试图用 `zotero_get_full_pdf` 替代）。

不需要在重构里解决，但 PromptShortcut 草稿里的 `requiresLocalTools` 可以扩展为 `requiresContext: 'pdf' | 'selection' | null`，进一步前置守卫。**但这扩展跨度太大，先不做** — 留给后续看是否有需求。

### 8.6 场景 F：多 Zotero 窗口

步骤：用户开两个 Zotero 窗口指向同一 profile → 在窗口 A 修改 PromptShortcut → 窗口 B 是否同步？

当前 quick-prompts 行为：保存后会 `刷新侧边栏`（在偏好 Reset 按钮里实现）。但偏好窗口和侧边栏是同进程同 profile，所以底层 prefs 一致；侧边栏需要主动重新 `loadQuickPromptSettings()` 才能反映。

设计上沿用：保存 PromptShortcut 后，发一个全局事件 → 所有打开的侧边栏 listener 重新加载。侧边栏渲染 shortcut 按钮时**不要**缓存到组件实例外面，每次渲染都从 prefs 读。

### 8.7 场景 G：MCP 服务器 URL 在 OpenAI 那边超时（实操可见）

步骤：用户填 `http://localhost:8000`（不是公网）→ 启用 → 发一条消息。

当前行为（`src/providers/openai.ts:704`）：等 ~30s 后给出超时错误，提示 hosted MCP 不支持。

差距：错误是事后的。迭代 4 已建议「配置时讲清门槛」，这里坐实它的形式：

- 启用 MCP server 那一刻，正则匹配 URL 是否是 `http://localhost`/`http://127.0.0.1`/`http://192.168.*`/ngrok 风格 → 任一是私网 → 黄色警告条「OpenAI 服务器无法访问私网地址；需要 ngrok / Cloudflare Tunnel 等公网暴露」。
- 不阻止保存（用户可能就是要测试），但错误状态从「30 秒超时」变成「保存即时见到」。

### 8.8 边界结论

- PromptShortcut 字段补两条：`requiresLocalTools?: boolean` + `requiresWebSearch?: boolean`。它们是 UI 行为门控（区别于 hint 装饰）。
- 迁移机制保留：导入有 normalize 防御；slash 唯一性校验；MAX_* 常量沿用。
- 多窗口、流式取消、Reader 缺失 PDF 这三类场景**不需要为了 PromptShortcut 改**，但需要在 PR 描述里记一笔，避免重构时回归。
- MCP UI 加私网 URL 即时警告，把「30 秒超时」前移到「保存即时见到」。

## 九、执行清单（迭代 5 收尾）

如果按 7.3 + 八节的 PromptShortcut 字段去做实现，最小补丁拆成 PR 大概是：

| PR | 内容 | 大小 | 触达文件 |
| --- | --- | --- | --- |
| **PR-1** | `fullTextHighlight` 等写工具的 🔒 UI 警示 | < 50 行 | `src/modules/sidebar.ts`、`addon/content/sidebar.css` |
| **PR-2** | 新建 `prompt-shortcuts.ts`（数据模型 + 默认值 + 迁移），不改 UI | ~250 行 + tests | `src/settings/prompt-shortcuts.ts`、`tests/settings/...` |
| **PR-3** | UI 切换：底栏按钮和 slash 自动补全消费新数据；删除 `slash-commands.ts`，旧 quick-prompts 逻辑保留作为 fallback | ~200 行 + tests | `src/modules/sidebar.ts`、`src/ui/slash-commands.ts`（删）、preferences.xhtml |
| **PR-4** | 偏好面板新 UX（7.4 草稿）；JSON 导入导出；slash 唯一性校验 | ~300 行 + tests | `src/hooks.ts`、`addon/content/preferences.xhtml` |
| **PR-5** | Anthropic 客户端工具循环（不含 hosted） | ~350 行 + tests | `src/providers/anthropic.ts`、`src/providers/_tool-runtime.ts`（抽 helper） |
| **PR-6** | MCP UI 期望管理：私网 URL 警告 + 兼容 base URL 提示 + `always` 红字 | ~80 行 | `src/hooks.ts`、preferences.xhtml |
| **PR-7** | （可选）Semantic Scholar 内置 AgentTool | ~150 行 + tests | `src/context/paper-tools.ts`、`tests/context/...` |
| **PR-8** | 清理 legacy `arxivMcp` | -50 行 | `src/settings/tool-settings.ts`、tests |

PR-1 是 stand-alone，不依赖任何重构，可以立即上。PR-5 也不依赖 PromptShortcut，可以并行。PR-2 → PR-3 → PR-4 是顺序依赖。

总成本估算：PR-1 + PR-5 一周内可以完整 ship；PromptShortcut 三连（PR-2/3/4）大约一周；PR-6 + PR-7 + PR-8 是清理工作，半天。整体一个 minor 版本（v0.3.0）可以走完。
