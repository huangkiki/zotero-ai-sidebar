# Zotero AI Sidebar — Design Spec

**Date:** 2026-04-30
**Status:** Draft, awaiting user review
**Target:** Zotero 7

## 1. Problem & Motivation

Existing Zotero AI plugins (`zotero-gpt`, `papersgpt-for-zotero`) are functional but suffer from two recurring pain points for the user:

1. **Model lag** — when Anthropic or OpenAI ships a new model (e.g., Claude Opus 4.7, GPT-5.2), users must wait for the plugin author to release a new version. The model list is hardcoded.
2. **Interaction shape** — `zotero-gpt` is command-input style, not a persistent sidebar conversation. `papersgpt` has a sidebar but its model enumeration is internal and equally rigid.

This project builds a fresh plugin that solves both: a persistent sidebar chat UI plus a model-config layer where the user types the model ID as free text, so a new model is usable on launch day.

## 2. Goals & Non-Goals

**Goals (MVP):**
- Sidebar chat UI inside Zotero 7's item pane.
- Streaming responses with markdown rendering.
- Native support for Anthropic Claude and OpenAI GPT via official SDKs.
- User-defined model presets — no hardcoded model list.
- Auto-injected context from the currently selected Zotero item (metadata + PDF full-text).
- API key + preset storage in Zotero preferences.

**Non-Goals (explicitly cut from MVP):**
- Library-wide search ("find papers about X in my library").
- BibTeX / citation generation into the conversation.
- Local model support (Ollama, llama.cpp).
- PDF passage citation with click-through to PDF location.
- Tool use (letting the model manipulate Zotero state).

These are deferred, not rejected. The architecture must leave room for them.

## 3. Architecture

Three layers, each independently testable:

```
┌─────────────────────────────────────────────────┐
│  Sidebar UI                                     │
│  (React component mounted in Zotero ItemPane)   │
│   - Message list with streaming markdown        │
│   - Input box + model preset switcher           │
│   - Current-item context card                   │
└──────────────────┬──────────────────────────────┘
                   │  sends Message[], modelPreset
                   ▼
┌─────────────────────────────────────────────────┐
│  Provider Layer                                 │
│  (uniform interface over vendor SDKs)           │
│   - AnthropicProvider                           │
│   - OpenAIProvider                              │
│   - stream(messages, preset) → AsyncIterable    │
└──────────────────┬──────────────────────────────┘
                   │  reads selected item
                   ▼
┌─────────────────────────────────────────────────┐
│  Context Builder                                │
│   - Pull metadata from Zotero.Items.get(...)    │
│   - Pull PDF full-text via Zotero.Fulltext      │
│   - Compose system prompt + first user turn     │
└─────────────────────────────────────────────────┘
```

### 3.1 Sidebar UI

- Mounted via Zotero 7's `Zotero.ItemPaneManager.registerSection` API (the supported extension point for adding panels to the right pane).
- React 18 with a small state store (Zustand or plain `useReducer` — decide during implementation).
- Streaming render: each chunk arrives as `{type: 'text_delta', text}` and is appended to the in-progress assistant message.
- Markdown rendering via `react-markdown` + `remark-gfm`. Code blocks via `shiki` or `prism` (lighter — pick during implementation).

### 3.2 Provider Layer

Single interface:

```typescript
interface Provider {
  stream(
    messages: Message[],
    preset: ModelPreset,
    signal: AbortSignal
  ): AsyncIterable<StreamChunk>;
}

type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }   // Anthropic extended thinking
  | { type: 'usage'; input: number; output: number; cacheRead?: number }
  | { type: 'error'; message: string };
```

Two concrete implementations:

- **AnthropicProvider** — uses `@anthropic-ai/sdk` with `messages.stream()`. Enables prompt caching on the system prompt (per global CLAUDE.md "apps should include prompt caching").
- **OpenAIProvider** — uses `openai` SDK's Responses API in streaming mode (supports reasoning effort and tool use).

Selection by `preset.provider` field. Adding a third provider later is a new file implementing the interface; no UI or context-builder change.

### 3.3 Context Builder

When the user sends the first message of a conversation, prepend:

- **System prompt:** short instruction frame + the selected item's metadata block (title, authors, year, abstract, tags).
- **User message attachment:** PDF full-text (truncated to a configurable token budget; default 100K tokens for Claude, 50K for GPT — both well within current context windows but cheap on cache).

If no item is selected, skip both — pure chat mode.

The PDF text comes from Zotero's built-in fulltext index (`Zotero.Fulltext.getItemContent(itemID)`), which is already extracted and cached by Zotero itself. No PDF parsing on our side.

## 4. Configuration & Storage

### 4.1 Model Presets

Stored as JSON in Zotero preferences under key `extensions.zotero-ai-sidebar.presets`. Schema:

```typescript
type ModelPreset = {
  id: string;              // uuid
  label: string;           // user-visible name, e.g. "Opus 思考模式"
  provider: 'anthropic' | 'openai';
  apiKey: string;          // see 4.2
  baseUrl: string;         // overridable, default per provider
  model: string;           // free-text model id, e.g. "claude-opus-4-7-20251101"
  maxTokens: number;
  // provider-specific extras kept as opaque JSON
  extras?: Record<string, unknown>;
};
```

The preset list is the only model registry. There is no separate "supported models" enum anywhere in code.

### 4.2 API Key Storage

Stored in plaintext in Zotero preferences. Rationale:

- Zotero already stores attachment paths, library data, and user preferences as plaintext SQLite. An OS keychain integration would be the only encrypted thing in an otherwise plaintext store — security theater.
- Keychain access requires a native module, which complicates the XPI build (no native deps in the standard Zotero plugin pipeline).
- This is a single-machine, single-user tool. Threat model does not include local attackers with disk access.

If multi-machine sync is added later, keys are excluded from sync.

### 4.3 Conversation Persistence

MVP: **conversations live in-memory only**, scoped to the active item. Switching items resets the chat. Re-selecting an item does not restore history.

Rationale: persistent multi-conversation history pulls in a lot of UI scope (list, rename, delete, search). Defer until the basic loop is solid.

## 5. Build & Development

- Scaffold from `windingwind/zotero-plugin-template`.
- TypeScript strict mode.
- Hot reload via the template's built-in dev server.
- Output: `.xpi` archive. Zotero 7 loads plugins from its own extension system and does not enforce Mozilla AMO signing, so no signing pipeline is needed for personal or self-distributed installs.

Dependencies:

- `@anthropic-ai/sdk` (latest)
- `openai` (latest)
- `zotero-plugin-toolkit` (windingwind's Zotero API wrapper)
- `react`, `react-dom`
- `react-markdown`, `remark-gfm`

## 6. Error Handling

Boundary errors only (per global CLAUDE.md §2):

- Network/auth failures from provider SDKs → render as a red error bubble in the chat with the raw message. No silent fallback.
- Missing API key → inline prompt to open settings.
- Empty Zotero context (no item selected) → continue silently in pure-chat mode.
- Aborted streams (user clicked stop) → mark the message as `[interrupted]` and stop appending.

No automatic retry. No fallback model. Errors are surfaced.

## 7. Testing Strategy

- **Provider layer**: unit tests against recorded SSE fixtures from each SDK. No network in tests.
- **Context builder**: unit tests with mocked `Zotero.Items` / `Zotero.Fulltext` returning canned data.
- **Sidebar UI**: component tests (Vitest + React Testing Library) for message list rendering and input flow.
- **End-to-end**: manual, in a real Zotero 7 instance with the dev hot-reload running. No headless Zotero harness exists.

## 8. Out of Scope (Recap)

- No library-wide search.
- No BibTeX / citation generation.
- No local-model support.
- No PDF passage citation.
- No tool use.
- No conversation persistence across item switches.

## 9. Open Questions

None blocking implementation. The following are deliberately deferred to post-MVP:

- How conversations should be persisted when added (per-item, global, both).
- Whether to add a "summarize this paper" one-click action separate from free-form chat.
- Whether prompt-cache TTL refresh is worth doing in the background.
