# CLAUDE.md

## Project Overview

This project builds a Zotero sidebar AI agent: a separate AI chat column inside Zotero that can read the current item, PDF text, annotations, selected text, screenshots, and future Zotero write tools through a local harness.

## Common Commands

```bash
npm test
npm run build
cp .scaffold/build/zotero-ai-sidebar.xpi zotero-ai-sidebar.xpi
cp .scaffold/build/zotero-ai-sidebar.xpi /home/qwer/.zotero/zotero/24q8duho.default/extensions/zotero-ai-sidebar@local.xpi
```

After installing the XPI, restart Zotero:

```bash
cd ~/Downloads/Zotero_linux-x86_64
./zotero
```

## Modification Guidelines

### Codex-style Agent Direction

- Keep Zotero context access model-driven: the model decides whether it needs the current item, annotations, PDF search passages, exact PDF ranges, full PDF text, screenshots, or future write tools.
- Do not add local keyword, regex, or semantic intent routing for user requests such as summarizing, explaining, continuing, selecting chapters, or creating notes.
- The local harness should expose structured tools, validate arguments, execute Zotero operations, enforce budgets, and return structured tool outputs or errors.
- Treat `maxToolIterations` as a safety fuse for the tool loop, not as task-type routing logic.
- Keep context budgets and limits centralized in `src/context/policy.ts`; avoid scattered magic numbers.
- Preserve the context ledger design: old PDF/full-text context is recorded as history metadata, not blindly replayed every turn.

### Claudian-style Chat UI Direction

- Keep the chat output clean and readable, similar to Claudian: spacious message flow, clear assistant/user separation, and compact controls near the composer.
- Render assistant output as Markdown where practical: headings, lists, code blocks, blockquotes, links, inline code, and strong text.
- Show reasoning/thinking in a clear collapsible block instead of mixing it into the final answer.
- Show Zotero tool-call traces visibly in the conversation so users can understand what local context/tools were used.
- Keep screenshot/image attachments visible in the UI and ensure they are actually sent to multimodal providers, not just displayed locally.
- Avoid UI elements that cause the right sidebar to jump while the user scrolls or selects PDF text.

## Architecture Notes

- Native DOM sidebar code lives mainly in `src/modules/sidebar.ts`; avoid reintroducing React UI in the Zotero pane unless crash behavior has been revalidated.
- Provider adapters live in `src/providers/`; OpenAI uses the Responses API tool loop and Anthropic uses message streaming.
- Zotero local tools live in `src/context/agent-tools.ts` and should remain structured function-call tools.
- Prompt/context formatting lives in `src/context/message-format.ts`.
- Chat history persistence lives in `src/settings/chat-history.ts`; preserve messages, context traces, thinking summaries, and image metadata.
- Harness design notes live in `docs/HARNESS_ENGINEERING.md`; update that document when changing tool-loop or context semantics.

## Development Lessons

- Zotero versions share the same user profile unless launched with `./zotero -P`; installed XPIs live under `~/.zotero/zotero/<profile>/extensions/`, not inside the Zotero binary folder.
- One XPI should support Zotero 7/8/9 when APIs are compatible; keep compatibility in `addon/manifest.json` with `strict_min_version` and `strict_max_version`.
- Keep provider config local in Zotero prefs. API keys, model IDs, Base URLs, max tokens, reasoning settings, and YOLO mode must not be hardcoded in source.
- For OpenAI Responses with `store: false`, do not rely on persisted response item IDs. Replay only the current conversation inputs, function calls, and function-call outputs.
- Selected PDF text is explicit UI context, not semantic intent routing. It may be attached to the next user message, dismissed by the user, and shown in a stable composer chip rather than causing sidebar layout jumps.
- Streaming output should auto-scroll only when the user is already near the bottom. If the user manually scrolls up, preserve their scroll position while new chunks arrive.
- The chat draft must survive sidebar re-renders during streaming, tool calls, reader selection updates, and preset/config changes.
- Screenshot/image support is only complete when images are both displayed in the chat and converted into provider multimodal inputs.
- Zotero write tools, such as adding annotations, must be explicit tools with visible traces. Block them in default mode unless approval UI exists or YOLO mode is selected.
- Release artifacts are produced by GitHub Actions from tags. Do not commit XPI build artifacts; run `npm run release:xpi` after version bump and commit.

## Code Reference Map

Use these files as the first reference points before changing behavior:

- Addon entry and Zotero integration: `addon/manifest.json`, `addon/bootstrap.js`, `src/index.ts`, `src/hooks.ts`, `src/addon.ts`.
- Sidebar UI and behavior: `src/modules/sidebar.ts`, `addon/content/sidebar.css`, `addon/content/zoteroPane.css`, locale strings under `addon/locale/`.
- Preferences and model presets: `addon/prefs.js`, `addon/content/preferences.xhtml`, `src/settings/storage.ts`, `src/settings/types.ts`.
- Chat history persistence: `src/settings/chat-history.ts`; preserve per-item threads, context, thinking, tool traces, and images.
- Provider abstraction: `src/providers/types.ts`, `src/providers/factory.ts`.
- OpenAI tool loop and multimodal input: `src/providers/openai.ts`; tests in `tests/providers/openai.test.ts`.
- Anthropic streaming adapter: `src/providers/anthropic.ts`; tests in `tests/providers/anthropic.test.ts`.
- Zotero agent tools: `src/context/agent-tools.ts`; tests in `tests/context/agent-tools.test.ts`.
- Zotero data access: `src/context/zotero-source.ts`; this wraps item metadata, full-text cache, PDF attachments, and annotations.
- Context budgets and safety limits: `src/context/policy.ts`; add new limits here instead of scattering magic numbers.
- PDF retrieval/ranges: `src/context/retrieval.ts`; tests in `tests/context/retrieval.test.ts`.
- Prompt assembly, context ledger, exports: `src/context/message-format.ts`; tests in `tests/context/message-format.test.ts`.
- Harness design contract: `docs/HARNESS_ENGINEERING.md`.
- Release flow: `scripts/release-xpi.sh`, `scripts/release-tag.sh`, `.github/workflows/release.yml`, `docs/RELEASE.md`, `zotero-plugin.config.ts`.

## External Reference Map

- OpenAI Codex source: https://github.com/openai/codex
- Zotero source: https://github.com/zotero/zotero
- Claudian source: https://github.com/YishenTu/claudian
- Codex-style agent loop: reference OpenAI Codex concepts of model-driven tool calls, local harness validation, follow-up turns after tool calls, and approval/YOLO-style execution. Do not copy semantic intent tables into the Zotero plugin.
- Codex source symbols to re-check when needed: `needs_follow_up`, tool-call handling, context compaction/truncation, approval policy, and sandbox/permission mode.
- Claudian-style UI: reference the message rendering pattern, not its runtime architecture. Useful concepts are `MessageRenderer`, `ThinkingBlockRenderer`, `ToolCallRenderer`, context footer/process blocks, and scroll-to-bottom behavior.
- Zotero source for compatibility checks: reference Reader APIs around `Zotero.Reader.registerEventListener`, `renderTextSelectionPopup`, `Zotero.Reader.getByTabID`, annotation APIs around `Zotero.Annotations.saveFromJSON` and `DEFAULT_COLOR`, and DOM/pane IDs such as `zotero-item-pane` and `zotero-context-pane`.
- When adapting Zotero 8/9, verify API symbols against the target Zotero tag/branch before changing plugin code. Prefer symbol checks over version-specific branches unless an API truly diverges.

## Non-Negotiables

- No hardcoded semantic intent matching.
- No regex-based user-intent planner.
- No automatic full-PDF sending unless the model requests it through the tool loop or the user explicitly attaches/provides content.
- No hidden Zotero writes; future write tools must be visible and permission-aware.
- Do not remove or rewrite unrelated dirty worktree changes.
