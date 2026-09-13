# Zotero AI Sidebar

[中文](README.md) · [Download](https://github.com/huangkiki/zotero-ai-sidebar/releases/latest) · [Report an issue](https://github.com/huangkiki/zotero-ai-sidebar/issues)

Ask questions, translate passages, explain selected text, and organize notes beside Zotero's PDF reader. Conversations are saved per paper, with multiple conversations supported for each paper.

Connect through **local Codex sign-in with ChatGPT**, the **OpenAI Responses API or a compatible service**, or the **Anthropic API**. Available features differ by connection method.

![Zotero PDF reader and AI sidebar](docs/assets/zotero-real-overview.png)

> Local ChatGPT integration is still being validated. Users have reported that the model sees only item metadata and does not call PDF retrieval tools. Not all workflows have passed validation inside Zotero. Successful account detection or chat does not establish that PDF retrieval and annotations work. See [Troubleshooting](#troubleshooting).

## Install and update

1. Open [Releases](https://github.com/huangkiki/zotero-ai-sidebar/releases/latest) and download `zotero-ai-sidebar.xpi` under **Assets**.
2. In Zotero, open **Tools → Plugins**, click the gear icon, then choose **Install Plugin From File…**.
3. Select the downloaded `.xpi` file and complete installation.
4. After updating an older version, fully quit and reopen Zotero. On macOS, use **⌘Q**.
5. Open **设置** (Settings) in the sidebar and configure a connection under **账号与模型** (Accounts and Models).

The manifest declares compatibility with **Zotero 7.0 through 10.0.2**. Recent adaptation targets Zotero 10.0.2 on macOS; this declaration does not mean every version and operating system has been tested.

Install the latest `.xpi` over the existing plugin to update. There is no need to uninstall first. `Source code (zip)` is for development and cannot be installed as a plugin. This repository's release workflow does not currently publish a usable automatic update manifest; use the installation packages on Releases.

## Choose a connection

| Connection                  | Setup                                              | Zotero retrieval / annotation tools                          | Limitations                                                                               |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Local ChatGPT (Codex)       | Sign in to Codex with ChatGPT; no API key required | Implemented; validation in Zotero is ongoing                 | Uses Codex models and usage limits; requires a local Codex App Server                     |
| OpenAI / compatible service | API key, optional Base URL, model ID               | Supported when the service supports Responses API tool calls | Services supporting only Chat Completions are insufficient                                |
| Anthropic                   | API key, optional Base URL, model ID               | Tool loop not implemented                                    | Supports chat and attached selections or images; cannot use tools to retrieve a whole PDF |

### Local ChatGPT through Codex

This option reuses **ChatGPT sign-in in Codex**. Being signed in to ChatGPT in a browser alone is not sufficient.

1. Install ChatGPT/Codex desktop or [Codex CLI](https://learn.chatgpt.com/docs/auth).
2. If needed, run `codex login` in a terminal and complete sign-in. Check the result with `codex login status`.
3. In the plugin's Accounts and Models settings, click **检测本地 ChatGPT 登录** (Detect local ChatGPT login).
4. Once models are found, click **保存账号配置** (Save account configuration).
5. Select **本地 ChatGPT（Codex）** and a discovered model in the sidebar.

On macOS, the plugin looks for Codex in the ChatGPT/Codex application bundles, Homebrew locations, and `PATH`. Codex manages the credentials. The plugin communicates with the official [Codex App Server](https://learn.chatgpt.com/docs/app-server) over local standard input/output; it does not read browser cookies or copy ChatGPT login tokens into Zotero preferences.

Local mode uses Codex's default reasoning settings and output length. The sidebar's web-search toggle currently applies only to OpenAI Responses connections.

### OpenAI / Anthropic API

Under Accounts and Models, click **+ OpenAI** or **+ Anthropic**, then enter:

- **API Key**: the key for your service.
- **Base URL**: leave blank for the official service, or enter your compatible service's API address.
- **Models**: model IDs offered by that service. You can save multiple models and switch between them.
- **Max tokens**: output length configuration. The OpenAI connection test checks whether the service accepts this parameter.

Click **保存账号配置** (Save account configuration). New or changed configurations are checked before saving. If the check fails, use the status message to review the address, model, key, and API compatibility. OpenAI-compatible services must support streaming Responses and function calling for the full workflow.

## Read a paper

Open a PDF, select an account and model, and enter a question such as:

```text
Read this paper and organize it by research question, method, experimental results,
and limitations. Cite supporting passages from the paper.
```

When needed, the model uses Zotero tools to retrieve PDF text. Tool activity appears in the conversation. A title or abstract is not the full paper; investigate retrieval if the model says the source text is missing.

### Sidebar actions

The labels below match the current interface.

| Button      | Purpose                                                                   | Requirements                                                                          |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 总结论文    | Send a summary prompt; the model retrieves source text as needed          | Select a model; automatic PDF retrieval requires tool support                         |
| 🔖 全文重点 | Identify key passages and write PDF highlights and comments through tools | OpenAI or local ChatGPT; the current paper's PDF must be open in Reader; YOLO enabled |
| 解释选区    | Explain selected text and optionally suggest an annotation                | Select text in the PDF first; check that the sidebar shows a selection indicator      |
| 全文译      | Translate the paper in segments and save results in its conversation      | Configure a translation account and model                                             |
| 点译        | Click PDF passages to see translations in the conversation                | Enable point translation and configure its account and model                          |
| 重译        | Run full-text translation again                                           | Sends new model requests                                                              |
| 截图 / 图片 | Attach a screenshot or image to a question                                | A model that supports image input                                                     |
| 打开笔记    | View and organize notes for the current paper                             | A conversation associated with a Zotero item                                          |

**YOLO controls model-initiated writes.** Normal mode blocks tools requiring approval. When YOLO is enabled, the model can write requested highlights, annotations, and notes without per-operation confirmation. Reading a paper and ordinary questions do not require YOLO.

### Translation and notes

Translation is designed for **English to Simplified Chinese**. Under **逐段翻译设置** (Paragraph Translation Settings), select an OpenAI or local ChatGPT account and model. This can differ from the model selected for chat.

![Paragraph translation example](docs/assets/zotero-real-translation.png)

Point translation tries to reuse the full-text translation cache. Missing or invalid cached results can trigger a new request. Answer actions also support copying Markdown, saving notes, and saving annotation suggestions back to the PDF.

## Troubleshooting

### Chat works, but the model reports no PDF text or Zotero tools

1. In **Tools → Plugins**, verify that the latest plugin is installed and enabled. Local ChatGPT gained Zotero tool integration in v0.3.3.
2. After updating, fully quit and restart Zotero. Open the PDF and check that the sidebar title matches the paper.
3. Test in a new conversation and look for PDF retrieval tool activity. Restarting is a diagnostic step, not a confirmed fix.
4. If the problem persists, open an [issue](https://github.com/huangkiki/zotero-ai-sidebar/issues) with the plugin version, Zotero version, operating system, connection method, and tool activity or error screenshots. The sidebar's **调试** (Debug) toggle can help with diagnosis.

Reports affecting local ChatGPT are still under investigation. Scanned PDFs or attachments without extractable text may also lack usable source text. The plugin does not provide built-in OCR. Retrieval has size and range limits; it does not guarantee complete extraction from every PDF.

### Full-text highlights are disabled

Select an OpenAI or local ChatGPT account, open the current paper's PDF in Reader, and enable YOLO. Hover over the disabled button to see the reason.

### Explain selection is disabled

Select text in the PDF first. Selecting an image or merely opening a PDF does not create a text selection. If no selection indicator appears in the sidebar, select the text again and check debug output. Explaining a selection does not itself require YOLO.

### Local ChatGPT login is not detected

Run `codex login status`. If signed out, run `codex login`; after signing in again, click the detection button in the plugin. If Codex is not found despite a desktop installation, report the operating system and installation method.

### Zotero reports an incompatible package

Make sure you selected the Release's `.xpi` and that your Zotero version falls within the declared range. Do not install the source ZIP or rename an unrelated plugin package.

## Data, backup, and sync

Conversations are stored locally per paper. The plugin supports multiple conversations, task queues, quick prompts, and JSON configuration backups. Optional WebDAV sync transfers plugin conversations, settings, prompts, and some annotation state; it does not replace Zotero's library and PDF file sync.

Model requests send relevant questions, selections, images, and retrieved paper content to the selected service. Local ChatGPT sign-in still requires online model requests; it is not offline inference.

API keys are stored in Zotero preferences. Configuration backups and WebDAV settings snapshots can contain keys; do not publish these files. Codex manages ChatGPT login tokens separately, outside the plugin's model presets.

## Development and releases

CI uses Node.js 22. After cloning:

```bash
npm ci
npm test
npm run build
```

The package is generated at `.scaffold/build/zotero-ai-sidebar.xpi`. Run `npm run lint:check` for formatting and static checks. The repository still has pre-existing formatting issues, so passing functional tests does not imply a passing lint check.

**Pushing code does not update a Release.** Update and commit the versions in `package.json` and `package-lock.json`, then run from a clean working tree:

```bash
npm run release:xpi
```

The script requires GitHub CLI `gh`. It tests, builds, pushes the version tag, and waits for the **Release XPI** GitHub Actions workflow to publish the package. You can also start that workflow manually in GitHub Actions. See the [release guide](docs/RELEASE.md).

## Project and license

This repository continues development from [xuhan-rgb/zotero-ai-sidebar](https://github.com/xuhan-rgb/zotero-ai-sidebar).

Licensed under [AGPL-3.0-or-later](LICENSE).
