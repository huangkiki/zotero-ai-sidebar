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
  const pdfText = await source.getFullText(itemID);
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
