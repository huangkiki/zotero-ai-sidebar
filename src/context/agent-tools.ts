import type { AgentTool, ToolExecutionResult } from "../providers/types";
import type { ContextSource, ItemMetadata } from "./builder";
import { formatAnnotations, formatRetrievedPassages } from "./message-format";
import { createPdfLocator, type PdfLocator } from "./pdf-locator";
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "./policy";
import { extractPdfRange, searchPdfPassages } from "./retrieval";

// Codex-style local harness for Zotero. Each tool is a structured function
// the model can call; the harness validates args, enforces policy budgets,
// runs the Zotero side-effect, and returns a structured result.
//
// INVARIANT: NO local intent routing. The model decides whether it needs
// metadata, search, range, full PDF, or annotation writes — never our code.
// (See CLAUDE.md "No hardcoded semantic intent matching".)
//
// REF: Codex `mcp_tool_call` registry pattern; OpenAI Codex
//      `responses_api/function_call` schema.

export interface ToolFactoryOptions {
  source: ContextSource;
  itemID: number | null;
  policy?: ContextPolicy;
  selectionAnnotation?: () => SelectionAnnotationDraft | null;
  // Kept for the explicit "full-text highlights" quick prompt. Tool
  // availability no longer branches on this flag; the model sees the same
  // manual/tools and decides what to call.
  fullTextHighlight?: boolean;
  getActiveReader?: () => unknown | null;
}

export interface ZoteroAgentToolSession {
  tools: AgentTool[];
  dispose(): void;
}

export interface SelectionAnnotationDraft {
  text: string;
  attachmentID: number;
  annotation: Record<string, unknown>;
}

// Session-less convenience wrapper for tests. Production callers should
// use `createZoteroAgentToolSession` directly so they can `dispose()` the
// PdfLocator (otherwise the locator pins page bundles in memory).
export function createZoteroAgentTools(
  options: ToolFactoryOptions,
): AgentTool[] {
  return createZoteroAgentToolSession(options).tools;
}

export function createZoteroAgentToolSession(
  options: ToolFactoryOptions,
): ZoteroAgentToolSession {
  const policy = options.policy ?? DEFAULT_CONTEXT_POLICY;
  const highlightSession = createFullTextHighlightState(options);
  const tools: AgentTool[] = [
    {
      name: "zotero_get_current_item",
      description:
        "Read metadata for the Zotero item currently selected or opened by the user. Use this before answering when title, authors, year, abstract, or tags are needed.",
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult("No Zotero item is currently selected.");
        const metadata = await options.source.getItem(itemID);
        if (!metadata)
          return errorResult("No Zotero item metadata is available.");
        return {
          output: formatMetadata(metadata),
          summary: "读取当前条目题录",
          context: { planMode: "metadata_only" },
        };
      },
    },
    {
      name: "zotero_get_annotations",
      description:
        "Read Zotero PDF annotations for the current item, including highlights, comments, page labels, colors, and order. Use when the user asks about their highlights, notes, annotations, or reading marks.",
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult("No Zotero item is currently selected.");
        const annotations =
          (await options.source.getAnnotations?.(itemID)) ?? [];
        const limited = annotations.slice(0, policy.maxAnnotations);
        return {
          output: limited.length
            ? `[Zotero annotations]\n${formatAnnotations(limited)}`
            : "No Zotero PDF annotations were found for the current item.",
          summary: `读取 Zotero 标注 ${limited.length} 条`,
          context: { planMode: "annotations", annotations: limited },
        };
      },
    },
    {
      name: "zotero_search_pdf",
      description:
        "Search the current PDF full-text cache using a query written by the model. Use this for targeted evidence, follow-up questions, definitions, figures, experiments, equations, claims, or local passages. The harness returns bounded passages with character ranges. For passages that will be written back as PDF highlights, use zotero_get_reader_pdf_text instead so the copied text matches the Reader text layer.",
      parameters: objectSchema(
        {
          query: stringSchema("Search query for the current PDF full text."),
          topK: numberSchema(
            "Maximum passages to return. The harness clamps this to policy limits.",
          ),
        },
        ["query"],
      ),
      execute: async (args) => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult("No Zotero item is currently selected.");
        const parsed = objectArgs(args);
        const query = stringArg(parsed, "query");
        if (!query)
          return errorResult("zotero_search_pdf requires a non-empty query.");
        const pdfText = await getToolPdfText(options, itemID);
        if (!pdfText) return errorResult(readablePdfTextError());
        const topK = numberArg(parsed, "topK") ?? policy.searchCandidateCount;
        const passages = searchPdfPassages(pdfText, query, topK, policy);
        return {
          output: passages.length
            ? `[Retrieved PDF passages]\n${formatRetrievedPassages(passages)}`
            : `No PDF passages matched the model-provided query: ${query}`,
          summary: `检索 PDF: ${query}，返回 ${passages.length} 段`,
          context: {
            planMode: "search_pdf",
            query,
            candidatePassageCount: passages.length,
            selectedPassageNumbers: passages.map((_, index) => index + 1),
            passageSelectorSource: "model",
            retrievedPassages: passages,
          },
        };
      },
    },
    {
      name: "zotero_read_pdf_range",
      description:
        "Read an exact character range from the current PDF full-text cache. Use only when a previous cache-based tool result or ledger gives useful start/end ranges. The harness validates and caps the range. For passages that will be written back as PDF highlights, use zotero_get_reader_pdf_text instead.",
      parameters: objectSchema(
        {
          start: numberSchema(
            "Zero-based start character offset from a previous tool result.",
          ),
          end: numberSchema(
            "End character offset from a previous tool result.",
          ),
        },
        ["start", "end"],
      ),
      execute: async (args) => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult("No Zotero item is currently selected.");
        const parsed = objectArgs(args);
        const start = numberArg(parsed, "start");
        const end = numberArg(parsed, "end");
        if (start == null || end == null) {
          return errorResult(
            "zotero_read_pdf_range requires numeric start and end.",
          );
        }
        const pdfText = await getToolPdfText(options, itemID);
        if (!pdfText) return errorResult(readablePdfTextError());
        const range = extractPdfRange(pdfText, start, end, policy);
        if (!range)
          return errorResult("The requested PDF range is invalid or empty.");
        return {
          output: `[PDF range ${range.start}-${range.end}]\n${range.text}`,
          summary: `读取 PDF 范围 ${range.start}-${range.end}`,
          context: {
            planMode: "pdf_range",
            rangeStart: range.start,
            rangeEnd: range.end,
            retrievedPassages: [range],
          },
        };
      },
    },
    {
      name: "zotero_get_full_pdf",
      description:
        "Read the current PDF full-text cache for whole-paper synthesis. Use when the user asks to summarize, review, compare, or analyze the entire paper and smaller tools are insufficient. Do not copy highlight text from this tool for zotero_annotate_passage; use zotero_get_reader_pdf_text for PDF write workflows. The harness applies a full-PDF budget cap.",
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null)
          return errorResult("No Zotero item is currently selected.");
        const pdfText = await getToolPdfText(options, itemID);
        if (!pdfText) return errorResult(readablePdfTextError());
        const text = truncateByTokenBudget(pdfText, policy.fullPdfTokenBudget);
        const truncated = text.length < pdfText.length;
        return {
          output: [
            "[Paper full text]",
            `Chars: ${text.length} / ${pdfText.length}`,
            `Truncated: ${truncated ? "yes" : "no"}`,
            `Range: 0-${text.length}`,
            "",
            text,
          ].join("\n"),
          summary: `读取 PDF 全文 ${text.length}/${pdfText.length} 字`,
          context: {
            planMode: "full_pdf",
            fullTextChars: text.length,
            fullTextTotalChars: pdfText.length,
            fullTextTruncated: truncated,
            rangeStart: 0,
            rangeEnd: text.length,
          },
        };
      },
    },
    createGetReaderPdfTextTool(policy, highlightSession),
    {
      name: "zotero_add_annotation_to_selection",
      description:
        "Create a Zotero PDF annotation/comment on the user's current selected PDF text. Use only when the user explicitly asks to add, write, or save an annotation/comment/note to the selected passage. This is a write tool and requires approval or YOLO mode.",
      requiresApproval: true,
      parameters: objectSchema(
        {
          comment: stringSchema(
            "Annotation comment to save on the selected PDF text.",
          ),
          color: stringSchema(
            "Optional Zotero annotation color, such as #ffd400. If omitted, the selection/default color is used.",
          ),
          type: stringSchema(
            "Optional annotation type. Supported values are highlight or underline. If omitted, highlight is used.",
          ),
        },
        ["comment"],
      ),
      execute: async (args) => {
        const draft = options.selectionAnnotation?.();
        if (!draft) {
          return errorResult(
            "No live PDF text selection is available for creating an annotation. Select text in the Zotero PDF reader first.",
          );
        }
        const parsed = objectArgs(args);
        const comment = truncate(
          stringArg(parsed, "comment"),
          policy.maxAnnotationCommentChars,
        );
        if (!comment) {
          return errorResult(
            "zotero_add_annotation_to_selection requires a non-empty comment.",
          );
        }
        const saved = await saveSelectionAnnotation(draft, {
          comment,
          color: stringArg(parsed, "color") || undefined,
          type: annotationTypeArg(parsed),
        });
        return {
          output: [
            "[Saved Zotero PDF annotation]",
            `Annotation item ID: ${saved.id}`,
            `Selected text: ${draft.text}`,
            `Comment: ${comment}`,
          ].join("\n"),
          summary: `新增 PDF 注释 ${comment.length} 字`,
          context: {
            planMode: "selected_text",
            selectedText: draft.text,
          },
        };
      },
    },
    createAnnotatePassageTool(policy, highlightSession),
  ];

  return { tools, dispose: highlightSession.dispose };
}

async function getToolPdfText(
  options: ToolFactoryOptions,
  itemID: number,
): Promise<string> {
  return options.source.getFullText(itemID);
}

function readablePdfTextError(): string {
  return "No readable PDF full-text cache is available for the current item.";
}

async function getReaderPdfText(
  session: FullTextHighlightState,
): Promise<string> {
  const locator = await session.getOrCreateLocator();
  return locator ? locator.getFullText() : "";
}

function readableReaderPdfTextError(session: FullTextHighlightState): string {
  return `No readable PDF.js text layer is available from the active Zotero Reader. ${session.locatorError()}`;
}

interface FullTextHighlightState {
  canWriteHighlight(): boolean;
  recordSavedHighlight(): void;
  getOrCreateLocator(): Promise<PdfLocator | null>;
  locatorError(): string;
  dispose(): void;
}

// Locator session: lazily builds one PdfLocator per tool session and
// memoizes it. INVARIANT: at most one in-flight locator init promise — the
// model often calls `zotero_get_reader_pdf_text` and `zotero_annotate_passage`
// in rapid succession, and we MUST NOT trigger PDF.js text-layer extraction
// twice in parallel (it produces inconsistent char offsets).
function createFullTextHighlightState(
  options: ToolFactoryOptions,
): FullTextHighlightState {
  let savedHighlights = 0;
  let locator: PdfLocator | null = null;
  let locatorPromise: Promise<PdfLocator | null> | null = null;
  let locatorError = "";

  return {
    canWriteHighlight() {
      const policy = options.policy ?? DEFAULT_CONTEXT_POLICY;
      return savedHighlights < policy.maxFullTextHighlights;
    },
    recordSavedHighlight() {
      savedHighlights += 1;
    },
    async getOrCreateLocator() {
      if (locator) return locator;
      if (!locatorPromise) {
        locatorPromise = (async () => {
          const reader = options.getActiveReader?.();
          if (!reader) {
            locatorError =
              "Please open the PDF in Zotero Reader and keep that tab active.";
            return null;
          }
          try {
            locator = await createPdfLocator(reader);
            return locator;
          } catch (err) {
            locatorError = err instanceof Error ? err.message : String(err);
            return null;
          }
        })();
      }
      return locatorPromise;
    },
    locatorError() {
      return locatorError;
    },
    dispose() {
      locator?.dispose();
      locator = null;
      locatorPromise = null;
    },
  };
}

function createGetReaderPdfTextTool(
  policy: ContextPolicy,
  session: FullTextHighlightState,
): AgentTool {
  return {
    name: "zotero_get_reader_pdf_text",
    description:
      "Read PDF text from the active Zotero Reader/PDF.js text layer. Use this when the user explicitly asks to write PDF highlights/annotations, because passages copied from this tool can be located by zotero_annotate_passage. Requires the PDF to be open in Zotero Reader. For ordinary summarization or non-writing analysis, use zotero_get_full_pdf instead. Optional start/end read an exact Reader-text range from a previous zotero_get_reader_pdf_text result.",
    parameters: objectSchema({
      start: numberSchema(
        "Optional zero-based start character offset from a previous Reader-text result.",
      ),
      end: numberSchema(
        "Optional end character offset from a previous Reader-text result.",
      ),
    }),
    execute: async (args) => {
      const pdfText = await getReaderPdfText(session);
      if (!pdfText) return errorResult(readableReaderPdfTextError(session));

      const parsed = objectArgs(args);
      const slice = readerTextSlice(pdfText, parsed, policy);
      if (!slice) {
        return errorResult(
          "zotero_get_reader_pdf_text requires both numeric start and end when either range field is provided, and the range must be valid.",
        );
      }
      const truncated = slice.end < pdfText.length;
      return {
        output: [
          "[Reader PDF text for annotation]",
          "Source: active Zotero Reader text layer",
          "Use with: zotero_annotate_passage",
          `Chars: ${slice.text.length} / ${pdfText.length}`,
          `Truncated: ${truncated ? "yes" : "no"}`,
          `Range: ${slice.start}-${slice.end}`,
          "",
          slice.text,
        ].join("\n"),
        summary: `读取 Reader PDF 文本 ${slice.text.length}/${pdfText.length} 字`,
        context: {
          planMode: "reader_pdf_text",
          fullTextChars: slice.text.length,
          fullTextTotalChars: pdfText.length,
          fullTextTruncated: truncated,
          rangeStart: slice.start,
          rangeEnd: slice.end,
        },
      };
    },
  };
}

function readerTextSlice(
  pdfText: string,
  args: Record<string, unknown>,
  policy: ContextPolicy,
): { start: number; end: number; text: string } | null {
  const startArg = numberArg(args, "start");
  const endArg = numberArg(args, "end");
  const hasStart = startArg != null;
  const hasEnd = endArg != null;
  if (hasStart !== hasEnd) return null;

  if (!hasStart && !hasEnd) {
    const end = Math.min(pdfText.length, policy.fullPdfTokenBudget * 4);
    return { start: 0, end, text: pdfText.slice(0, end) };
  }
  if (startArg == null || endArg == null) return null;

  const start = Math.floor(startArg);
  const requestedEnd = Math.floor(endArg);
  if (start !== startArg || requestedEnd !== endArg) return null;
  if (start < 0 || requestedEnd <= start || start >= pdfText.length)
    return null;

  const end = Math.min(
    requestedEnd,
    start + policy.maxRangeChars,
    pdfText.length,
  );
  return { start, end, text: pdfText.slice(start, end) };
}

function createAnnotatePassageTool(
  policy: ContextPolicy,
  session: FullTextHighlightState,
): AgentTool {
  return {
    name: "zotero_annotate_passage",
    description:
      "Create a Zotero PDF highlight annotation on a specific passage. Use only when the user explicitly asks to write highlights/annotations into the PDF, such as annotating the whole paper or highlighting key sentences. Before using this tool for full-text annotation, call zotero_get_current_item to read the abstract, then call zotero_get_reader_pdf_text and copy `text` verbatim from that Reader-text output. Do not copy highlight text from zotero_get_full_pdf, because that tool uses Zotero's full-text cache rather than the Reader text layer. For ordinary summaries, do not use this write tool. PDF modification requires approval or YOLO mode.",
    requiresApproval: true,
    parameters: objectSchema(
      {
        text: stringSchema(
          "Exact passage from the PDF (verbatim, no paraphrasing).",
        ),
        comment: stringSchema(
          "Reading note (≤ 80 chars Chinese), explaining why this passage is important.",
        ),
        color: stringSchema("Optional Zotero annotation color, e.g. #ffd400."),
      },
      ["text", "comment"],
    ),
    execute: async (args) => {
      const parsed = objectArgs(args);
      const text = stringArg(parsed, "text");
      const comment = truncate(
        stringArg(parsed, "comment"),
        policy.maxFullTextHighlightCommentChars,
      );
      if (!text)
        return errorResult(
          "zotero_annotate_passage requires a non-empty `text`.",
        );
      if (!comment)
        return errorResult(
          "zotero_annotate_passage requires a non-empty `comment`.",
        );
      // INVARIANT: per-turn highlight cap. We surface an *error* result so
      // the model gets clear feedback in its tool-output stream and pivots
      // to summarizing instead of looping until maxToolIterations blows.
      if (!session.canWriteHighlight()) {
        return errorResult(
          `Highlight limit reached (${policy.maxFullTextHighlights}). Stop creating annotations and summarize the saved highlights.`,
        );
      }

      const locator = await session.getOrCreateLocator();
      if (!locator) {
        return errorResult(
          `No Reader/PDF.js text layer is available for this item. ${session.locatorError()}`,
        );
      }

      const result = await locator.locate(text, {
        minConfidence: policy.minLocateConfidence,
      });
      if (!result) {
        return errorResult(
          `Passage not found in PDF (or low confidence): ${text.slice(0, 60)}...`,
        );
      }

      const Z = getZoteroAnnotationAPI();
      const attachment = await Z.Items.getAsync(locator.attachmentID);
      if (!attachment)
        return errorResult("PDF attachment is no longer available.");

      const key = Z.DataObjectUtilities.generateKey();
      const json = {
        id: key,
        key,
        type: "highlight",
        text: result.matchedText,
        comment,
        color: stringArg(parsed, "color") || Z.Annotations.DEFAULT_COLOR,
        pageLabel: result.pageLabel,
        sortIndex: result.sortIndex,
        position: { pageIndex: result.pageIndex, rects: result.rects },
      };
      const saved = await Z.Annotations.saveFromJSON(attachment, json);
      session.recordSavedHighlight();
      return {
        output: [
          `[Saved annotation #${saved.id}]`,
          `Page: ${result.pageLabel}`,
          `Confidence: ${result.confidence.toFixed(2)}`,
          `Text: ${result.matchedText.slice(0, 100)}`,
          `Comment: ${comment}`,
        ].join("\n"),
        summary: `p.${result.pageLabel} 高亮 +${comment.length}字`,
        context: { planMode: "annotation_write" },
      };
    },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): { [key: string]: unknown } {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): { [key: string]: unknown } {
  return { type: "string", description };
}

function numberSchema(description: string): { [key: string]: unknown } {
  return { type: "number", description };
}

function currentItemID(options: ToolFactoryOptions): number | null {
  return options.itemID;
}

function errorResult(output: string): ToolExecutionResult {
  return { output, summary: output };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function annotationTypeArg(
  args: Record<string, unknown>,
): "highlight" | "underline" | undefined {
  const value = stringArg(args, "type");
  if (value === "highlight" || value === "underline") return value;
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export async function saveSelectionAnnotation(
  draft: SelectionAnnotationDraft,
  patch: { comment: string; color?: string; type?: "highlight" | "underline" },
): Promise<{ id: number }> {
  const Z = getZoteroAnnotationAPI();
  const attachment = await Z.Items.getAsync(draft.attachmentID);
  if (!attachment)
    throw new Error("Selected PDF attachment is no longer available.");

  const base = draft.annotation;
  const key =
    stringValue(base.key) ||
    stringValue(base.id) ||
    Z.DataObjectUtilities.generateKey();
  const position = base.position;
  if (!position || typeof position !== "object") {
    throw new Error(
      "Selected PDF text does not include Zotero annotation position data.",
    );
  }

  const json = {
    ...base,
    id: key,
    key,
    type: patch.type ?? selectedAnnotationType(base),
    text: draft.text,
    comment: patch.comment,
    color:
      patch.color || stringValue(base.color) || Z.Annotations.DEFAULT_COLOR,
    pageLabel: stringValue(base.pageLabel),
    sortIndex: stringValue(base.sortIndex),
    position,
  };

  const item = await Z.Annotations.saveFromJSON(attachment, json);
  return { id: item.id };
}

function selectedAnnotationType(
  base: Record<string, unknown>,
): "highlight" | "underline" {
  const type = stringValue(base.type);
  return type === "underline" ? "underline" : "highlight";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

interface ZoteroAnnotationItem {
  id: number;
}

interface ZoteroAnnotationAPI {
  Items: { getAsync(id: number): Promise<ZoteroAnnotationItem | null> };
  DataObjectUtilities: { generateKey(): string };
  Annotations: {
    DEFAULT_COLOR: string;
    saveFromJSON(
      attachment: ZoteroAnnotationItem,
      json: Record<string, unknown>,
      saveOptions?: Record<string, unknown>,
    ): Promise<ZoteroAnnotationItem>;
  };
}

function getZoteroAnnotationAPI(): ZoteroAnnotationAPI {
  return (globalThis as unknown as { Zotero: ZoteroAnnotationAPI }).Zotero;
}

function formatMetadata(item: ItemMetadata): string {
  const lines = [`Title: ${item.title}`];
  if (item.authors.length) lines.push(`Authors: ${item.authors.join(", ")}`);
  if (item.year) lines.push(`Year: ${item.year}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.abstract) lines.push(`Abstract: ${item.abstract}`);
  return lines.join("\n");
}

// Token-to-char heuristic shared with builder.ts: 1 token ≈ 4 chars.
// GOTCHA: this is a rough OAI/Anthropic English heuristic; CJK uses fewer
// chars per token, so this *over-budgets* tokens for Chinese papers (safe).
function truncateByTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  return text.length > charBudget ? text.slice(0, charBudget) : text;
}
