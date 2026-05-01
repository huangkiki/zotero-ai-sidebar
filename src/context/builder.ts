import type { ItemAnnotation } from './types';

// Legacy context builder.
//
// In production today, `sidebar.ts` calls `buildContext(..., 0)` — the
// `pdfTokenBudget=0` short-circuits the PDF-text path so this function
// effectively returns just (system prompt + metadata). The PDF-text branch
// remains exercised by:
//   - tests/context/builder.test.ts (regression coverage)
//   - the React UI tree under src/ui/ (not currently mounted in the Zotero
//     pane — see CLAUDE.md "Native DOM sidebar code lives mainly in
//     src/modules/sidebar.ts").
//
// INVARIANT: PDF text fetched at PROMPT-BUILD time is the legacy path and
// has no place in the agent loop. The model fetches PDF text on demand via
// `agent-tools.ts` (zotero_get_full_pdf / zotero_search_pdf / zotero_read_pdf_range)
// so it can decide what's worth its context budget.

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
  getAnnotations?(itemID: number): Promise<ItemAnnotation[]>;
}

export interface BuiltContext {
  systemPrompt: string;
  pdfText: string | null;
}

const SYSTEM_BASE =
  'You are a research assistant helping the user understand academic papers. ' +
  'Cite the paper when answering questions about its content. Be precise and concise.';

export async function buildContext(
  source: ContextSource,
  itemID: number | null,
  pdfTokenBudget: number,
): Promise<BuiltContext> {
  if (itemID == null) return { systemPrompt: SYSTEM_BASE, pdfText: null };

  const item = await source.getItem(itemID);
  if (!item) return { systemPrompt: SYSTEM_BASE, pdfText: null };

  const meta = formatMetadata(item);
  const pdfText = pdfTokenBudget > 0 ? await source.getFullText(itemID) : '';
  const truncated = truncate(pdfText, pdfTokenBudget);

  return {
    systemPrompt: `${SYSTEM_BASE}\n\nThe user is currently viewing this paper:\n${meta}`,
    pdfText: truncated || null,
  };
}

function formatMetadata(item: ItemMetadata): string {
  const lines: string[] = [`Title: ${item.title}`];
  if (item.authors.length) lines.push(`Authors: ${item.authors.join(', ')}`);
  if (item.year) lines.push(`Year: ${item.year}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  if (item.abstract) lines.push(`Abstract: ${item.abstract}`);
  return lines.join('\n');
}

function truncate(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * 4;
  return text.length > charBudget ? text.slice(0, charBudget) : text;
}
