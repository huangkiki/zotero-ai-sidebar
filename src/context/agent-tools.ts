import type { AgentTool, ToolExecutionResult } from '../providers/types';
import type { ContextSource, ItemMetadata } from './builder';
import { formatAnnotations, formatRetrievedPassages } from './message-format';
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from './policy';
import { extractPdfRange, searchPdfPassages } from './retrieval';

interface ToolFactoryOptions {
  source: ContextSource;
  itemID: number | null;
  policy?: ContextPolicy;
  selectionAnnotation?: () => SelectionAnnotationDraft | null;
}

export interface SelectionAnnotationDraft {
  text: string;
  attachmentID: number;
  annotation: Record<string, unknown>;
}

export function createZoteroAgentTools(options: ToolFactoryOptions): AgentTool[] {
  const policy = options.policy ?? DEFAULT_CONTEXT_POLICY;
  return [
    {
      name: 'zotero_get_current_item',
      description: 'Read metadata for the Zotero item currently selected or opened by the user. Use this before answering when title, authors, year, abstract, or tags are needed.',
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null) return errorResult('No Zotero item is currently selected.');
        const metadata = await options.source.getItem(itemID);
        if (!metadata) return errorResult('No Zotero item metadata is available.');
        return {
          output: formatMetadata(metadata),
          summary: '读取当前条目题录',
          context: { planMode: 'metadata_only' },
        };
      },
    },
    {
      name: 'zotero_get_annotations',
      description: 'Read Zotero PDF annotations for the current item, including highlights, comments, page labels, colors, and order. Use when the user asks about their highlights, notes, annotations, or reading marks.',
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null) return errorResult('No Zotero item is currently selected.');
        const annotations = await options.source.getAnnotations?.(itemID) ?? [];
        const limited = annotations.slice(0, policy.maxAnnotations);
        return {
          output: limited.length
            ? `[Zotero annotations]\n${formatAnnotations(limited)}`
            : 'No Zotero PDF annotations were found for the current item.',
          summary: `读取 Zotero 标注 ${limited.length} 条`,
          context: { planMode: 'annotations', annotations: limited },
        };
      },
    },
    {
      name: 'zotero_search_pdf',
      description: 'Search the current PDF full text using a query written by the model. Use this for targeted evidence, follow-up questions, definitions, figures, experiments, equations, claims, or local passages. The harness returns bounded passages with character ranges.',
      parameters: objectSchema({
        query: stringSchema('Search query for the current PDF full text.'),
        topK: numberSchema('Maximum passages to return. The harness clamps this to policy limits.'),
      }, ['query']),
      execute: async (args) => {
        const itemID = currentItemID(options);
        if (itemID == null) return errorResult('No Zotero item is currently selected.');
        const parsed = objectArgs(args);
        const query = stringArg(parsed, 'query');
        if (!query) return errorResult('zotero_search_pdf requires a non-empty query.');
        const pdfText = await options.source.getFullText(itemID);
        if (!pdfText) return errorResult('No readable PDF full-text cache is available for the current item.');
        const topK = numberArg(parsed, 'topK') ?? policy.searchCandidateCount;
        const passages = searchPdfPassages(pdfText, query, topK, policy);
        return {
          output: passages.length
            ? `[Retrieved PDF passages]\n${formatRetrievedPassages(passages)}`
            : `No PDF passages matched the model-provided query: ${query}`,
          summary: `检索 PDF: ${query}，返回 ${passages.length} 段`,
          context: {
            planMode: 'search_pdf',
            query,
            candidatePassageCount: passages.length,
            selectedPassageNumbers: passages.map((_, index) => index + 1),
            passageSelectorSource: 'model',
            retrievedPassages: passages,
          },
        };
      },
    },
    {
      name: 'zotero_read_pdf_range',
      description: 'Read an exact character range from the current PDF full text. Use only when a previous tool result or ledger gives useful start/end ranges. The harness validates and caps the range.',
      parameters: objectSchema({
        start: numberSchema('Zero-based start character offset from a previous tool result.'),
        end: numberSchema('End character offset from a previous tool result.'),
      }, ['start', 'end']),
      execute: async (args) => {
        const itemID = currentItemID(options);
        if (itemID == null) return errorResult('No Zotero item is currently selected.');
        const parsed = objectArgs(args);
        const start = numberArg(parsed, 'start');
        const end = numberArg(parsed, 'end');
        if (start == null || end == null) {
          return errorResult('zotero_read_pdf_range requires numeric start and end.');
        }
        const pdfText = await options.source.getFullText(itemID);
        if (!pdfText) return errorResult('No readable PDF full-text cache is available for the current item.');
        const range = extractPdfRange(pdfText, start, end, policy);
        if (!range) return errorResult('The requested PDF range is invalid or empty.');
        return {
          output: `[PDF range ${range.start}-${range.end}]\n${range.text}`,
          summary: `读取 PDF 范围 ${range.start}-${range.end}`,
          context: {
            planMode: 'pdf_range',
            rangeStart: range.start,
            rangeEnd: range.end,
            retrievedPassages: [range],
          },
        };
      },
    },
    {
      name: 'zotero_get_full_pdf',
      description: 'Read the current PDF full text for whole-paper synthesis. Use when the user asks to summarize, review, compare, or analyze the entire paper and smaller tools are insufficient. The harness applies a full-PDF budget cap.',
      parameters: objectSchema({}),
      execute: async () => {
        const itemID = currentItemID(options);
        if (itemID == null) return errorResult('No Zotero item is currently selected.');
        const pdfText = await options.source.getFullText(itemID);
        if (!pdfText) return errorResult('No readable PDF full-text cache is available for the current item.');
        const text = truncateByTokenBudget(pdfText, policy.fullPdfTokenBudget);
        return {
          output: `[Paper full text]\n${text}`,
          summary: `读取 PDF 全文 ${text.length} 字`,
          context: { planMode: 'full_pdf', fullTextChars: text.length },
        };
      },
    },
    {
      name: 'zotero_add_annotation_to_selection',
      description: 'Create a Zotero PDF annotation/comment on the user\'s current selected PDF text. Use only when the user explicitly asks to add, write, or save an annotation/comment/note to the selected passage. This is a write tool and requires approval or YOLO mode.',
      requiresApproval: true,
      parameters: objectSchema({
        comment: stringSchema('Annotation comment to save on the selected PDF text.'),
        color: stringSchema('Optional Zotero annotation color, such as #ffd400. If omitted, the selection/default color is used.'),
        type: stringSchema('Optional annotation type. Supported values are highlight or underline. If omitted, highlight is used.'),
      }, ['comment']),
      execute: async (args) => {
        const draft = options.selectionAnnotation?.();
        if (!draft) {
          return errorResult('No live PDF text selection is available for creating an annotation. Select text in the Zotero PDF reader first.');
        }
        const parsed = objectArgs(args);
        const comment = truncate(stringArg(parsed, 'comment'), policy.maxAnnotationCommentChars);
        if (!comment) {
          return errorResult('zotero_add_annotation_to_selection requires a non-empty comment.');
        }
        const saved = await saveSelectionAnnotation(draft, {
          comment,
          color: stringArg(parsed, 'color') || undefined,
          type: annotationTypeArg(parsed),
        });
        return {
          output: [
            '[Saved Zotero PDF annotation]',
            `Annotation item ID: ${saved.id}`,
            `Selected text: ${draft.text}`,
            `Comment: ${comment}`,
          ].join('\n'),
          summary: `新增 PDF 注释 ${comment.length} 字`,
          context: {
            planMode: 'selected_text',
            selectedText: draft.text,
          },
        };
      },
    },
  ];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): { [key: string]: unknown } {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): { [key: string]: unknown } {
  return { type: 'string', description };
}

function numberSchema(description: string): { [key: string]: unknown } {
  return { type: 'number', description };
}

function currentItemID(options: ToolFactoryOptions): number | null {
  return options.itemID;
}

function errorResult(output: string): ToolExecutionResult {
  return { output, summary: output };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function annotationTypeArg(args: Record<string, unknown>): 'highlight' | 'underline' | undefined {
  const value = stringArg(args, 'type');
  if (value === 'highlight' || value === 'underline') return value;
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function saveSelectionAnnotation(
  draft: SelectionAnnotationDraft,
  patch: { comment: string; color?: string; type?: 'highlight' | 'underline' },
): Promise<{ id: number }> {
  const Z = getZoteroAnnotationAPI();
  const attachment = await Z.Items.getAsync(draft.attachmentID);
  if (!attachment) throw new Error('Selected PDF attachment is no longer available.');

  const base = draft.annotation;
  const key = stringValue(base.key) || stringValue(base.id) || Z.DataObjectUtilities.generateKey();
  const position = base.position;
  if (!position || typeof position !== 'object') {
    throw new Error('Selected PDF text does not include Zotero annotation position data.');
  }

  const json = {
    ...base,
    id: key,
    key,
    type: patch.type ?? selectedAnnotationType(base),
    text: draft.text,
    comment: patch.comment,
    color: patch.color || stringValue(base.color) || Z.Annotations.DEFAULT_COLOR,
    pageLabel: stringValue(base.pageLabel),
    sortIndex: stringValue(base.sortIndex),
    position,
  };

  const item = await Z.Annotations.saveFromJSON(attachment, json);
  return { id: item.id };
}

function selectedAnnotationType(base: Record<string, unknown>): 'highlight' | 'underline' {
  const type = stringValue(base.type);
  return type === 'underline' ? 'underline' : 'highlight';
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
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
  if (item.authors.length) lines.push(`Authors: ${item.authors.join(', ')}`);
  if (item.year) lines.push(`Year: ${item.year}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  if (item.abstract) lines.push(`Abstract: ${item.abstract}`);
  return lines.join('\n');
}

function truncateByTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  return text.length > charBudget ? text.slice(0, charBudget) : text;
}
