import { currentUiLanguage, type UiLanguage } from "./settings/language";

// Chinese is the source locale. Keeping source strings at their call sites
// makes the existing UI easy to audit while this table provides one canonical
// English rendering for every built-in label, hint, tooltip and status.
const EN: Record<string, string> = {
  界面语言: "Interface language",
  中文: "Chinese",
  English: "English",
  "切换后立即刷新插件界面；不会翻译论文内容、聊天消息、笔记或自定义提示词。":
    "The plugin interface updates immediately. Paper content, chat messages, notes, and custom prompts are never translated.",
  账号与模型: "Accounts and models",
  "在 Zotero 设置里统一管理 Provider、API Key、Base URL、模型列表和推理参数。保存后侧边栏立即刷新。":
    "Manage providers, API keys, base URLs, model lists, and reasoning options in one place. The sidebar refreshes after you save.",
  "配置本地 ChatGPT（Codex）、OpenAI 兼容接口或 Anthropic。可设置 API Key、Base URL、模型列表和推理参数。保存后侧边栏立即刷新。":
    "Configure local ChatGPT (Codex), an OpenAI-compatible endpoint, or Anthropic. Set API keys, base URLs, model lists, and reasoning options. The sidebar refreshes after you save.",
  "检测本地 ChatGPT 登录": "Detect local ChatGPT sign-in",
  保存账号配置: "Save account settings",
  逐段翻译设置: "Paragraph translation",
  "侧边栏和 PDF Reader 里只保留「译」开关；模型、思考程度、上下文和快捷键在这里统一保存。翻译设置会参与 WebDAV 云同步。":
    "The sidebar and PDF Reader only show the translation toggle. Configure the model, reasoning level, context, and shortcuts here. Translation settings are included in WebDAV sync.",
  "GPT 配置": "GPT account",
  模型: "Model",
  思考程度: "Reasoning level",
  上下文: "Context",
  结果位置: "Translation position",
  翻译框大小: "Translation panel size",
  触发方式: "Trigger",
  下一段快捷键: "Next-paragraph shortcut",
  上一段快捷键: "Previous-paragraph shortcut",
  "例如：Enter 或 Alt+N": "For example: Enter or Alt+N",
  "例如：Shift+Enter 或 Alt+P": "For example: Shift+Enter or Alt+P",
  "例如：🙂 或 https://.../avatar.png":
    "For example: 🙂 or https://…/avatar.png",
  "例如：🤖 或 data:image/png;base64,...":
    "For example: 🤖 or data:image/png;base64,…",
  "留空用默认；例如：LXGW WenKai, Noto Serif CJK SC, serif":
    "Leave blank for the default; for example: Inter, Georgia, serif",
  "例如：https://dav.jianguoyun.com/dav/":
    "For example: https://dav.jianguoyun.com/dav/",
  "坚果云：你的注册邮箱": "Nutstore: your registered email address",
  "坚果云需在网页端「安全选项」生成应用密码":
    "For Nutstore, generate an app password under Security Options on the website",
  保存翻译设置: "Save translation settings",
  仅本段: "Current paragraph only",
  本段上下文: "Surrounding paragraphs",
  整页: "Entire page",
  段落上方: "Above the paragraph",
  段落下方: "Below the paragraph",
  "大号（默认）": "Large (default)",
  "自适应（尽量展开）": "Adaptive (expand when possible)",
  单击翻译: "Translate on click",
  双击翻译: "Translate on double-click",
  "Low - 省 token，推荐翻译使用":
    "Low — efficient; recommended for translation",
  "Medium - 平衡": "Medium — balanced",
  "PDF 注释颜色预设": "PDF annotation color presets",
  "配置 AI 写入 PDF 注释时允许使用的颜色分类。保存后会追加到 Zotero tool manual；Reset 可恢复默认预设。":
    "Define the color categories the AI may use when writing PDF annotations. These are appended to the Zotero tool manual after saving; Reset restores the defaults.",
  "配置写入 PDF 注释时传给模型的颜色预设；保存后会追加到 Zotero tool manual。":
    "Color presets passed to the model when it writes PDF annotations. They are appended to the Zotero tool manual after saving.",
  保存颜色预设: "Save color presets",
  "Reset 颜色预设": "Reset color presets",
  "PDF 新增文字（T 工具）": "PDF Add Text (T tool)",
  "点击「🅣 新增文字」时使用的默认字号（PDF 点）。范围 8–48，对应 Zotero Reader「新增文字 / Add Text」工具的可选区间。":
    "Default font size, in PDF points, used by “🅣 Add Text.” The 8–48 range matches Zotero Reader’s Add Text tool.",
  默认字号: "Default font size",
  保存字号: "Save font size",
  显示设置: "Display settings",
  "配置消息昵称、头像和消息按钮。头像可以填写 emoji、短文本，或图片 URL / data:image。":
    "Customize display names, avatars, and message actions. An avatar may be an emoji, short text, an image URL, or a data:image value.",
  我的昵称: "My display name",
  我的头像: "My avatar",
  "AI 昵称": "AI display name",
  "AI 头像": "AI avatar",
  聊天字体: "Chat font",
  消息按钮位置: "Message action position",
  消息按钮样式: "Message action style",
  右上角: "Top right",
  右下角: "Bottom right",
  边缘浮层: "Floating at edge",
  气泡里: "Inside message bubble",
  回复进行中允许排队新消息:
    "Queue new messages while a response is in progress",
  "开启后可在 AI 回答时插队新消息，当前回复结束后按提交顺序逐条执行；PDF 选区以入队时为准。":
    "When enabled, messages submitted during a response are queued and run in order. Any PDF selection is captured when the message enters the queue.",
  保存显示设置: "Save display settings",
  快捷提示词按钮: "Quick-prompt buttons",
  "可编辑“总结论文 / 全文重点 / 解释选区”的提示词，也可以新增自定义按钮。自定义按钮可配置 PDF 单键快捷键，例如 t 触发 translate；焦点在 PDF Reader 且不是输入框时生效。":
    "Edit the Paper summary, Highlight key passages, and Explain selection prompts, or add custom buttons. A custom button can use a single-key PDF shortcut, such as T for translate, while focus is in the PDF Reader and outside an input field.",
  自定义按钮: "Custom buttons",
  "+ 新增按钮": "+ Add button",
  保存提示词: "Save prompts",
  "Reset 默认提示词": "Reset default prompts",
  "联网与 MCP": "Web access and MCP",
  "聊天区只做“联网”开关；Cached/Live 和 MCP 在这里配置。内置 arXiv 论文读取不是 MCP，不需要 Server URL。":
    "The chat composer only provides an online-access toggle. Configure Cached/Live search and MCP here. Built-in arXiv retrieval is not MCP and does not require a server URL.",
  "Web search 模式": "Web search mode",
  禁用: "Disabled",
  "Cached - OpenAI 托管搜索": "Cached — OpenAI-hosted search",
  "Live - OpenAI 托管搜索，高上下文":
    "Live — OpenAI-hosted search with extended context",
  "MCP 配置功能正在开发中": "MCP configuration is under development.",
  "保存联网/MCP配置": "Save web/MCP settings",
  配置备份: "Configuration backup",
  "备份/恢复账号、快捷提示词、联网/MCP 和逐段翻译配置。备份文件可能包含 API Key，请保存在可信位置。":
    "Back up or restore accounts, quick prompts, web/MCP, and paragraph-translation settings. Backup files may contain API keys; keep them in a trusted location.",
  导出配置文件: "Export configuration",
  导入配置文件: "Import configuration",
  "手动备份/恢复": "Manual backup and restore",
  "用于手动复制、检查或粘贴配置 JSON。内容可能包含 API Key，请勿公开分享。":
    "Copy, inspect, or paste configuration JSON manually. It may contain API keys; do not share it publicly.",
  "点击“生成配置 JSON”后复制；需要手动恢复时，把备份 JSON 粘贴到这里再导入。":
    "Click “Generate configuration JSON” to copy it. To restore manually, paste backup JSON here and import it.",
  "生成配置 JSON": "Generate configuration JSON",
  "复制配置 JSON": "Copy configuration JSON",
  从文本导入: "Import from text",
  "云同步（WebDAV）": "Cloud sync (WebDAV)",
  "把账号预设、快捷提示词、联网/MCP 设置、显示设置、逐段翻译设置和对话历史同步到 WebDAV 云盘（坚果云 / NextCloud / ownCloud / Synology 等）。论文 PDF 和元数据请继续使用 Zotero 自带的同步（设置 → 同步 → 文件同步 → WebDAV，可指向同一个 WebDAV 账号）。":
    "Sync account presets, quick prompts, web/MCP settings, display settings, paragraph-translation settings, and chat history to WebDAV (Nutstore, Nextcloud, ownCloud, Synology, and others). Continue using Zotero’s built-in sync for PDFs and metadata (Settings → Sync → File Syncing → WebDAV); it may use the same WebDAV account.",
  用户名: "Username",
  "密码 / 应用密码": "Password / app password",
  云端目录: "Remote folder",
  测试连接: "Test connection",
  上传到云端: "Upload to cloud",
  从云端下载: "Download from cloud",
  保存账号: "Save account",
  "正在检测本地 ChatGPT 登录和可用模型…":
    "Detecting local ChatGPT sign-in and available models…",
  "该账号没有可用的 Codex 模型。":
    "No Codex models are available for this account.",
  "已新增 OpenAI 配置，保存后生效。": "OpenAI account added. Save to apply it.",
  "已新增 Anthropic 配置，保存后生效。":
    "Anthropic account added. Save to apply it.",
  "显示设置已保存，侧边栏已刷新。":
    "Display settings saved; the sidebar has been refreshed.",
  "已恢复默认提示词并立即生效。":
    "Default prompts restored and applied immediately.",
  "联网/MCP配置已保存，下一次请求立即使用。":
    "Web/MCP settings saved and will be used by the next request.",
  "PDF 注释颜色预设已保存，下一次请求立即使用。":
    "PDF annotation color presets saved and will be used by the next request.",
  "PDF 注释颜色预设已恢复默认并立即生效。":
    "Default PDF annotation color presets restored and applied immediately.",
  已重置: "Reset",
  "手动备份文本已清空。": "Manual backup text cleared.",
  "WebDAV 账号已保存。": "WebDAV account saved.",
  "正在测试 WebDAV 连接…": "Testing the WebDAV connection…",
  已连接: "Connected",
  "正在打包并上传到云端…": "Packaging and uploading to the cloud…",
  已上传: "Uploaded",
  "已取消下载。": "Download canceled.",
  "正在从云端下载并应用配置…":
    "Downloading and applying the cloud configuration…",
  已下载: "Downloaded",
  "已取消导出。": "Export canceled.",
  "已取消导入。": "Import canceled.",
  已导出: "Exported",
  已生成: "Generated",
  已复制: "Copied",
  "请先粘贴配置 JSON。": "Paste configuration JSON first.",
  已导入: "Imported",
  "已加载账号配置。": "Account settings loaded.",
  "请先保存 GPT 配置": "Save a GPT account first",
  "已加载逐段翻译设置。": "Paragraph translation settings loaded.",
  "请先在“账号与模型”里保存一个 OpenAI/GPT 配置。":
    "Save an OpenAI/GPT account under Accounts and models first.",
  无可用模型: "No models available",
  "逐段翻译设置已保存；下一次翻译立即使用。":
    "Paragraph translation settings saved and will be used immediately.",
  "已加载显示设置。": "Display settings loaded.",
  "配置未改变，直接保存...": "No changes detected; saving directly…",
  "连接测试通过，账号配置已保存，侧边栏已刷新。":
    "Connection test passed. Account settings were saved and the sidebar was refreshed.",
  测试并保存新增账号: "Test and save new accounts",
  账号配置没有新增或未保存改动: "No new or unsaved account changes",
  "连接超时或已取消，未保存。":
    "Connection timed out or was canceled; nothing was saved.",
  "已加载提示词配置。": "Prompt settings loaded.",
  "普通选区提问后会自动生成建议注释，已直接保存。":
    "Suggested annotations will be generated after selection questions. The setting was saved.",
  "普通选区提问后不再自动生成建议注释，已直接保存。":
    "Suggested annotations will no longer be generated after selection questions. The setting was saved.",
  "提示词已保存，侧边栏按钮立即刷新。":
    "Prompts saved; sidebar buttons were refreshed.",
  "内置快捷按钮的提示词不能为空。":
    "Built-in quick-prompt text cannot be empty.",
  "自定义提示必须填写提示词。": "A custom prompt must include prompt text.",
  "自定义提示至少填写按钮名称或 PDF 快捷键。":
    "A custom prompt needs a button label or PDF shortcut.",
  "焦点在 PDF Reader 时按这个单键触发；支持 a-z / 0-9。":
    "Press this single key while focus is in the PDF Reader. Supports A–Z and 0–9.",
  "留空表示不限制工具；或填写 search, read_pdf":
    "Leave blank to allow all tools, or enter search, read_pdf",
  复制成功: "Copied",
  "本轮仅发送题录/摘要信息":
    "Only bibliographic metadata and the abstract were sent",
  "本轮请求 Zotero 标注，但未找到可发送内容":
    "Zotero annotations were requested, but none were available to send",
  本轮未发送论文正文: "No paper text was sent in this turn",
  设置: "Settings",
  "AI 对话": "AI Chat",
  新建对话: "New chat",
  新建普通对话: "New general chat",
  新建当前论文对话: "New chat for current paper",
  未打开对话: "No chat open",
  对话: "Chats",
  总结论文: "Summarize paper",
  全文重点: "Highlight key passages",
  "🔖 全文重点": "🔖 Highlight key passages",
  解释选区: "Explain selection",
  复制MD: "Copy Markdown",
  字号: "Font size",
  调试: "Debug",
  截图: "Screenshot",
  图片: "Image",
  新对话: "New chat",
  添加模型: "Add model",
  清空: "Clear",
  无论文: "No paper",
  先配置: "Set up first",
  全文缓存: "Full-text cache",
  本地缓存: "Local cache",
  即时翻译: "Live translation",
  点译段落: "Click-to-translate paragraph",
  未选择条目: "No item selected",
  查看: "View",
  移除: "Remove",
  再看: "Review",
  刚刚: "Just now",
  队列: "Queue",
  "AI 对话正在恢复": "Restoring AI Chat",
  "Zotero 刚加载时界面还没稳定，插件会自动重试。":
    "Zotero is still starting up. The plugin will retry automatically.",
  立即重试: "Retry now",
  为当前选中的论文新建一个独立对话:
    "Create a separate chat for the selected paper",
  新建一个未绑定论文的对话: "Create a chat not linked to a paper",
  "当前对话正在回复，结束后才能关闭":
    "This chat can be closed after the current response finishes",
  关闭并删除当前对话: "Close and delete this chat",
  "复用本地 ChatGPT 登录": "Use local ChatGPT sign-in",
  删除此模型: "Delete this model",
  "添加一个新模型 ID": "Add another model ID",
  "OpenAI 常用": "Common OpenAI models",
  填入全部: "Add all",
  "填入 Codex 常用的 OpenAI 模型列表":
    "Add the OpenAI models commonly used by Codex",
  保存预设: "Save preset",
  当前配置没有未保存改动: "No unsaved changes in this configuration",
  没有未保存修改: "No unsaved changes",
  "正在测试连接；通过后会自动保存...":
    "Testing the connection; changes will be saved automatically if it succeeds…",
  删除当前: "Delete current",
  取消待办: "Cancel pending task",
  "把还没轮到的任务标为已取消，不影响当前正在回答的那一条":
    "Cancel tasks that have not started without affecting the current response",
  没有正在排队等待执行的任务: "No tasks are waiting in the queue",
  "全部已读且没有回答中/排队中任务时才可清空":
    "The queue can be cleared only when all results are read and no task is responding or queued",
  "直接清空队列记录，不删除聊天内容":
    "Clear queue records without deleting chat content",
  "已完成 / 查看": "Complete / View",
  提问: "Ask",
  选中文字提问: "Ask about selected text",
  "输入笔记...": "Write a note…",
  标题: "Title",
  作者: "Authors",
  年份: "Year",
  "期刊/会议": "Journal / conference",
  无PDF: "No PDF",
  "未选择 Zotero 条目": "No Zotero item selected",
  "无法找到 AI 侧栏": "Could not find the AI sidebar",
  "请先配置并选择一个 OpenAI 或本地 ChatGPT 模型":
    "Configure and select an OpenAI or local ChatGPT model first",
  "请先填写 API Key 和 Model ID": "Enter an API key and model ID first",
  "API Key 为空": "API key is empty",
  "Model 为空": "Model is empty",
  "先添加一个模型预设。": "Add a model preset first.",
  "全文重点支持 OpenAI 和本地 ChatGPT（Codex）":
    "Highlight key passages supports OpenAI and local ChatGPT (Codex)",
  批量: "Batch",
  全文翻译: "Translate full text",
  重新全文翻译: "Translate full text again",
  批量全文翻译: "Translate full text in batch",
  批量重新全文翻译: "Translate full text again in batch",
  "批量写注释需要先开启 YOLO 模式":
    "Enable YOLO mode before writing annotations in batch",
  "准备读取 PDF 全文…": "Preparing to read the full PDF…",
  重新: "Again",
  "正在准备系统提示和可用 Zotero 工具":
    "Preparing the system prompt and available Zotero tools",
  连接超时或已取消: "Connection timed out or was canceled",
  "Zotero 重启时被中断": "Interrupted when Zotero restarted",
  "已取消本次回答。": "This response was canceled.",
  "写入当前条目的 Zotero 子笔记":
    "Add to a Zotero child note for the current item",
  "用 Better Notes 写入当前条目的子笔记":
    "Add to a child note for the current item with Better Notes",
  "在当前 Zotero 窗口打开当前条目的子笔记":
    "Open a child note for the current item in this Zotero window",
  拖动左侧橙色分隔线可调整笔记栏宽度:
    "Drag the orange divider on the left to resize the notes panel",
  "请拖动笔记栏左侧橙色分隔线调整宽度，避免拖出 Zotero PDF 信息栏":
    "Resize the notes panel with its orange left divider; do not drag it outside the Zotero PDF pane",
  "手动触发 Zotero 官方笔记编辑器保存": "Save now in Zotero's note editor",
  已写入: "Added",
  "已写入 BN": "Added with Better Notes",
  "已写入 Zotero（条目 ID 暂未回填）":
    "Added to Zotero (item ID is not available yet)",
  已新建笔记: "Note created",
  "高亮+评论": "Highlight + comment",
  新增文字: "Add Text",
  "高亮+评论保存失败": "Could not save highlight + comment",
  新增文字保存失败: "Could not save Add Text",
  "请先在 PDF 中选中需要注释的句子":
    "Select the sentence to annotate in the PDF first",
  "请先在 Reader 中打开此 PDF": "Open this PDF in the Reader first",
  "选区缺少有效的 PDF 坐标信息，请重新选取一段文字后再试。":
    "The selection has no valid PDF coordinates. Select the text again and retry.",
  "原 PDF 附件已被删除或移走，无法定位选区。":
    "The original PDF attachment was deleted or moved, so the selection cannot be located.",
  "联网工具目前仅对 OpenAI Responses 兼容配置生效":
    "Online tools currently work only with OpenAI Responses-compatible configurations",
  "联网已开启：Cached；点击可关闭":
    "Online is on: Cached. Click to turn it off.",
  "联网已开启：Live；点击可关闭": "Online is on: Live. Click to turn it off.",
  "联网已关闭；点击可开启": "Online is off. Click to turn it on.",
  "点击开启；模式在设置中修改": "Click to enable; change the mode in Settings",
  "已开启；模式在设置中修改": "Enabled; change the mode in Settings",
  "调试复制：包含工具上下文、PDF 片段和思考过程；关闭后只复制论文介绍和对话":
    "Debug copy includes tool context, PDF passages, and reasoning. Turn it off to copy only the paper overview and chat.",
  "纯净复制：只复制论文介绍和对话；开启后包含工具上下文、PDF 片段和思考过程":
    "Clean copy includes only the paper overview and chat. Turn on debug copy to include tool context, PDF passages, and reasoning.",
  "复制当前对话为 Markdown（含工具上下文和 PDF 片段）":
    "Copy this chat as Markdown, including tool context and PDF passages",
  "复制当前对话为 Markdown（只含论文介绍和对话）":
    "Copy this chat as Markdown with only the paper overview and chat",
  "进度正在更新；可见思考取决于当前模型/API 是否返回 reasoning summary":
    "Progress is updating. Visible reasoning depends on whether the model/API returns a reasoning summary.",
  "Default：需要审批的本地工具会被拦截":
    "Default: local tools that require approval will be blocked",
  "YOLO：本地工具无需审批直接执行": "YOLO: run local tools without approval",
  "当前 PDF 选区自动检索原文位置，并附带命中位置附近上下文":
    "Locate the current PDF selection and include nearby context",
  "用户当前选中了 PDF 文本，并已自动附带命中位置附近上下文":
    "The user selected PDF text; nearby source context is included automatically",
  "用户当前选中了 PDF 文本，直接作为显式上下文发送":
    "The user selected PDF text; send it directly as explicit context",
  "仅保存在本机，不参与 WebDAV 云同步":
    "Stored only on this device; not synced through WebDAV",
  "↔ 拖左侧边缘": "↔ Drag the left edge",
  "保存当前修改 (Ctrl+S)": "Save changes (Ctrl+S)",
  自定义提示词按钮: "Custom prompt button",
  "高亮文本 / Highlight Text": "Highlight Text",
  "新增文字 / Add Text": "Add Text",
  "T 工具": "Add Text tool",
  "Zotero Reader 的「高亮文本 / Highlight Text」并附上评论":
    "Zotero Reader's Highlight Text annotation with a comment",
  "该模型不在本地 ChatGPT 可用模型列表中，请重新检测登录。":
    "This model is not available through the local ChatGPT account. Detect the sign-in again.",
  "模型 ID 仍可手动编辑；保存时会自动测试连接并探测是否需要发送 Max tokens。":
    "You can edit model IDs manually. Saving tests the connection and detects whether Max tokens should be sent.",
  "已就绪。这个对话未绑定论文；选中论文后点输入框上方的 + 可为该论文新建对话。":
    "Ready. This chat is not linked to a paper. Select a paper and use the + above the composer to create a paper chat.",
  "已就绪。这个对话已绑定到当前论文，可以直接询问 Zotero 条目或 PDF 内容。":
    "Ready. This chat is linked to the current paper; ask about the Zotero item or PDF directly.",
  "（空译文）": "(Empty translation)",
  "（服务不支持 Max tokens，已保存为不发送）":
    "(The service does not support Max tokens; saved without sending it)",
  "已取消全文翻译。": "Full-text translation canceled.",
  "未读取到可翻译的 PDF 全文。":
    "No translatable full text could be read from the PDF.",
  "已跳过前面已翻译缓存段落，继续翻译未完成部分。":
    "Skipped previously cached paragraphs and continued with untranslated paragraphs.",
  "本篇所有段落都已有翻译缓存；可用「点译」点击 PDF 段落查看。":
    "All paragraphs are already cached. Use Click to translate to view a paragraph in the PDF.",
  "原文：": "Source: ",
  "已跳过本段，继续翻译后续段落。":
    "Skipped this paragraph and continued with the remaining paragraphs.",
  任务队列: "Task queue",
  全部已读: "Mark all as read",
  清空队列: "Clear queue",
  取消: "Cancel",
  关闭任务队列窗口: "Close task queue",
  暂无任务结果: "No task results",
  查看任务队列和未读回答: "View task queue and unread responses",
  思考过程: "Reasoning",
  思考与上下文: "Reasoning and context",
  复制: "Copy",
  重试: "Retry",
  删除: "Delete",
  发送: "Send",
  停止: "Stop",
  联网: "Online",
  "＋ 联网": "+ Online",
  "🌐 联网": "🌐 Online",
  选择图片: "Attach image",
  移除截图: "Remove image",
  "系统截图后可直接 Ctrl+V 粘贴；也可以点击选择图片文件":
    "Paste a system screenshot with Ctrl+V, or click to choose an image file.",
  "选择屏幕/窗口截图；如果系统不支持，请用系统截图后 Ctrl+V 粘贴":
    "Capture a screen or window. If unavailable, take a system screenshot and paste it with Ctrl+V.",
  "请拖拽框选要截图的区域…": "Drag to select the area to capture…",
  "当前环境不能直接截图；请用系统截图复制后 Ctrl+V 粘贴":
    "Direct capture is unavailable here. Take a system screenshot, copy it, and paste with Ctrl+V.",
  "隐藏 AI 对话列": "Hide AI chat column",
  "显示/隐藏 AI 对话": "Show/hide AI chat",
  "打开/隐藏 AI 对话": "Show/hide AI chat",
  "打开 AI 对话": "Show AI chat",
  "隐藏 AI 对话": "Hide AI chat",
  隐藏: "Hide",
  没有打开的对话: "No chat is open",
  "选择已有对话，或新建一个对话后再输入。":
    "Select an existing chat, or create a new one before typing.",
  打开设置: "Open settings",
  未配置模型: "No model configured",
  "问点什么... (Enter 发送，Shift+Enter 换行)":
    "Ask anything… (Enter to send, Shift+Enter for a new line)",
  "问点什么... (Ctrl+Enter 发送)": "Ask anything… (Ctrl+Enter to send)",
  "↑ 排队": "↑ Queue",
  加入队列: "Add to queue",
  "加入队列：当前回复结束后按顺序执行":
    "Add to queue; it will run after the current response finishes.",
  "AI 回答中…当前回复结束后将按顺序执行队列里的消息":
    "The AI is responding… Queued messages will run in order when it finishes.",
  "AI 回答中…等待结束后再发送（设置可开启发送中排队）":
    "The AI is responding… Wait until it finishes, or enable message queueing in Settings.",
  "思考中…": "Reasoning…",
  正在生成回答: "Generating response",
  正在开始回答: "Starting response",
  正在流式输出正文: "Streaming response text",
  正在整理上下文: "Preparing context",
  等待模型响应: "Waiting for the model",
  模型仍在思考: "The model is still reasoning",
  模型正在思考: "The model is reasoning",
  正在使用工具: "Using a tool",
  准备发送给模型: "Preparing model request",
  正在初始化本轮回复: "Initializing this response",
  "请求已发送，等待首个流式事件":
    "Request sent; waiting for the first streamed event",
  "正在调用 Zotero 工具": "Calling a Zotero tool",
  正在使用联网工具: "Using an online tool",
  "等待 Zotero 工具返回": "Waiting for the Zotero tool",
  取消排队: "Cancel queued task",
  回答中: "Responding",
  排队中: "Queued",
  未读: "Unread",
  已读: "Read",
  已取消: "Canceled",
  失败: "Failed",
  "已收到思考过程，正在输出正文":
    "Reasoning received; generating the final response",
  打开笔记: "Open note",
  清空并保存当前条目的聊天记录: "Clear and save this item's chat history",
  写入笔记: "Add to note",
  导入笔记: "Add to note",
  保存: "Save",
  关闭: "Close",
  自动保存: "Autosave",
  "Zotero 自动保存": "Zotero autosave",
  未保存: "Unsaved",
  "保存中...": "Saving…",
  "保存中…": "Saving…",
  已保存: "Saved",
  保存失败: "Save failed",
  "打开中...": "Opening…",
  已打开: "Opened",
  已新建并打开: "Created and opened",
  打开失败: "Could not open",
  "写入中...": "Adding…",
  写入失败: "Could not add",
  建议注释: "Suggested annotation",
  "💾 高亮+评论": "💾 Highlight + comment",
  "🅣 新增文字": "🅣 Add Text",
  "保存时使用该 PDF 注释颜色": "Use this PDF annotation color when saving",
  "✓ 已保存": "✓ Saved",
  "↻ 重试新增文字": "↻ Retry Add Text",
  "↻ 重试高亮+评论": "↻ Retry highlight + comment",
  全文译: "Translate all",
  重译: "Translate again",
  点译: "Click to translate",
  译: "Translate",
  "译✓": "Translate ✓",
  "逐篇读取当前选中的论文全文，并按段落批量翻译到聊天区":
    "Read each selected paper in full and translate it paragraph by paragraph in the chat.",
  "一键读取当前 PDF 全文，并按段落翻译到聊天区":
    "Read the current PDF in full and translate it paragraph by paragraph in the chat.",
  "先清除当前选中论文的段落翻译缓存，再逐篇重新全文翻译":
    "Clear cached paragraph translations for the selected papers, then translate each paper again.",
  "先清除当前论文的段落翻译缓存，再重新全文翻译":
    "Clear cached paragraph translations for the current paper, then translate it again.",
  "一键全文逐段翻译，翻译参数在插件设置中配置":
    "Translate the full text paragraph by paragraph. Configure translation options in the plugin settings.",
  "开启后点击 PDF 段落显示译文，不写入注释":
    "When enabled, click a PDF paragraph to display its translation without creating an annotation.",
  "清除当前论文段落翻译缓存后重新全文翻译，翻译参数在插件设置中配置":
    "Clear cached paragraph translations for the current paper and translate the full text again. Configure translation options in the plugin settings.",
  "EN → 简体中文": "English → Simplified Chinese",
  "● 翻译中…": "● Translating…",
  "● 等待中…": "● Waiting…",
  "● 已完成": "● Complete",
  "● 翻译失败": "● Translation failed",
  "正在翻译…": "Translating…",
  "本地缓存未命中，正在翻译…": "Not found in the local cache; translating…",
  "请先在设置中配置一个 GPT (openai) API。":
    "Configure a GPT (OpenAI) API in Settings first.",
  "请先为 GPT (openai) 配置选择模型。":
    "Select a model for the GPT (OpenAI) account first.",
  "模型没有返回译文。": "The model returned no translation.",
  "● 完成后可保存": "● Save when complete",
  "保存注释失败：未找到当前 PDF 附件。":
    "Could not save the annotation because the current PDF attachment was not found.",
  "● 保存中…": "● Saving…",
  "● 已保存": "● Saved",
  上下文段落: "Surrounding paragraphs",
  当前页上下文: "Current-page context",
  "模型返回了英文改写而不是中文翻译，本次结果已丢弃且不会写入缓存。请点重试，或换一个翻译模型。":
    "The model rewrote the English instead of translating it into Chinese. The result was discarded and was not cached. Retry or choose another translation model.",
  "保存为 Zotero 注释": "Save as a Zotero annotation",
  "重新翻译（忽略缓存并覆盖旧结果）":
    "Translate again (ignore the cache and replace the previous result)",
  上一段: "Previous paragraph",
  下一段: "Next paragraph",
  "关闭 (Esc)": "Close (Esc)",
  自定义提示: "Custom prompt",
  提示词: "Prompt",
  "按钮名称（可空）": "Button label (optional)",
  "PDF 快捷键": "PDF shortcut",
  留空则只作为快捷键: "Leave blank to use only as a shortcut",
  "例如：t": "For example: T",
  "保存提示词/按钮": "Save prompt/button",
  普通选区提问后生成建议注释:
    "Generate a suggested annotation after questions about a selection",
  "默认开启：选中文本后在对话框手动提问，AI 回完会附带「建议注释」卡片，下方可一键保存为「💾 高亮+评论」或「🅣 新增文字」(T 工具)。解释选区按钮始终会生成建议注释。开启时会参考 PDF 注释颜色预设推荐颜色。":
    "Enabled by default. After you select text and ask a question, the AI adds a Suggested annotation card that you can save as “💾 Highlight + comment” or “🅣 Add Text.” Explain selection always generates a suggestion. When enabled, color recommendations use your PDF annotation color presets.",
  "还没有模型配置。点击 + OpenAI 或 + Anthropic 新增。":
    "No model accounts yet. Click + OpenAI or + Anthropic to add one.",
  "本地 ChatGPT（Codex）": "Local ChatGPT (Codex)",
  "OpenAI 兼容": "OpenAI-compatible",
  名称: "Name",
  "复用本机 Codex 登录，无需 API Key":
    "Uses the local Codex sign-in; no API key required",
  "由本机 Codex 管理": "Managed by local Codex",
  "自定义模型 ID": "Custom model ID",
  "输入自定义模型 ID": "Enter a custom model ID",
  "+ 添加": "+ Add",
  "OpenAI 预设模型": "Suggested OpenAI models",
  自定义模型: "Custom model",
  切换当前预设的模型: "Switch the active model for this account",
  低: "Low",
  中: "Medium",
  高: "High",
  极高: "Extra high",
  "Low - 快速，较少推理": "Low — faster, less reasoning",
  "Medium - 默认平衡": "Medium — balanced (default)",
  "High - 更强推理": "High — stronger reasoning",
  "Extra high - 最强推理": "Extra high — strongest reasoning",
  "Concise - 简短显示思考摘要": "Concise — brief reasoning summary",
  "Detailed - 更详细的思考摘要": "Detailed — more detailed reasoning summary",
  "Auto - 由模型决定": "Auto — decided by the model",
  "None - 不显示思考": "None — hide reasoning",
  "Always - 请求审批": "Always — request approval",
  "Never - 不需要审批": "Never — no approval required",
  "默认 Base URL": "Default Base URL",
  未填写模型: "No model entered",
  配置文件: "Configuration file",
  "JSON 配置文件": "JSON configuration file",
  "联网/MCP": "Online access / MCP",
  账号: "Account",
  启用: "Enabled",
  显示: "Show",
  文本: "Text",
  无: "None",
  "未找到本机 Codex。请安装 ChatGPT/Codex 桌面应用或 Codex CLI，并先通过 ChatGPT 账号登录。":
    "Could not find Codex on this computer. Install the ChatGPT/Codex desktop app or Codex CLI, then sign in with your ChatGPT account.",
  "未检测到本地 ChatGPT 登录。请在终端运行 codex login，完成登录后重新检测。":
    "No local ChatGPT sign-in was detected. Run codex login in a terminal, complete sign-in, and detect it again.",
  "本地 Codex 连接已关闭，请检查登录状态后重试。":
    "The local Codex connection closed. Check your sign-in and try again.",
  "Codex 响应超过大小限制。": "The Codex response exceeded the size limit.",
  "本地 ChatGPT 请求超时，请重试。":
    "The local ChatGPT request timed out. Try again.",
  "本地 ChatGPT 请求失败，请检查登录状态或额度。":
    "The local ChatGPT request failed. Check your sign-in and usage limits.",
  "本地 ChatGPT 请求未完成。": "The local ChatGPT request did not complete.",
  "本地 ChatGPT 未返回文本，请重试。":
    "Local ChatGPT returned no text. Try again.",
  "已连接本地 ChatGPT（Codex）": "Connected to local ChatGPT (Codex)",
  "已达到 Zotero 工具调用上限，请继续对话后重试。":
    "The Zotero tool-call limit was reached. Continue the chat and try again.",
  请求已取消: "Request canceled",
  "从云端下载会按时间戳合并对话历史，并直接覆盖本地账号、显示、提示词、联网/MCP 和翻译配置。继续？":
    "Downloading from the cloud merges chat history by timestamp and replaces local account, display, prompt, online/MCP, and translation settings. Continue?",
  当前窗口不支持文件选择器: "This window does not support the file picker",
  导出失败: "Export failed",
  导入失败: "Import failed",
  配置文件不是文本内容: "The configuration file is not text",
  "配置 JSON 解析失败，请检查是否完整复制。":
    "Could not parse the configuration JSON. Check that it was copied in full.",
  "配置 JSON 顶层必须是对象。":
    "The top level of the configuration JSON must be an object.",
  "配置里的 presets 必须是数组。":
    "presets in the configuration must be an array.",
  "配置里的 uiSettings 必须是对象。":
    "uiSettings in the configuration must be an object.",
  "配置里的 quickPrompts 必须是对象。":
    "quickPrompts in the configuration must be an object.",
  "配置里的 toolSettings 必须是对象。":
    "toolSettings in the configuration must be an object.",
  "配置里的 translateSettings 必须是对象。":
    "translateSettings in the configuration must be an object.",
  "没有找到可导入的配置段：presets / uiSettings / quickPrompts / toolSettings / translateSettings。":
    "No importable configuration section was found: presets / uiSettings / quickPrompts / toolSettings / translateSettings.",
  "配置 JSON 已复制。内容可能包含 API Key。":
    "Configuration JSON copied. It may contain API keys.",
  "已加载联网/MCP配置。": "Online/MCP configuration loaded.",
  "复用本机 Codex 的 ChatGPT 登录，使用 Codex 额度。支持文献问答、翻译和图片输入；本地模式支持 Zotero 文献读取和注释工具，写入需要开启 YOLO。登录失效时请运行 codex login 后重新检测。":
    "Uses the local Codex ChatGPT sign-in and Codex allowance. Supports paper Q&A, translation, and image input. Local mode can read Zotero papers and use annotation tools; writing requires YOLO mode. If sign-in expires, run codex login and detect it again.",
};

const ORIGINAL_TEXT = new WeakMap<Text, string>();
const ORIGINAL_ATTRS = new WeakMap<Element, Map<string, string>>();
const OBSERVED_ROOTS = new Set<HTMLElement>();
const OBSERVERS = new WeakMap<HTMLElement, MutationObserver>();
const ATTRIBUTES = ["title", "tooltiptext", "placeholder", "aria-label"];
const USER_CONTENT_SELECTOR = [
  ".bubble-body",
  ".bubble-thinking-body",
  ".bubble-role",
  ".annotation-suggestion-body",
  ".message-image",
  ".zai-zotero-note-editor",
  "note-editor",
  "textarea",
  "pre",
  "code",
].join(",");

function isUserContent(node: Node): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !!element?.closest(USER_CONTENT_SELECTOR);
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function preserveSpace(source: string, translated: string): string {
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

function dynamicEnglish(value: string): string | null {
  const rules: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^批量译\((\d+)\)$/, (n) => `Translate all (${n})`],
    [/^重译\((\d+)\)$/, (n) => `Translate again (${n})`],
    [/^(\d+)px 默认$/, (size) => `${size}px default`],
    [/^论文 (\d+)$/, (number) => `Paper ${number}`],
    [/^读取全文：(.+)$/, (title) => `Reading full text: ${title}`],
    [
      /^翻译 (\d+)\/(\d+) · (\d+)\/(\d+)$/,
      (paper, papers, paragraph, paragraphs) =>
        `Translating ${paper}/${papers} · ${paragraph}/${paragraphs}`,
    ],
    [/^第 (\d+) 段$/, (number) => `Paragraph ${number}`],
    [
      /^共 (\d+) 段，开始翻译。$/,
      (count) => `Starting translation of ${count} paragraph(s).`,
    ],
    [
      /^已清除本篇 (\d+) 条段落翻译缓存，将重新翻译。$/,
      (count) =>
        `Cleared ${count} cached paragraph translation(s); translating again.`,
    ],
    [
      /^本篇有 (\d+) 段模型没有返回中文译文，已跳过并继续处理。$/,
      (count) =>
        `The model did not return a Chinese translation for ${count} paragraph(s); they were skipped.`,
    ],
    [/^快捷键 ([A-Z0-9])$/, (key) => `Shortcut ${key}`],
    [/^目标笔记 #(\d+)$/, (id) => `Target note #${id}`],
    [/^当前模型：(.+)$/, (model) => `Current model: ${model}`],
    [/^推理等级：(.+)$/, (level) => `Reasoning level: ${level}`],
    [/^基于：「(.+)」$/, (text) => `Based on: “${text}”`],
    [/^AI 总结 (.+)$/, (date) => `AI summary ${date}`],
    [/^Zotero 笔记 #(\d+)$/, (id) => `Zotero note #${id}`],
    [
      /^已带入 PDF 选区 (\d+) 字$/,
      (n) => `Included PDF selection: ${n} characters`,
    ],
    [
      /^(\d+) 未读 \/ (\d+) 总计$/,
      (unread, total) => `${unread} unread / ${total} total`,
    ],
    [/^加入\/移除 (.+)$/, (id) => `Add/remove ${id}`],
    [
      /^「新增文字」默认字号已保存为 (\d+)。$/,
      (size) => `Default Add Text font size saved as ${size}.`,
    ],
    [
      /^已识别 ChatGPT 登录(?:（(.+)）)?，检测到 (\d+) 个模型。点击保存账号配置生效。$/,
      (plan, count) =>
        `ChatGPT sign-in detected${plan ? ` (${plan})` : ""}, with ${count} available models. Click Save account settings to apply.`,
    ],
    [
      /^正在测试 (\d+) 个新增\/变更配置；通过后保存\.\.\.$/,
      (count) =>
        `Testing ${count} new or changed account(s); they will be saved after passing…`,
    ],
    [/^连接成功：(.+)$/, (detail) => `Connected: ${detail}`],
    [/^连接完成：(.+)$/, (detail) => `Connection completed: ${detail}`],
    [/^连接失败：(.+)$/, (detail) => `Connection failed: ${detail}`],
    [/^导出失败[：:]\s*(.+)$/, (detail) => `Export failed: ${detail}`],
    [/^导入失败[：:]\s*(.+)$/, (detail) => `Import failed: ${detail}`],
    [/^配置备份已保存：(.+)$/, (path) => `Configuration backup saved: ${path}`],
    [
      /^上次上传：(.+)$/,
      (value) => `Last upload: ${value === "未上传" ? "never" : value}`,
    ],
    [
      /^上次下载：(.+)$/,
      (value) => `Last download: ${value === "未下载" ? "never" : value}`,
    ],
    [/^翻译失败：(.+)$/, (detail) => `Translation failed: ${detail}`],
    [
      /^保存注释失败：(.+)$/,
      (detail) => `Could not save annotation: ${detail}`,
    ],
    [/^● 已完成 · 全文缓存$/, () => "● Complete · full-text cache"],
    [/^● 已完成 · 本地缓存$/, () => "● Complete · local cache"],
    [
      /^(.+) 下一段 · (.+) 上一段$/,
      (next, previous) => `${next} next · ${previous} previous`,
    ],
    [
      /^自定义提示词按钮；PDF 中按 (.+) 触发$/,
      (key) => `Custom prompt button; press ${key} in the PDF Reader`,
    ],
    [/^当前自定义按钮：(.+)$/, (labels) => `Current custom buttons: ${labels}`],
    [
      /^读取 Zotero 标注 (\d+) 条$/,
      (count) => `Read ${count} Zotero annotation(s)`,
    ],
    [
      /^检索 PDF: (.+)，返回 (\d+) 段$/,
      (query, count) =>
        `Searched PDF for “${query}”; returned ${count} passage(s)`,
    ],
    [
      /^读取 PDF 范围 (\d+)-(\d+)$/,
      (start, end) => `Read PDF range ${start}–${end}`,
    ],
    [/^调用 Zotero 工具: (.+)$/, (tool) => `Calling Zotero tool: ${tool}`],
    [
      /^本地 Codex 请求超时：(.+)$/,
      (method) => `Local Codex request timed out: ${method}`,
    ],
    [
      /^思考与上下文 · (.+)$/,
      (summary) => `Reasoning and context · ${uiText(summary, "en-US")}`,
    ],
    [
      /^已随本轮发送 PDF 选区 (\d+) 字(?:；自动附带附近上下文 (\d+) 字)?(?:；另保留最近上下文 (\d+) 条 \/ (\d+) 字)?$/,
      (selected, nearby, retained, retainedChars) =>
        [
          `Sent PDF selection: ${selected} characters`,
          nearby ? `nearby context: ${nearby} characters` : "",
          retained
            ? `retained recent context: ${retained} item(s) / ${retainedChars} characters`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
    ],
    [
      /^已随本轮发送 Zotero 标注 (\d+) 条$/,
      (count) => `Sent ${count} Zotero annotation(s)`,
    ],
    [
      /^模型复用历史上下文 (\d+) 段 \/ (\d+) 字$/,
      (count, chars) =>
        `Model reused ${count} historical context passage(s) / ${chars} characters`,
    ],
    [
      /^模型请求 PDF 字符范围 (\d+) 段 \/ (\d+) 字$/,
      (count, chars) =>
        `Model requested ${count} PDF range(s) / ${chars} characters`,
    ],
    [
      /^(本地兜底选择|模型选择) PDF 片段 (\d+)(?:\/(\d+))? 段 \/ (\d+) 字$/,
      (source, selected, candidates, chars) =>
        `${source === "模型选择" ? "Model-selected" : "Locally selected fallback"} PDF passages: ${selected}${candidates ? `/${candidates}` : ""} / ${chars} characters`,
    ],
    [
      /^模型查看 PDF 候选 (\d+) 段，最终未发送片段$/,
      (count) =>
        `Model inspected ${count} candidate PDF passage(s); none were sent`,
    ],
    [
      /^模型请求 Reader PDF 文本 (.+)$/,
      (detail) =>
        `Model requested Reader PDF text: ${detail.replaceAll("字", " characters").replaceAll("（已截断）", " (truncated)")}`,
    ],
    [
      /^模型请求远程 arXiv 论文文本 (.+)$/,
      (detail) =>
        `Model requested remote arXiv paper text: ${detail.replaceAll("字", " characters").replaceAll("（已截断）", " (truncated)")}`,
    ],
    [
      /^已随本轮发送 PDF 全文 (.+)$/,
      (detail) =>
        `Sent full PDF text: ${detail.replaceAll("字", " characters").replaceAll("（已截断）", " (truncated)")}`,
    ],
    [
      /^模型调用 Zotero 工具 (\d+) 次 \/ 完成 (\d+) \/ 错误 (\d+)$/,
      (total, completed, errors) =>
        `Model called Zotero tools ${total} time(s) / ${completed} completed / ${errors} failed`,
    ],
    [
      /^本轮未请求新论文正文；保留最近上下文 (\d+) 段 \/ (\d+) 字$/,
      (count, chars) =>
        `No new paper text requested; retained ${count} recent context passage(s) / ${chars} characters`,
    ],
  ];
  for (const [pattern, render] of rules) {
    const match = value.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return null;
}

export function uiText(
  source: string,
  language: UiLanguage = currentUiLanguage(),
): string {
  if (language !== "en-US" || !source) return source;
  const key = normalized(source);
  const translated = EN[key] ?? dynamicEnglish(key);
  return translated ? preserveSpace(source, translated) : source;
}

function localizeTextNode(node: Text, language: UiLanguage): void {
  if (isUserContent(node)) return;
  if (!ORIGINAL_TEXT.has(node)) ORIGINAL_TEXT.set(node, node.data);
  const source = ORIGINAL_TEXT.get(node) ?? node.data;
  const next = uiText(source, language);
  if (node.data !== next) node.data = next;
}

function localizeElementAttributes(
  element: Element,
  language: UiLanguage,
): void {
  let originals = ORIGINAL_ATTRS.get(element);
  if (!originals) {
    originals = new Map();
    ORIGINAL_ATTRS.set(element, originals);
  }
  for (const name of ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    if (!originals.has(name))
      originals.set(name, element.getAttribute(name) ?? "");
    const source = originals.get(name) ?? "";
    const next = uiText(source, language);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }
}

export function localizeUiTree(
  root: HTMLElement,
  language: UiLanguage = currentUiLanguage(),
): void {
  localizeElementAttributes(root, language);
  const doc = root.ownerDocument;
  if (!doc) return;
  const view = doc.defaultView;
  if (!view) return;
  const walker = doc.createTreeWalker(
    root,
    view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT,
  );
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node.nodeType === view.Node.TEXT_NODE)
      localizeTextNode(node as Text, language);
    else localizeElementAttributes(node as Element, language);
    node = walker.nextNode();
  }
  root.setAttribute("lang", language);
}

export function observeLocalizedUi(root: HTMLElement): () => void {
  const prior = OBSERVERS.get(root);
  if (prior) return () => undefined;
  OBSERVED_ROOTS.add(root);
  localizeUiTree(root);
  const doc = root.ownerDocument;
  if (!doc) return () => undefined;
  const MutationObserverCtor = doc.defaultView?.MutationObserver;
  if (!MutationObserverCtor) return () => undefined;
  const observer = new MutationObserverCtor((records: MutationRecord[]) => {
    const language = currentUiLanguage();
    for (const record of records) {
      if (record.type === "characterData") {
        const text = record.target as Text;
        const priorSource = ORIGINAL_TEXT.get(text);
        if (
          priorSource != null &&
          text.data !== uiText(priorSource, language)
        ) {
          ORIGINAL_TEXT.set(text, text.data);
        }
        localizeTextNode(text, language);
      } else if (record.type === "attributes" && record.attributeName) {
        const element = record.target as Element;
        const originals = ORIGINAL_ATTRS.get(element);
        const priorSource = originals?.get(record.attributeName);
        const current = element.getAttribute(record.attributeName) ?? "";
        if (
          originals &&
          priorSource != null &&
          current !== uiText(priorSource, language)
        ) {
          originals.set(record.attributeName, current);
        }
        localizeElementAttributes(element, language);
      } else if (record.type === "childList") {
        for (const added of record.addedNodes) {
          if (!added) continue;
          if (added.nodeType === 1) {
            localizeUiTree(added as HTMLElement, language);
          } else if (added.nodeType === 3) {
            localizeTextNode(added as Text, language);
          }
        }
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
  OBSERVERS.set(root, observer);
  return () => {
    observer.disconnect();
    OBSERVERS.delete(root);
    OBSERVED_ROOTS.delete(root);
  };
}

export function refreshLocalizedUi(): void {
  const language = currentUiLanguage();
  for (const root of OBSERVED_ROOTS) {
    if (root.isConnected) localizeUiTree(root, language);
    else OBSERVED_ROOTS.delete(root);
  }
}
