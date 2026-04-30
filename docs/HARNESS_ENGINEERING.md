# Zotero Agent Harness Engineering

This plugin follows a Codex-style split between model strategy and local
harness enforcement.

## Contract

- The model decides which Zotero context tool is needed for the current turn.
- The harness exposes tool contracts, validates arguments, executes tools, and
  enforces budget limits.
- The harness must not use local semantic keyword rules to infer user intent.
- Tool calls are structured function calls. If parsing or validation fails, the
  harness returns structured tool errors rather than guessing a replacement
  tool.
- Previous PDF context is recorded as a ledger, not replayed as source text.
- Recent small context can be retained under policy budget so continuation turns
  can work without re-searching.
- Full PDF text is attached only for the current turn and is not replayed from
  history.
- Tool traces should be visible in the chat UI and Markdown export.

## Permission Mode

- `default`: read-only tools run directly; tools marked `requiresApproval` are
  blocked with a structured tool error until an approval UI is added.
- `yolo`: tools marked `requiresApproval` run without asking. This mirrors the
  "bypass approvals" style used by coding agents and is intended for trusted
  local workflows.

Current Zotero context tools are read-only, so YOLO mainly prepares the harness
for future write tools such as creating notes, adding annotations, and exporting
Markdown summaries.

## Local Context Tools

- `none`: attach no new Zotero/PDF context.
- `metadata_only`: rely on title, authors, year, tags, and abstract already
  available in the system prompt.
- `annotations`: attach Zotero PDF annotations, highlights, comments, page
  labels, and colors.
- `search_pdf`: search current PDF full text with the model-provided query;
  bounded candidate passages are returned to the model with character ranges.
- `pdf_range`: attach an exact PDF character range. The model must provide
  `rangeStart` and `rangeEnd`; the harness does not infer chapter boundaries.
- `full_pdf`: attach current PDF full text when the model explicitly requests
  whole-paper context through the tool loop.

Selected PDF text is explicit UI context, not an inferred semantic intent. When
present, it is attached directly to the current user message and recorded as
`selected_text` in the visible trace.

## Policy

All size and count limits live in `src/context/policy.ts`. Runtime logic should
not contain scattered magic numbers for context budgets. If a new Zotero tool
needs a limit, add it to `ContextPolicy` and pass the policy into the tool.

Codex's official turn loop does not use a semantic `max_iterations` table. It
keeps sampling while model output needs a follow-up, usually because a tool call
was emitted, and it relies on cancellation, token budgets, compaction, and tool
execution limits. In the reference code this is driven by `needs_follow_up` in
`codex-rs/core/src/session/turn.rs`, and tool calls set that flag in
`codex-rs/core/src/stream_events_utils.rs`. This plugin mirrors that shape with
`maxToolIterations` as a large safety fuse, currently `100`, not as task-type
routing logic.

## Prompt Assembly

Each turn is assembled from:

1. system prompt with current item metadata;
2. previous context ledger, explicitly marked as not currently attached;
3. chat text history without old full-PDF blocks;
4. recent small context retained within policy budget;
5. current user message with explicit selected text, if any;
6. local tool calls and tool outputs produced during the model-driven loop.

This prevents accidental re-sending of old full PDFs while still giving the
model enough state to request the smallest necessary local context again.

## Codex Design Parallels

- Codex lets the model request tools; the local side routes, validates, executes,
  truncates, and returns tool output.
- Codex does not decide semantic intent with local keyword matching.
- Codex continues the turn while `needs_follow_up` is true after tool calls; it
  does not have a fixed user-intent iteration table.
- Codex compacts or truncates history under context pressure; this plugin keeps a
  lightweight ledger and retains only small recent context under explicit policy.
- Tool availability and output size are harness responsibilities; content choice
  is a model responsibility.

## Zotero-Specific Guardrails

- Treat annotations as first-class context because they represent user-created
  reading state.
- Do not write Zotero notes or annotations unless the user explicitly asks.
- Markdown summary generation should be a separate write tool with explicit
  confirmation and a visible destination.
- If exact PDF content is unavailable, say which tool/context is missing rather
  than guessing.
