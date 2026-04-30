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

## Non-Negotiables

- No hardcoded semantic intent matching.
- No regex-based user-intent planner.
- No automatic full-PDF sending unless the model requests it through the tool loop or the user explicitly attaches/provides content.
- No hidden Zotero writes; future write tools must be visible and permission-aware.
- Do not remove or rewrite unrelated dirty worktree changes.
