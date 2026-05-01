# 工具类、Web Search 与 MCP 使用说明

本文档用于统一 Zotero AI Sidebar 里的“工具”概念：什么时候做成本地工具类，什么时候打开托管 Web Search，什么时候才需要 MCP，以及用户侧应该怎样配置。

## 设计原则

- 模型负责判断要不要用工具；插件不要用本地关键词、正则或语义规则替模型决定“用户想总结论文/查论文/读 PDF”。
- 插件负责提供工具 schema、校验参数、执行本地能力、限制预算、展示工具调用轨迹。
- 工具说明应该放在 `tools` schema 的 `name` / `description` / `parameters` 里，而不是写一堆硬编码流程提示词。
- 系统提示可以说明总体约束，例如“模型决定工具，harness 执行工具”；不要写“看到 arXiv 链接必须调用某个工具”这种路由规则。
- 能稳定内置在插件里的能力优先做成本地工具类；需要连接外部工具服务器、动态工具列表或跨客户端复用时再考虑 MCP。

## 三类能力的区别

| 类型 | 谁执行 | 配置位置 | 适合做什么 | 当前状态 |
| --- | --- | --- | --- | --- |
| 本地工具类 `AgentTool` | Zotero 插件本地执行 | 代码内注册；通常不需要用户配置 | 当前 Zotero 条目/PDF/标注/笔记、固定 arXiv 读取、可控的本地读写 | 已实现，OpenAI Responses 路径可用 |
| OpenAI 托管 `web_search` | OpenAI/兼容服务端执行 | 聊天区联网按钮或偏好设置里的“内置联网” | 查网页、查最新信息、找后续工作或代码线索 | 已实现开关，但自定义 Base URL 不一定支持 |
| MCP | 模型服务连接外部 MCP server 执行 | 需要 server label、server URL、allowed tools、approval | 独立外部服务、动态工具、跨客户端复用、复杂远程能力 | 代码保留支持；当前 UI 不再要求用户为 arXiv 配 MCP |

## 什么时候用本地工具类

用本地工具类的判断标准：这个能力由插件自己就能可靠完成，并且和 Zotero 当前状态或固定数据源强相关。

适合本地工具类：

- 读取当前 Zotero 条目：标题、作者、年份、摘要、标签。
- 读取当前 PDF：全文缓存、局部检索、字符范围扩展。
- 读取 Zotero 标注：高亮、注释、页码、颜色、顺序。
- 读取 Reader 文本层：给写入高亮/批注时定位原文。
- 写 Zotero 批注或高亮：必须是显式写工具，并受权限/YOLO 控制。
- 固定 arXiv 能力：根据 arXiv URL/ID/标题搜索元数据、读取 ar5iv HTML 文本。

当前关键文件：

- `src/context/agent-tools.ts`：注册 Zotero 本地工具和内置 arXiv 工具。
- `src/context/paper-tools.ts`：固定内置 arXiv 工具。
- `src/providers/types.ts`：`AgentTool` / `ToolExecutionResult` 类型。
- `src/providers/openai.ts`：把 `AgentTool` 转成 OpenAI Responses function tools，并执行工具循环。

本地工具类的配置方式：

1. 用户选择一个 OpenAI Responses 兼容的模型配置。
2. 插件每轮对话创建工具 session，把工具列表传给 provider。
3. provider 将工具 schema 发送给模型，`tool_choice: 'auto'`。
4. 模型如果发出 function call，插件本地执行并把结果作为 `function_call_output` 送回模型。
5. 聊天界面展示工具调用轨迹。

注意：当前 Anthropic adapter 还没有实现工具循环，`src/providers/anthropic.ts` 会忽略 `options.tools`。需要 Zotero/PDF/arXiv 工具时，应选择 OpenAI Responses 兼容配置。

## 什么时候用 Web Search

Web Search 是模型服务端提供的托管联网搜索，不是 MCP，也不是插件本地工具。

适合打开 Web Search：

- 用户问“最新进展”“后续工作”“有没有代码”“最近引用/实现”。
- 用户给的是论文名字，但想查网页上的代码仓库、项目页、新闻或相关讨论。
- 当前 Zotero PDF 或 arXiv 正文工具不足以回答，需要查公开网页。

不适合只依赖 Web Search：

- 用户要求总结一个 PDF 全文。
- 用户给 `https://arxiv.org/pdf/...` 并要求逐章/全文分析。
- 需要稳定下载 PDF 并抽取正文。

对 arXiv 论文正文，优先让模型使用内置 `paper_fetch_arxiv_fulltext`。Web Search 可以作为补充，用来找代码、后续工作、引用、项目页。

Web Search 配置方式：

- 聊天输入区的“联网”按钮只做开启/关闭，不展示 arXiv 或 Cached/Live 细节。
- Zotero 设置里的“联网与 MCP”可以选择：
  - `关闭`：不把 `web_search` 交给模型。
  - `Cached`：传入 OpenAI 托管 `web_search`，中等搜索上下文。
  - `Live`：传入 OpenAI 托管 `web_search`，更高搜索上下文。
- 只有 OpenAI Responses 兼容 provider 才会生效。
- 自定义 Base URL 可能只兼容普通对话，不支持 hosted `web_search` 流式事件；这种情况下会表现为长时间卡住或返回工具不支持错误。

## 什么时候才是 MCP

MCP 适合“外部工具服务器”场景。它不是“联网”的同义词，也不是“arXiv”的必需项。

适合 MCP：

- 工具运行在独立服务里，而不是 Zotero 插件本地代码里。
- 一个服务暴露多个工具，工具列表可能动态变化。
- 同一个工具服务希望被 Codex、Claude、Zotero 插件等多个客户端复用。
- 工具需要独立部署、独立认证、访问数据库或内部服务。
- 工具能力太重，不适合打包进 Zotero XPI。

不适合 MCP：

- 当前 Zotero 条目、PDF、Reader、标注等本地状态访问。
- 固定且轻量的 arXiv 元数据搜索/HTML 文本读取。
- 只想让模型知道“有这个工具”，但工具实际由插件本地实现。
- 本地 Codex/Claude Skill，例如 `/arxiv-search`。Skill 不是 MCP；除非把它改造成 MCP server，否则 Zotero 插件不能直接调用。

MCP 配置通常需要：

- `server_label`：模型看到的 MCP 服务名，例如 `arxiv`。
- `server_url`：MCP server 地址。
- `allowed_tools`：允许模型使用的工具白名单。
- `require_approval`：是否需要人工审批。
- provider/base URL 必须支持 Responses hosted MCP。

当前产品决策：arXiv 先不走 MCP。插件固定内置 `paper_search_arxiv` 和 `paper_fetch_arxiv_fulltext`，用户不需要填 MCP URL。

配置入口：

- 账号和模型配置放在 Zotero 设置 -> AI 对话 -> “账号与模型”；保存时会先测试连接，通过后才写入配置。
- Web Search 和通用 MCP 放在 Zotero 设置 -> AI 对话 -> “联网与 MCP”。
- “总结论文 / 全文重点 / 解释选区”和自定义快捷按钮放在 Zotero 设置 -> AI 对话 -> “快捷提示词按钮”。
- 快捷按钮必须有提示词；没有提示词的自定义按钮不会保存。
- `Reset 默认提示词` 会把内置快捷提示词恢复到默认值并立即刷新侧边栏。

## arXiv 论文应该怎样配置

目标问题：

```text
https://arxiv.org/pdf/1506.02640 总结这篇论文
```

推荐配置：

1. 使用 OpenAI Responses 兼容模型配置。
2. 不需要配置 arXiv MCP。
3. 不强制打开 Web Search；总结 arXiv 正文主要靠内置 arXiv 工具。
4. 如果还要查最新代码、后续工作或项目页，再把联网切到 `Web search` 或 `Web search · Live`。
5. 确认聊天里能看到工具轨迹，例如 `paper_fetch_arxiv_fulltext`。

内置 arXiv 工具流程由模型自己选择：

- `paper_search_arxiv`：根据标题、主题、arXiv ID 或 URL 查 arXiv 元数据和 PDF URL。
- `paper_fetch_arxiv_fulltext`：根据 arXiv URL/ID/标题读取 ar5iv HTML 正文；失败时退回摘要。
- 如果返回内容被截断，模型可以继续用上次结果里的 `Range` 请求后续字符范围。

这不是本地硬编码路由：插件只是把工具 schema 交给模型，模型根据问题自己决定是否调用。

## 和 Codex 工作模式的对应关系

本项目希望保持类似 Codex 的 harness 模式：

- 工具由本地 harness 或托管服务提供。
- 模型通过工具 schema 理解可用能力。
- `tool_choice: 'auto'`，模型自己选择是否调用。
- harness 执行本地工具，返回结构化输出。
- 工具输出进入下一轮模型输入，直到模型给出最终文本。
- 本地代码不写“如果用户说总结 arXiv 就调用 X”的语义路由表。

差异是：Codex CLI 可能有 shell、文件系统、web_search、MCP 等宿主能力；Zotero 插件只能使用自己在 XPI 里实现并暴露的能力，以及当前 provider 支持的 hosted tools。

## 常见故障判断

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| arXiv 链接总结时一直卡住 | Base URL 不支持 hosted `web_search`/MCP 流式事件，或模型没有正常输出工具调用 | 先关闭 Web Search，只保留内置 arXiv 工具；确认使用 OpenAI Responses 兼容配置 |
| 没有看到 `paper_fetch_arxiv_fulltext` 工具轨迹 | provider 不支持 function tools，或自定义代理丢弃了 `tools` 字段 | 换官方/确认支持 Responses function calling 的 Base URL；检查聊天工具轨迹 |
| 只总结了摘要，没有正文 | ar5iv 不可用或该论文 HTML 转换失败 | 提示用户导入 Zotero PDF，或后续增加 PDF 下载+文本抽取工具 |
| Web Search 打开后仍不能读 PDF 全文 | Web Search 主要是网页搜索，不保证下载/解析 PDF | 用内置 arXiv 工具或 Zotero PDF 工具读正文 |
| MCP 配置看不到 | 当前 UI 不再把 arXiv 当作用户配置 MCP | 这是预期；arXiv 是固定内置工具，不需要 MCP URL |
| 选择 Anthropic 后不能用 Zotero 工具 | Anthropic adapter 当前没有工具循环 | 暂用 OpenAI Responses 兼容配置，或后续为 Anthropic 实现 tool loop |

## 新增能力时的选择清单

新增一个能力前，先按顺序判断：

1. 是否需要访问当前 Zotero/Reader/本地插件状态？是的话，做成本地 `AgentTool`。
2. 是否是固定、轻量、插件可以直接实现的外部读取？是的话，优先做成本地 `AgentTool`。
3. 是否只是查公开网页或最新信息？优先用 hosted `web_search`。
4. 是否需要独立服务、动态工具、多客户端复用、复杂认证或重型依赖？这时才做 MCP。
5. 是否只是快捷输入模板？做 slash command 或 UI 按钮，不要伪装成 MCP。

新增本地工具的最小步骤：

1. 在 `src/context/agent-tools.ts` 或独立文件里实现 `AgentTool`。
2. 写清楚 `description` 和 `parameters`，让模型能自己判断使用场景。
3. 在 `src/context/policy.ts` 增加必要预算，不要散落 magic number。
4. 如果有新的上下文类型，更新 `src/context/types.ts` 和 `src/context/message-format.ts`。
5. 在 `tests/context/` 或 `tests/providers/` 增加测试。
6. 确认 UI 能展示工具轨迹，失败时返回结构化错误。

新增 MCP 的最小步骤：

1. 明确 MCP server 的 URL、工具名、输入输出和认证方式。
2. 在设置 UI 暴露 `server_label`、`server_url`、`allowed_tools`、`require_approval`。
3. 在 `src/settings/tool-settings.ts` 持久化并 normalize 配置。
4. 在 `src/providers/openai.ts` 组装 hosted MCP tool spec。
5. 增加测试，覆盖工具 spec、MCP list/call/error/approval 事件。
6. 在 UI 提示自定义 Base URL 可能不支持 hosted MCP。
