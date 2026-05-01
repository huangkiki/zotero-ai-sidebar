# Zotero AI Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-30-zotero-ai-sidebar-design.md`

**Goal:** Build a Zotero 7 plugin that puts a streaming chat sidebar next to the user's library, supporting Anthropic Claude and OpenAI GPT (plus any OpenAI-compatible endpoint via per-preset baseUrl), so new models are usable on launch day without waiting for a plugin release.

**Architecture:** Three-layer separation — Sidebar UI (React in ItemPane) → Provider Layer (uniform `stream()` over vendor SDKs) → Context Builder (pulls Zotero metadata + PDF text). User-defined model presets stored as JSON in Zotero preferences. No hardcoded model registry anywhere.

**Tech Stack:** TypeScript, `windingwind/zotero-plugin-template` (esbuild + hot reload), React 18, `@anthropic-ai/sdk`, `openai`, `react-markdown`, Vitest for unit tests.

---

## File Structure

Created during implementation:

```
src/
  index.ts                  # bootstrap entry (template-provided shell)
  hooks.ts                  # install / startup / shutdown lifecycle
  modules/
    sidebar.ts              # registers ItemPane section + mounts React
    preferences.ts          # registers preferences pane
  ui/
    App.tsx                 # root, owns provider/preset/context wiring
    ChatView.tsx            # message list + input + stream loop
    MessageBubble.tsx       # one message (role-styled, markdown)
    PresetSwitcher.tsx      # dropdown over saved presets
    ContextCard.tsx         # current item summary
    store.ts                # reducer + initialState (pure)
    PreferencesPane.tsx     # preset CRUD UI
  providers/
    types.ts                # Provider interface, Message, StreamChunk
    anthropic.ts            # AnthropicProvider
    openai.ts               # OpenAIProvider (chat.completions, OpenAI-compat)
    factory.ts              # getProvider(preset) → Provider
  context/
    builder.ts              # buildContext(source, itemID, budget)
    zotero-source.ts        # ContextSource impl backed by real Zotero APIs
  settings/
    types.ts                # ModelPreset, defaults
    storage.ts              # loadPresets / savePresets, prefs-store-injected
addon/
  manifest.json             # plugin manifest
  bootstrap.js              # template-generated, do not edit
  chrome/content/
    icons/                  # 16x16 + 32x32 placeholder
  locale/en-US/addon.ftl    # Fluent strings
  locale/zh-CN/addon.ftl
tests/
  providers/anthropic.test.ts
  providers/openai.test.ts
  providers/factory.test.ts
  context/builder.test.ts
  settings/storage.test.ts
  ui/store.test.ts
package.json
tsconfig.json
vitest.config.ts
zotero-plugin.config.ts     # template's build config
```

**Decomposition principle:** layers are split by responsibility (UI / providers / context / settings), not by technical kind. Each layer has unit-testable pure logic; only the integration thin-shells touch Zotero globals.

---

## Important Implementation Note

**OpenAI Responses API vs chat.completions:** The spec mentioned the Responses API, but on review the chat.completions API is the better choice for the MVP because aggregators (OpenRouter, Together, DeepInfra, Azure, vLLM/Ollama in OpenAI-compat mode) all expose chat.completions but few expose Responses. Since the spec emphasizes baseUrl-driven endpoint flexibility, chat.completions wins on compatibility. This deviation is recorded here and the spec stands as a target — the Responses API can be a second OpenAI-flavor provider later if needed.

---

## Task 1: Project Bootstrap

**Files:**

- Create: entire `package.json`, `tsconfig.json`, `addon/manifest.json`, `zotero-plugin.config.ts`, `src/index.ts`, `src/hooks.ts` from template
- Modify: `addon/manifest.json` (plugin id, name, version, target Zotero version)

- [ ] **Step 1: Clone the official Zotero plugin template into the project root**

```bash
cd /mnt/data/01-Projects/zotero-ai-sidebar
git clone --depth=1 https://github.com/windingwind/zotero-plugin-template.git _template
# move template contents into our repo, preserving our existing docs/ and .git/
rsync -a --exclude='.git' --exclude='docs' _template/ ./
rm -rf _template
```

Expected: `package.json`, `addon/`, `src/`, `zotero-plugin.config.ts` now exist alongside the existing `docs/` directory.

- [ ] **Step 2: Customize plugin identity in `addon/manifest.json`**

Set:

```json
{
  "manifest_version": 2,
  "name": "Zotero AI Sidebar",
  "version": "0.1.0",
  "description": "Chat sidebar for Zotero with Claude and GPT support, configurable model presets.",
  "applications": {
    "zotero": {
      "id": "zotero-ai-sidebar@local",
      "update_url": "https://example.invalid/updates.json",
      "strict_min_version": "7.0.0"
    }
  },
  "icons": {
    "32": "chrome/content/icons/icon32.png",
    "48": "chrome/content/icons/icon48.png"
  }
}
```

- [ ] **Step 3: Update `zotero-plugin.config.ts` so addon ref + name match the manifest**

Edit the existing template config:

```typescript
export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: "Zotero AI Sidebar",
  id: "zotero-ai-sidebar@local",
  namespace: "zotero-ai-sidebar",
  // keep the rest of the template's defaults
});
```

- [ ] **Step 4: Install dependencies**

```bash
cd /mnt/data/01-Projects/zotero-ai-sidebar
npm install
npm install --save @anthropic-ai/sdk openai react react-dom react-markdown remark-gfm
npm install --save-dev @types/react @types/react-dom vitest @vitest/ui happy-dom
```

Expected: `node_modules/` populated, no peer-dep errors that block builds.

- [ ] **Step 5: Add a Vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
```

Add npm script in `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  ...keep existing scripts
}
```

- [ ] **Step 6: Verify the build pipeline works**

```bash
npm run build
```

Expected: produces an `.xpi` (or build directory) in `.scaffold/build/`. No TypeScript errors.

- [ ] **Step 7: Verify the plugin loads in a real Zotero 7**

This is a manual step. Open Zotero 7 → Tools → Plugins → gear icon → Install Plugin From File → select the `.xpi`. Restart Zotero. Confirm the plugin appears in the list with no error banner.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: bootstrap plugin from zotero-plugin-template"
```

---

## Task 2: Settings — `ModelPreset` types & storage (TDD)

**Files:**

- Create: `src/settings/types.ts`, `src/settings/storage.ts`
- Create: `tests/settings/storage.test.ts`

- [ ] **Step 1: Define types**

Create `src/settings/types.ts`:

```typescript
export type ProviderKind = "anthropic" | "openai";

export interface ModelPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  extras?: Record<string, unknown>;
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

export function newPreset(provider: ProviderKind): ModelPreset {
  return {
    id: crypto.randomUUID(),
    label: provider === "anthropic" ? "Claude" : "GPT",
    provider,
    apiKey: "",
    baseUrl: DEFAULT_BASE_URLS[provider],
    model: "",
    maxTokens: 8192,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/settings/storage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  loadPresets,
  savePresets,
  type PrefsStore,
} from "../../src/settings/storage";
import type { ModelPreset } from "../../src/settings/types";

function memPrefs(): PrefsStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
  };
}

const p1: ModelPreset = {
  id: "a",
  label: "Opus",
  provider: "anthropic",
  apiKey: "sk-x",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-4-7-20251101",
  maxTokens: 8192,
};

describe("preset storage", () => {
  it("returns empty list when nothing saved", () => {
    expect(loadPresets(memPrefs())).toEqual([]);
  });

  it("round-trips presets through JSON", () => {
    const prefs = memPrefs();
    savePresets(prefs, [p1]);
    expect(loadPresets(prefs)).toEqual([p1]);
  });

  it("returns empty list when stored value is corrupt JSON", () => {
    const prefs = memPrefs();
    prefs.set("extensions.zotero-ai-sidebar.presets", "{not json");
    expect(loadPresets(prefs)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- tests/settings/storage.test.ts
```

Expected: FAIL — `Cannot find module '../../src/settings/storage'`.

- [ ] **Step 4: Implement storage**

Create `src/settings/storage.ts`:

```typescript
import type { ModelPreset } from "./types";

export interface PrefsStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const KEY = "extensions.zotero-ai-sidebar.presets";

export function loadPresets(prefs: PrefsStore): ModelPreset[] {
  const raw = prefs.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePresets(prefs: PrefsStore, presets: ModelPreset[]): void {
  prefs.set(KEY, JSON.stringify(presets));
}

// Production adapter — only imported from non-test code paths.
export function zoteroPrefs(): PrefsStore {
  return {
    get: (k) => {
      const v = (Zotero as any).Prefs.get(k, true);
      return typeof v === "string" ? v : undefined;
    },
    set: (k, v) => {
      (Zotero as any).Prefs.set(k, v, true);
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- tests/settings/storage.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 6: Commit**

```bash
git add src/settings tests/settings
git commit -m "feat(settings): ModelPreset types + JSON storage with injectable prefs"
```

---

## Task 3: Provider interface + factory (TDD on factory)

**Files:**

- Create: `src/providers/types.ts`, `src/providers/factory.ts`
- Create: `tests/providers/factory.test.ts`

- [ ] **Step 1: Define provider types**

Create `src/providers/types.ts`:

```typescript
import type { ModelPreset } from "../settings/types";

export type MessageRole = "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; input: number; output: number; cacheRead?: number }
  | { type: "error"; message: string };

export interface Provider {
  stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk>;
}

export type ProviderFactory = (preset: ModelPreset) => Provider;
```

- [ ] **Step 2: Write the failing factory test**

Create `tests/providers/factory.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getProvider } from "../../src/providers/factory";
import { AnthropicProvider } from "../../src/providers/anthropic";
import { OpenAIProvider } from "../../src/providers/openai";
import type { ModelPreset } from "../../src/settings/types";

const base: Omit<ModelPreset, "provider"> = {
  id: "x",
  label: "x",
  apiKey: "k",
  baseUrl: "https://x",
  model: "m",
  maxTokens: 1,
};

describe("getProvider", () => {
  it("returns AnthropicProvider for anthropic preset", () => {
    expect(getProvider({ ...base, provider: "anthropic" })).toBeInstanceOf(
      AnthropicProvider,
    );
  });

  it("returns OpenAIProvider for openai preset", () => {
    expect(getProvider({ ...base, provider: "openai" })).toBeInstanceOf(
      OpenAIProvider,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npm test -- tests/providers/factory.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Stub the two provider classes**

Create `src/providers/anthropic.ts`:

```typescript
import type { Provider, Message, StreamChunk } from "./types";
import type { ModelPreset } from "../settings/types";

export class AnthropicProvider implements Provider {
  async *stream(
    _messages: Message[],
    _systemPrompt: string,
    _preset: ModelPreset,
    _signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    throw new Error("not yet implemented");
  }
}
```

Create `src/providers/openai.ts`:

```typescript
import type { Provider, Message, StreamChunk } from "./types";
import type { ModelPreset } from "../settings/types";

export class OpenAIProvider implements Provider {
  async *stream(
    _messages: Message[],
    _systemPrompt: string,
    _preset: ModelPreset,
    _signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    throw new Error("not yet implemented");
  }
}
```

Create `src/providers/factory.ts`:

```typescript
import type { Provider } from "./types";
import type { ModelPreset } from "../settings/types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";

export function getProvider(preset: ModelPreset): Provider {
  switch (preset.provider) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm test -- tests/providers/factory.test.ts
```

Expected: PASS, 2/2.

- [ ] **Step 6: Commit**

```bash
git add src/providers tests/providers/factory.test.ts
git commit -m "feat(providers): types, factory, and provider class stubs"
```

---

## Task 4: AnthropicProvider implementation (TDD with mocked SDK)

**Files:**

- Modify: `src/providers/anthropic.ts`
- Create: `tests/providers/anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/anthropic.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic";
import type { ModelPreset } from "../../src/settings/types";
import type { StreamChunk } from "../../src/providers/types";

vi.mock("@anthropic-ai/sdk", () => {
  const fakeStream = async function* () {
    yield {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    };
    yield {
      type: "content_block_delta",
      delta: { type: "text_delta", text: " world" },
    };
    yield {
      type: "message_delta",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
    };
  };
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { stream: vi.fn().mockResolvedValue(fakeStream()) },
  }));
  return { default: Anthropic };
});

const preset: ModelPreset = {
  id: "a",
  label: "Opus",
  provider: "anthropic",
  apiKey: "sk",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-4-7-20251101",
  maxTokens: 1000,
};

describe("AnthropicProvider", () => {
  it("emits text_delta then usage from a streamed response", async () => {
    const p = new AnthropicProvider();
    const got: StreamChunk[] = [];
    for await (const c of p.stream(
      [{ role: "user", content: "hi" }],
      "be helpful",
      preset,
      new AbortController().signal,
    )) {
      got.push(c);
    }
    expect(got).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "usage", input: 10, output: 2, cacheRead: 5 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/providers/anthropic.test.ts
```

Expected: FAIL with "not yet implemented".

- [ ] **Step 3: Implement the provider**

Replace `src/providers/anthropic.ts` body:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { Provider, Message, StreamChunk } from "./types";
import type { ModelPreset } from "../settings/types";

export class AnthropicProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new Anthropic({
      apiKey: preset.apiKey,
      baseURL: preset.baseUrl,
      dangerouslyAllowBrowser: true,
    });

    let stream: AsyncIterable<any>;
    try {
      stream = await client.messages.stream(
        {
          model: preset.model,
          max_tokens: preset.maxTokens,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal },
      );
    } catch (err) {
      yield { type: "error", message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream as AsyncIterable<any>) {
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta?.type === "thinking_delta") {
            yield { type: "thinking_delta", text: event.delta.thinking };
          }
        } else if (event.type === "message_delta" && event.usage) {
          yield {
            type: "usage",
            input: event.usage.input_tokens ?? 0,
            output: event.usage.output_tokens ?? 0,
            cacheRead: event.usage.cache_read_input_tokens,
          };
        }
      }
    } catch (err) {
      yield { type: "error", message: errMsg(err) };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- tests/providers/anthropic.test.ts
```

Expected: PASS, 1/1.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropic.ts tests/providers/anthropic.test.ts
git commit -m "feat(providers): implement AnthropicProvider with prompt caching"
```

---

## Task 5: OpenAIProvider implementation (TDD with mocked SDK)

**Files:**

- Modify: `src/providers/openai.ts`
- Create: `tests/providers/openai.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/openai.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { OpenAIProvider } from "../../src/providers/openai";
import type { ModelPreset } from "../../src/settings/types";
import type { StreamChunk } from "../../src/providers/types";

vi.mock("openai", () => {
  const fakeStream = async function* () {
    yield { choices: [{ delta: { content: "Hi" } }] };
    yield { choices: [{ delta: { content: " there" } }] };
    yield {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    };
  };
  const OpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn().mockResolvedValue(fakeStream()) } },
  }));
  return { default: OpenAI };
});

const preset: ModelPreset = {
  id: "o",
  label: "GPT",
  provider: "openai",
  apiKey: "sk",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.2",
  maxTokens: 1000,
};

describe("OpenAIProvider", () => {
  it("emits text deltas then usage", async () => {
    const p = new OpenAIProvider();
    const got: StreamChunk[] = [];
    for await (const c of p.stream(
      [{ role: "user", content: "hi" }],
      "be helpful",
      preset,
      new AbortController().signal,
    )) {
      got.push(c);
    }
    expect(got).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "text_delta", text: " there" },
      { type: "usage", input: 7, output: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/providers/openai.test.ts
```

Expected: FAIL with "not yet implemented".

- [ ] **Step 3: Implement the provider**

Replace `src/providers/openai.ts`:

```typescript
import OpenAI from "openai";
import type { Provider, Message, StreamChunk } from "./types";
import type { ModelPreset } from "../settings/types";

export class OpenAIProvider implements Provider {
  async *stream(
    messages: Message[],
    systemPrompt: string,
    preset: ModelPreset,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const client = new OpenAI({
      apiKey: preset.apiKey,
      baseURL: preset.baseUrl,
      dangerouslyAllowBrowser: true,
    });

    let stream: AsyncIterable<any>;
    try {
      stream = (await client.chat.completions.create(
        {
          model: preset.model,
          max_tokens: preset.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        },
        { signal },
      )) as any;
    } catch (err) {
      yield { type: "error", message: errMsg(err) };
      return;
    }

    try {
      for await (const event of stream as AsyncIterable<any>) {
        const text = event.choices?.[0]?.delta?.content;
        if (text) yield { type: "text_delta", text };
        if (event.usage) {
          yield {
            type: "usage",
            input: event.usage.prompt_tokens ?? 0,
            output: event.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (err) {
      yield { type: "error", message: errMsg(err) };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- tests/providers/openai.test.ts
```

Expected: PASS, 1/1.

- [ ] **Step 5: Commit**

```bash
git add src/providers/openai.ts tests/providers/openai.test.ts
git commit -m "feat(providers): implement OpenAIProvider over chat.completions"
```

---

## Task 6: Context Builder (TDD with mocked Zotero source)

**Files:**

- Create: `src/context/builder.ts`, `src/context/zotero-source.ts`
- Create: `tests/context/builder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/context/builder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildContext, type ContextSource } from "../../src/context/builder";

const fakeSource: ContextSource = {
  async getItem(id) {
    if (id !== 1) return null;
    return {
      title: "Attention Is All You Need",
      authors: ["Vaswani", "Shazeer"],
      year: 2017,
      tags: ["transformer"],
      abstract: "We propose a new architecture.",
    };
  },
  async getFullText(_id) {
    return "A".repeat(10_000);
  },
};

describe("buildContext", () => {
  it("returns base prompt only when no item id", async () => {
    const ctx = await buildContext(fakeSource, null, 100);
    expect(ctx.systemPrompt).toMatch(/research assistant/);
    expect(ctx.pdfText).toBeNull();
  });

  it("returns base prompt only when item not found", async () => {
    const ctx = await buildContext(fakeSource, 999, 100);
    expect(ctx.systemPrompt).toMatch(/research assistant/);
    expect(ctx.pdfText).toBeNull();
  });

  it("includes metadata block in system prompt when item present", async () => {
    const ctx = await buildContext(fakeSource, 1, 1000);
    expect(ctx.systemPrompt).toContain("Title: Attention Is All You Need");
    expect(ctx.systemPrompt).toContain("Authors: Vaswani, Shazeer");
    expect(ctx.systemPrompt).toContain("Year: 2017");
    expect(ctx.systemPrompt).toContain("Tags: transformer");
    expect(ctx.systemPrompt).toContain(
      "Abstract: We propose a new architecture.",
    );
  });

  it("truncates pdf text to ~4 chars per token budget", async () => {
    const ctx = await buildContext(fakeSource, 1, 100); // 100 tokens → 400 chars
    expect(ctx.pdfText?.length).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/context/builder.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

Create `src/context/builder.ts`:

```typescript
export interface ItemMetadata {
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  tags: string[];
}

export interface ContextSource {
  getItem(itemID: number): Promise<ItemMetadata | null>;
  getFullText(itemID: number): Promise<string>;
}

export interface BuiltContext {
  systemPrompt: string;
  pdfText: string | null;
}

const SYSTEM_BASE =
  "You are a research assistant helping the user understand academic papers. " +
  "Cite the paper when answering questions about its content. Be precise and concise.";

export async function buildContext(
  source: ContextSource,
  itemID: number | null,
  pdfTokenBudget: number,
): Promise<BuiltContext> {
  if (itemID == null) return { systemPrompt: SYSTEM_BASE, pdfText: null };

  const item = await source.getItem(itemID);
  if (!item) return { systemPrompt: SYSTEM_BASE, pdfText: null };

  const meta = formatMetadata(item);
  const pdfText = await source.getFullText(itemID);
  const truncated = truncate(pdfText, pdfTokenBudget);

  return {
    systemPrompt: `${SYSTEM_BASE}\n\nThe user is currently viewing this paper:\n${meta}`,
    pdfText: truncated || null,
  };
}

function formatMetadata(item: ItemMetadata): string {
  const lines: string[] = [`Title: ${item.title}`];
  if (item.authors.length) lines.push(`Authors: ${item.authors.join(", ")}`);
  if (item.year) lines.push(`Year: ${item.year}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.abstract) lines.push(`Abstract: ${item.abstract}`);
  return lines.join("\n");
}

function truncate(text: string, tokenBudget: number): string {
  // Conservative ~4 chars/token; we rely on the model's own tokenizer.
  const charBudget = tokenBudget * 4;
  return text.length > charBudget ? text.slice(0, charBudget) : text;
}
```

Create `src/context/zotero-source.ts` (production adapter; not unit-tested — touched only at runtime):

```typescript
import type { ContextSource, ItemMetadata } from "./builder";

export const zoteroContextSource: ContextSource = {
  async getItem(itemID) {
    const Z = (globalThis as any).Zotero;
    const item = await Z.Items.getAsync(itemID);
    if (!item) return null;
    const meta: ItemMetadata = {
      title: item.getField("title") || "",
      authors: item
        .getCreators()
        .map((c: any) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
      year: parseYear(item.getField("date")),
      abstract: item.getField("abstractNote") || undefined,
      tags: item.getTags().map((t: any) => t.tag),
    };
    return meta;
  },
  async getFullText(itemID) {
    const Z = (globalThis as any).Zotero;
    const attachments = await Z.Items.getAsync(itemID).then((it: any) =>
      it.getAttachments().map((id: number) => Z.Items.getAsync(id)),
    );
    const items = await Promise.all(attachments);
    for (const att of items) {
      if (att.attachmentContentType === "application/pdf") {
        const content = await Z.Fulltext.getItemContent(att.id);
        if (content?.content) return content.content as string;
      }
    }
    return "";
  },
};

function parseYear(date: string): number | undefined {
  const m = date?.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- tests/context/builder.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/context tests/context
git commit -m "feat(context): builder + Zotero source adapter"
```

---

## Task 7: UI state reducer (TDD)

**Files:**

- Create: `src/ui/store.ts`
- Create: `tests/ui/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/ui/store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { reducer, initialState } from "../../src/ui/store";

describe("chat reducer", () => {
  it("appends user message on user_send", () => {
    const s = reducer(initialState, { type: "user_send", content: "hi" });
    expect(s.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(s.error).toBeNull();
  });

  it("starts an in-progress assistant on assistant_start", () => {
    const s = reducer(initialState, { type: "assistant_start" });
    expect(s.inProgress).toEqual({ role: "assistant", content: "" });
  });

  it("appends streamed text to in-progress assistant", () => {
    let s = reducer(initialState, { type: "assistant_start" });
    s = reducer(s, { type: "assistant_text", text: "Hel" });
    s = reducer(s, { type: "assistant_text", text: "lo" });
    expect(s.inProgress?.content).toBe("Hello");
  });

  it("finalizes on assistant_done", () => {
    let s = reducer(initialState, { type: "assistant_start" });
    s = reducer(s, { type: "assistant_text", text: "ok" });
    s = reducer(s, { type: "assistant_done" });
    expect(s.messages).toEqual([{ role: "assistant", content: "ok" }]);
    expect(s.inProgress).toBeNull();
  });

  it("clears in-progress on assistant_error and records message", () => {
    let s = reducer(initialState, { type: "assistant_start" });
    s = reducer(s, { type: "assistant_error", message: "boom" });
    expect(s.inProgress).toBeNull();
    expect(s.error).toBe("boom");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- tests/ui/store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

Create `src/ui/store.ts`:

```typescript
import type { Message } from "../providers/types";

export interface InProgress {
  role: "assistant";
  content: string;
  thinking?: string;
}

export interface ChatState {
  messages: Message[];
  inProgress: InProgress | null;
  error: string | null;
}

export type ChatAction =
  | { type: "user_send"; content: string }
  | { type: "assistant_start" }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_thinking"; text: string }
  | { type: "assistant_done" }
  | { type: "assistant_error"; message: string }
  | { type: "reset" };

export const initialState: ChatState = {
  messages: [],
  inProgress: null,
  error: null,
};

export function reducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case "user_send":
      return {
        ...s,
        messages: [...s.messages, { role: "user", content: a.content }],
        error: null,
      };
    case "assistant_start":
      return { ...s, inProgress: { role: "assistant", content: "" } };
    case "assistant_text":
      if (!s.inProgress) return s;
      return {
        ...s,
        inProgress: { ...s.inProgress, content: s.inProgress.content + a.text },
      };
    case "assistant_thinking":
      if (!s.inProgress) return s;
      return {
        ...s,
        inProgress: {
          ...s.inProgress,
          thinking: (s.inProgress.thinking ?? "") + a.text,
        },
      };
    case "assistant_done":
      if (!s.inProgress) return s;
      return {
        ...s,
        messages: [
          ...s.messages,
          { role: "assistant", content: s.inProgress.content },
        ],
        inProgress: null,
      };
    case "assistant_error":
      return { ...s, inProgress: null, error: a.message };
    case "reset":
      return initialState;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- tests/ui/store.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/ui/store.ts tests/ui/store.test.ts
git commit -m "feat(ui): chat state reducer with streaming + error states"
```

---

## Task 8: ChatView + MessageBubble (manual verify in dev mode)

**Files:**

- Create: `src/ui/MessageBubble.tsx`, `src/ui/ChatView.tsx`

- [ ] **Step 1: Implement MessageBubble**

Create `src/ui/MessageBubble.tsx`:

```tsx
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../providers/types";
import type { InProgress } from "./store";

interface Props {
  message: Message | InProgress;
  streaming?: boolean;
}

export function MessageBubble({ message, streaming = false }: Props) {
  const role = message.role;
  return (
    <div
      className={`bubble bubble-${role}${streaming ? " bubble-streaming" : ""}`}
    >
      <div className="bubble-role">{role === "user" ? "You" : "AI"}</div>
      <div className="bubble-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement ChatView**

Create `src/ui/ChatView.tsx`:

```tsx
import React, { useReducer, useState, useRef, useEffect } from "react";
import { reducer, initialState } from "./store";
import { MessageBubble } from "./MessageBubble";
import type { Provider, Message } from "../providers/types";
import type { ModelPreset } from "../settings/types";

interface Props {
  provider: Provider;
  preset: ModelPreset;
  buildContext: () => Promise<{ systemPrompt: string; pdfText: string | null }>;
}

export function ChatView({ provider, preset, buildContext }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages, state.inProgress]);

  const onSend = async () => {
    if (!input.trim() || state.inProgress) return;
    const text = input;
    setInput("");
    dispatch({ type: "user_send", content: text });

    const ctx = await buildContext();
    let messagesForApi: Message[] = [
      ...state.messages,
      { role: "user", content: text },
    ];
    if (ctx.pdfText && state.messages.length === 0) {
      messagesForApi = [
        { role: "user", content: `[Paper full text]\n${ctx.pdfText}` },
        {
          role: "assistant",
          content: "Got it. Ask me anything about this paper.",
        },
        ...messagesForApi,
      ];
    }

    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "assistant_start" });
    try {
      for await (const chunk of provider.stream(
        messagesForApi,
        ctx.systemPrompt,
        preset,
        controller.signal,
      )) {
        if (chunk.type === "text_delta")
          dispatch({ type: "assistant_text", text: chunk.text });
        else if (chunk.type === "thinking_delta")
          dispatch({ type: "assistant_thinking", text: chunk.text });
        else if (chunk.type === "error") {
          dispatch({ type: "assistant_error", message: chunk.message });
          return;
        }
      }
      dispatch({ type: "assistant_done" });
    } finally {
      abortRef.current = null;
    }
  };

  const onStop = () => abortRef.current?.abort();

  return (
    <div className="chat-view">
      <div className="messages">
        {state.messages.map((m, i) => (
          <MessageBubble key={i} message={m} />
        ))}
        {state.inProgress && (
          <MessageBubble message={state.inProgress} streaming />
        )}
        {state.error && <div className="error">{state.error}</div>}
        <div ref={endRef} />
      </div>
      <div className="input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="问点什么... (Ctrl+Enter 发送)"
          rows={3}
        />
        {state.inProgress ? (
          <button onClick={onStop}>停止</button>
        ) : (
          <button onClick={onSend} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add a minimal CSS file**

Create `addon/chrome/content/sidebar.css`:

```css
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-family: system-ui, sans-serif;
  font-size: 13px;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.bubble {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 6px;
}
.bubble-user {
  background: #e8f0fe;
}
.bubble-assistant {
  background: #f4f4f4;
}
.bubble-streaming {
  opacity: 0.85;
}
.bubble-role {
  font-size: 10px;
  color: #666;
  margin-bottom: 2px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.bubble-body p {
  margin: 4px 0;
}
.bubble-body pre {
  background: #2b2b2b;
  color: #e6e6e6;
  padding: 6px;
  border-radius: 4px;
  overflow-x: auto;
}
.input-row {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid #ddd;
}
.input-row textarea {
  flex: 1;
  resize: vertical;
  font-family: inherit;
}
.error {
  color: #c00;
  padding: 6px;
  background: #fee;
  border-radius: 4px;
  margin: 6px 0;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/MessageBubble.tsx src/ui/ChatView.tsx addon/chrome/content/sidebar.css
git commit -m "feat(ui): ChatView + MessageBubble with streaming markdown"
```

---

## Task 9: PresetSwitcher + ContextCard

**Files:**

- Create: `src/ui/PresetSwitcher.tsx`, `src/ui/ContextCard.tsx`

- [ ] **Step 1: Implement PresetSwitcher**

Create `src/ui/PresetSwitcher.tsx`:

```tsx
import React from "react";
import type { ModelPreset } from "../settings/types";

interface Props {
  presets: ModelPreset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
}

export function PresetSwitcher({
  presets,
  selectedId,
  onSelect,
  onOpenSettings,
}: Props) {
  if (presets.length === 0) {
    return (
      <div className="preset-empty">
        <span>未配置模型</span>
        <button onClick={onOpenSettings}>打开设置</button>
      </div>
    );
  }
  return (
    <div className="preset-switcher">
      <select
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({p.provider} · {p.model || "no model"})
          </option>
        ))}
      </select>
      <button onClick={onOpenSettings} title="设置">
        ⚙
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Implement ContextCard**

Create `src/ui/ContextCard.tsx`:

```tsx
import React from "react";
import type { ItemMetadata } from "../context/builder";

interface Props {
  item: ItemMetadata | null;
}

export function ContextCard({ item }: Props) {
  if (!item) {
    return <div className="ctx-card ctx-empty">未选中条目，纯聊天模式</div>;
  }
  return (
    <div className="ctx-card">
      <div className="ctx-title">{item.title}</div>
      <div className="ctx-meta">
        {item.authors.slice(0, 3).join(", ")}
        {item.authors.length > 3 ? " et al." : ""}
        {item.year ? ` · ${item.year}` : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Append styles to `addon/chrome/content/sidebar.css`**

Append:

```css
.preset-switcher,
.preset-empty {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  align-items: center;
  border-bottom: 1px solid #ddd;
}
.preset-switcher select {
  flex: 1;
}
.ctx-card {
  padding: 6px 8px;
  background: #fafafa;
  border-bottom: 1px solid #eee;
}
.ctx-empty {
  color: #999;
  font-style: italic;
}
.ctx-title {
  font-weight: 600;
  font-size: 12px;
}
.ctx-meta {
  font-size: 11px;
  color: #666;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/PresetSwitcher.tsx src/ui/ContextCard.tsx addon/chrome/content/sidebar.css
git commit -m "feat(ui): preset switcher + context card components"
```

---

## Task 10: Sidebar mount in Zotero ItemPane

**Files:**

- Create: `src/ui/App.tsx`, `src/modules/sidebar.ts`
- Modify: `src/hooks.ts` (call `registerSidebar` on startup, unregister on shutdown)

- [ ] **Step 1: Implement App**

Create `src/ui/App.tsx`:

```tsx
import React, { useEffect, useState, useCallback } from "react";
import { ChatView } from "./ChatView";
import { PresetSwitcher } from "./PresetSwitcher";
import { ContextCard } from "./ContextCard";
import { loadPresets, zoteroPrefs } from "../settings/storage";
import { getProvider } from "../providers/factory";
import { buildContext, type ItemMetadata } from "../context/builder";
import { zoteroContextSource } from "../context/zotero-source";
import type { ModelPreset } from "../settings/types";

interface Props {
  itemID: number | null;
  openPreferences: () => void;
}

export function App({ itemID, openPreferences }: Props) {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [item, setItem] = useState<ItemMetadata | null>(null);

  useEffect(() => {
    const p = loadPresets(zoteroPrefs());
    setPresets(p);
    if (p.length && !selectedId) setSelectedId(p[0].id);
  }, []);

  useEffect(() => {
    if (itemID == null) {
      setItem(null);
      return;
    }
    zoteroContextSource.getItem(itemID).then(setItem);
  }, [itemID]);

  const preset = presets.find((p) => p.id === selectedId) ?? null;
  const provider = preset ? getProvider(preset) : null;

  const buildCtx = useCallback(async () => {
    return buildContext(zoteroContextSource, itemID, 100_000);
  }, [itemID]);

  return (
    <div className="zai-app" key={itemID ?? "no-item"}>
      <PresetSwitcher
        presets={presets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenSettings={openPreferences}
      />
      <ContextCard item={item} />
      {provider && preset ? (
        <ChatView provider={provider} preset={preset} buildContext={buildCtx} />
      ) : (
        <div className="empty-state">先到设置里添加一个模型预设。</div>
      )}
    </div>
  );
}
```

The `key={itemID ?? 'no-item'}` is deliberate: switching items remounts the chat, fulfilling spec §4.3 (in-memory, scoped to current item).

- [ ] **Step 2: Implement sidebar registration**

Create `src/modules/sidebar.ts`:

```typescript
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../ui/App";

let registeredId: string | null = null;
const roots = new WeakMap<Element, Root>();

export function registerSidebar() {
  const Z = (globalThis as any).Zotero;
  registeredId = Z.ItemPaneManager.registerSection({
    paneID: "zotero-ai-sidebar",
    pluginID: "zotero-ai-sidebar@local",
    header: {
      l10nID: "zai-sidebar-header",
      icon: "chrome://zotero-ai-sidebar/content/icons/icon32.png",
    },
    sidenav: {
      l10nID: "zai-sidebar-sidenav",
      icon: "chrome://zotero-ai-sidebar/content/icons/icon32.png",
    },
    bodyXHTML:
      '<html:div id="zai-root" style="height:100%;display:flex;flex-direction:column"></html:div>',
    onRender: ({ body, item }: any) => {
      const mount = body.querySelector("#zai-root") as HTMLElement;
      if (!mount) return;
      let root = roots.get(mount);
      if (!root) {
        root = createRoot(mount);
        roots.set(mount, root);
      }
      const itemID = item ? (item.id as number) : null;
      root.render(
        React.createElement(App, {
          itemID,
          openPreferences: () =>
            Z.PreferencePanes.openWith({ id: "zotero-ai-sidebar-prefs" }),
        }),
      );
    },
    onItemChange: ({ body, item }: any) => {
      const mount = body.querySelector("#zai-root") as HTMLElement;
      const root = roots.get(mount);
      if (!root) return;
      root.render(
        React.createElement(App, {
          itemID: item ? (item.id as number) : null,
          openPreferences: () =>
            Z.PreferencePanes.openWith({ id: "zotero-ai-sidebar-prefs" }),
        }),
      );
    },
  });
}

export function unregisterSidebar() {
  if (!registeredId) return;
  const Z = (globalThis as any).Zotero;
  Z.ItemPaneManager.unregisterSection(registeredId);
  registeredId = null;
}
```

- [ ] **Step 3: Wire into hooks**

Modify `src/hooks.ts` (template ships an existing `hooks.ts` — append to its existing startup/shutdown handlers, do not delete template scaffolding):

```typescript
import { registerSidebar, unregisterSidebar } from "./modules/sidebar";

// inside the existing onStartup or equivalent:
registerSidebar();

// inside the existing onShutdown:
unregisterSidebar();
```

- [ ] **Step 4: Add Fluent strings**

Edit `addon/locale/en-US/addon.ftl`:

```
zai-sidebar-header = AI Chat
zai-sidebar-sidenav = AI
```

Edit `addon/locale/zh-CN/addon.ftl`:

```
zai-sidebar-header = AI 对话
zai-sidebar-sidenav = AI
```

- [ ] **Step 5: Build, install, manual verify**

```bash
npm run build
```

Install the freshly built `.xpi` in Zotero 7. Open any item. Confirm:

- The sidebar tab labelled "AI Chat" / "AI 对话" appears in the right pane.
- Selecting an item shows that item's title in the ContextCard.
- Switching items resets the chat history.

If no presets exist, expect to see "未配置模型" with a settings button (clicking it will not work yet — preferences pane is Task 11).

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx src/modules/sidebar.ts src/hooks.ts addon/locale
git commit -m "feat(integration): mount React sidebar in Zotero ItemPane"
```

---

## Task 11: Preferences Pane (preset CRUD)

**Files:**

- Create: `src/ui/PreferencesPane.tsx`, `src/modules/preferences.ts`
- Create: `addon/chrome/content/preferences.xhtml`
- Modify: `src/hooks.ts` (call `registerPreferences` on startup)
- Modify: `addon/manifest.json` (add `preferences` block)

- [ ] **Step 1: Implement preferences React UI**

Create `src/ui/PreferencesPane.tsx`:

```tsx
import React, { useEffect, useState } from "react";
import { loadPresets, savePresets, zoteroPrefs } from "../settings/storage";
import {
  newPreset,
  DEFAULT_BASE_URLS,
  type ModelPreset,
  type ProviderKind,
} from "../settings/types";

export function PreferencesPane() {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    setPresets(loadPresets(zoteroPrefs()));
  }, []);

  const persist = (next: ModelPreset[]) => {
    setPresets(next);
    savePresets(zoteroPrefs(), next);
  };

  const add = (kind: ProviderKind) => {
    const p = newPreset(kind);
    persist([...presets, p]);
    setEditingId(p.id);
  };

  const update = (id: string, patch: Partial<ModelPreset>) => {
    persist(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const remove = (id: string) => persist(presets.filter((p) => p.id !== id));

  return (
    <div className="prefs-pane">
      <h3>模型预设</h3>
      <div className="add-buttons">
        <button onClick={() => add("anthropic")}>+ Anthropic</button>
        <button onClick={() => add("openai")}>+ OpenAI 兼容</button>
      </div>
      <div className="preset-list">
        {presets.map((p) => (
          <PresetRow
            key={p.id}
            preset={p}
            expanded={editingId === p.id}
            onToggle={() => setEditingId(editingId === p.id ? null : p.id)}
            onUpdate={(patch) => update(p.id, patch)}
            onRemove={() => remove(p.id)}
          />
        ))}
        {presets.length === 0 && (
          <div className="empty">暂无预设。点击上方按钮添加。</div>
        )}
      </div>
    </div>
  );
}

function PresetRow({
  preset,
  expanded,
  onToggle,
  onUpdate,
  onRemove,
}: {
  preset: ModelPreset;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<ModelPreset>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="preset-row">
      <div className="preset-summary" onClick={onToggle}>
        <span className="preset-label">{preset.label}</span>
        <span className="preset-provider">{preset.provider}</span>
        <span className="preset-model">{preset.model || "(no model)"}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          删除
        </button>
      </div>
      {expanded && (
        <div className="preset-edit">
          <Field label="名称">
            <input
              value={preset.label}
              onChange={(e) => onUpdate({ label: e.target.value })}
            />
          </Field>
          <Field label="API Key">
            <input
              type="password"
              value={preset.apiKey}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
          </Field>
          <Field label="Base URL">
            <input
              value={preset.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder={DEFAULT_BASE_URLS[preset.provider]}
            />
          </Field>
          <Field label="Model ID">
            <input
              value={preset.model}
              onChange={(e) => onUpdate({ model: e.target.value })}
              placeholder={
                preset.provider === "anthropic"
                  ? "claude-opus-4-7-…"
                  : "gpt-5.2"
              }
            />
          </Field>
          <Field label="Max tokens">
            <input
              type="number"
              value={preset.maxTokens}
              onChange={(e) =>
                onUpdate({ maxTokens: parseInt(e.target.value, 10) || 0 })
              }
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="prefs-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Add preferences XHTML shell**

Create `addon/chrome/content/preferences.xhtml`:

```xml
<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <link rel="stylesheet" href="chrome://zotero-ai-sidebar/content/sidebar.css" />
  </head>
  <body>
    <div id="zai-prefs-root" style="padding:12px"></div>
  </body>
</html>
```

- [ ] **Step 3: Implement preferences registration**

Create `src/modules/preferences.ts`:

```typescript
import React from "react";
import { createRoot } from "react-dom/client";
import { PreferencesPane } from "../ui/PreferencesPane";

export function registerPreferences() {
  const Z = (globalThis as any).Zotero;
  Z.PreferencePanes.register({
    pluginID: "zotero-ai-sidebar@local",
    src: "chrome://zotero-ai-sidebar/content/preferences.xhtml",
    label: "AI Sidebar",
    image: "chrome://zotero-ai-sidebar/content/icons/icon32.png",
    id: "zotero-ai-sidebar-prefs",
    onLoad: ({ doc }: any) => {
      const mount = doc.getElementById("zai-prefs-root");
      if (!mount) return;
      const root = createRoot(mount);
      root.render(React.createElement(PreferencesPane));
    },
  });
}
```

- [ ] **Step 4: Wire into startup**

Modify `src/hooks.ts` to call `registerPreferences()` alongside `registerSidebar()`:

```typescript
import { registerPreferences } from "./modules/preferences";

// inside existing onStartup:
registerPreferences();
```

- [ ] **Step 5: Append preferences styles**

Append to `addon/chrome/content/sidebar.css`:

```css
.prefs-pane h3 {
  margin-top: 0;
}
.add-buttons {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.preset-row {
  border: 1px solid #ddd;
  border-radius: 6px;
  margin-bottom: 6px;
}
.preset-summary {
  display: flex;
  gap: 8px;
  padding: 8px;
  align-items: center;
  cursor: pointer;
}
.preset-label {
  font-weight: 600;
}
.preset-provider {
  color: #666;
  font-size: 11px;
  text-transform: uppercase;
}
.preset-model {
  flex: 1;
  color: #333;
  font-family: monospace;
  font-size: 12px;
}
.preset-edit {
  padding: 8px;
  border-top: 1px solid #eee;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prefs-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prefs-field span {
  width: 100px;
  flex-shrink: 0;
  font-size: 12px;
}
.prefs-field input {
  flex: 1;
}
.empty {
  color: #999;
  padding: 12px;
  text-align: center;
}
```

- [ ] **Step 6: Build, install, manual verify**

```bash
npm run build
```

Install. In Zotero 7 → Edit → Preferences → "AI Sidebar". Confirm:

- Preferences pane appears.
- Can add an Anthropic preset, fill in label / API key / model id, expand/collapse, delete.
- Reopening preferences shows the saved presets.

- [ ] **Step 7: Commit**

```bash
git add src/ui/PreferencesPane.tsx src/modules/preferences.ts addon/chrome/content/preferences.xhtml addon/chrome/content/sidebar.css src/hooks.ts
git commit -m "feat(prefs): preferences pane with preset CRUD"
```

---

## Task 12: End-to-end smoke test (manual)

No new code. Run through this checklist with a real Zotero 7 install and a real API key.

- [ ] **Step 1: Build a fresh xpi and install**

```bash
npm run build
```

Install in Zotero 7.

- [ ] **Step 2: Add an Anthropic preset**

Preferences → AI Sidebar → + Anthropic → fill in API key, model `claude-opus-4-7-20251101` (or whatever the current Opus is), maxTokens 8192.

- [ ] **Step 3: Pure chat (no item selected)**

Select no item. Confirm the sidebar shows "未选中条目，纯聊天模式". Send "Hello, what model are you?". Confirm streaming response renders progressively, markdown formats correctly, and the bubble settles when done.

- [ ] **Step 4: Paper chat**

Select a paper that has a PDF attachment with extracted full-text. Confirm:

- ContextCard shows the title + authors + year.
- First message attaches the PDF text (no visible UI change but the assistant should be able to answer paper-specific questions).
- Ask "summarize this paper in 3 bullet points". Confirm the response references the paper's content.

- [ ] **Step 5: Switch items mid-conversation**

While the paper chat has 2-3 turns of history, click another item. Confirm the chat resets to empty and the new item's metadata appears.

- [ ] **Step 6: OpenAI compat path (optional but recommended)**

Add a second preset with provider=openai pointed at any OpenAI-compatible endpoint you have access to (OpenRouter, Azure, local Ollama at `http://localhost:11434/v1`). Switch to it via the dropdown. Send a message. Confirm streaming works.

- [ ] **Step 7: Error path — bad API key**

Edit the Anthropic preset, set API key to `sk-bad`. Send a message. Confirm a red error bubble appears with the auth-failure message and the chat does not get stuck in an "in-progress" state.

- [ ] **Step 8: Stop button**

Send a message that will produce a long response. Click "停止" mid-stream. Confirm the partial response is preserved as a finalized assistant message and the input is re-enabled.

- [ ] **Step 9: Commit checklist results**

If everything passes, no code changes — just tag the release:

```bash
git tag v0.1.0
```

If issues are found, file them as separate fix tasks; do not amend this task.

---

## Coverage Map (spec → tasks)

| Spec section                                   | Implemented in                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| §3.1 Sidebar UI                                | T8 (ChatView/MessageBubble), T9 (PresetSwitcher/ContextCard), T10 (mount) |
| §3.2 Provider Layer                            | T3 (interface/factory), T4 (Anthropic), T5 (OpenAI)                       |
| §3.3 Context Builder                           | T6                                                                        |
| §4.1 Model Presets                             | T2 (storage), T11 (UI)                                                    |
| §4.1 baseUrl flexibility                       | T2 (type), T4/T5 (passed to SDKs), T11 (editable in UI)                   |
| §4.2 API key storage (plaintext, Zotero prefs) | T2                                                                        |
| §4.3 In-memory conversation, scoped to item    | T7 (reducer), T10 (`key={itemID}` remount)                                |
| §5 Build pipeline                              | T1                                                                        |
| §6 Error handling (boundary only, no fallback) | T4/T5 (error chunk), T7 (assistant_error), T8 (red bubble)                |
| §7 Testing strategy                            | T2/T4/T5/T6/T7 unit tests; T12 manual e2e                                 |
| §8 MVP non-goals                               | not implemented (correct)                                                 |

## Follow-up: Reader-Scoped Annotation Retrieval

**Problem:** When the user asks to annotate a limited section such as “第一章” or “Introduction”, the model can currently call `zotero_get_reader_pdf_text` without `start/end`, which sends the whole Reader text layer before writing highlights. This is correct for full-paper annotation, but too broad for section-scoped annotation.

**Goal:** Let the model locate and read only the Reader text range needed for PDF write workflows, while keeping the Codex-style rule that the model chooses tools and the local harness only executes them.

**Planned tools / behavior:**

- [ ] Add `zotero_search_reader_pdf(query, topK?)` that searches the active Reader text layer and returns bounded passages with `chars start-end`, using the same text source as `zotero_annotate_passage`.
- [ ] Keep `zotero_get_reader_pdf_text({ start, end })` as the range reader for Reader text; use it after `zotero_search_reader_pdf` identifies section boundaries.
- [ ] Update the tool manual: for section-scoped PDF writes, the model must first search Reader text for headings/boundaries, then read only the relevant range; only full-paper annotation should call `zotero_get_reader_pdf_text` without `start/end`.
- [ ] Add tests for “Reader search returns ranges”, “Reader range caps by policy”, and “cache search remains separate from Reader search”.
- [ ] Keep PDF modification gated by `requiresApproval` / YOLO; adding Reader search must not add any hidden write path.

**Expected flow:**

```text
User: 给第一章增加注释
Model: zotero_get_current_item
Model: zotero_search_reader_pdf({ query: "Introduction" })
Model: zotero_search_reader_pdf({ query: "2" / next section title })
Model: zotero_get_reader_pdf_text({ start, end })
Model: zotero_annotate_passage(...) for selected sentences
```
