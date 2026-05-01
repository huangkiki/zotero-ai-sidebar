import type { ContextSource, ItemMetadata } from './builder';
import { DEFAULT_CONTEXT_POLICY } from './policy';
import type { ItemAnnotation } from './types';

// Concrete `ContextSource` backed by Zotero's runtime APIs.
//
// The harness (agent-tools.ts) and the legacy buildContext path both go
// through this adapter so we can swap a fixture implementation in tests
// without touching tool code.
//
// Two recurring shapes you must understand to read this file:
// - The "current item" can be either a parent regular item OR a PDF
//   attachment item (the user may have selected the attachment directly
//   in the Zotero collection view). `isAttachment()` disambiguates.
// - Full text comes from Zotero's offline indexer cache (`Fulltext.
//   getItemCacheFile`), NOT from PDF.js. Reading is bounded by
//   `policy.fullTextCacheReadCharLimit` to avoid loading huge PDFs whole.
//
// REF: Zotero source `chrome/content/zotero/xpcom/data/item.js`,
//      `chrome/content/zotero/xpcom/fulltext.js`.

interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
}

interface ZoteroTag {
  tag: string;
}

interface ZoteroItem {
  id: number;
  getField(field: string): string;
  getCreators(): ZoteroCreator[];
  getTags(): ZoteroTag[];
  getAttachments(): number[];
  getAnnotations?(includeTrashed?: boolean): ZoteroItem[];
  isAttachment?(): boolean;
  attachmentContentType?: string;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  annotationColor?: string;
  annotationSortIndex?: number;
}

interface ZoteroGlobal {
  Items: { getAsync(id: number): Promise<ZoteroItem | null> };
  Fulltext: { getItemCacheFile(item: ZoteroItem): { path: string } };
  File: { getContentsAsync(path: string, charset?: string, maxLength?: number): Promise<string> };
}

function getZ(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}

export const zoteroContextSource: ContextSource = {
  async getItem(itemID) {
    const Z = getZ();
    const item = await Z.Items.getAsync(itemID);
    if (!item) return null;
    const meta: ItemMetadata = {
      title: item.getField('title') || '',
      authors: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(' ')),
      year: parseYear(item.getField('date')),
      abstract: item.getField('abstractNote') || undefined,
      tags: item.getTags().map((t) => t.tag),
    };
    return meta;
  },

  // Returns the Zotero indexer's cached plain text for the first PDF
  // attachment under `itemID`. INVARIANT: this is NOT the PDF.js text
  // layer — char offsets here will not align with `pdf-locator`'s offsets,
  // so do NOT use this output to drive coordinate-based highlights.
  async getFullText(itemID) {
    const Z = getZ();
    const parent = await Z.Items.getAsync(itemID);
    if (!parent) return '';

    const attachmentItems = parent.isAttachment?.()
      ? [parent]
      : await Promise.all(parent.getAttachments().map((id) => Z.Items.getAsync(id)));

    // WHY first-PDF-wins: papers commonly have one PDF + a few supplemental
    // PDFs; sending the first one matches user expectation. If we ever need
    // multi-PDF fan-out, that's a new tool, not a change here.
    for (const att of attachmentItems) {
      if (att?.attachmentContentType === 'application/pdf') {
        const content = await readFulltextCache(Z, att);
        if (content) return content;
      }
    }
    return '';
  },

  // INVARIANT: `getAnnotations(false)` excludes trashed annotations — we
  // don't want to surface deleted highlights to the model.
  // INVARIANT: filter requires text OR comment — empty annotations (e.g.
  // bare image highlights with no caption) are dropped to avoid noise.
  // Sorted by Zotero's native sortIndex so the model receives them in
  // reading order, which mirrors the Zotero annotations sidebar.
  async getAnnotations(itemID) {
    const Z = getZ();
    const attachments = await getPdfAttachments(Z, itemID);
    const annotations = attachments.flatMap((attachment) =>
      typeof attachment.getAnnotations === 'function'
        ? attachment.getAnnotations(false).map(annotationFromZoteroItem)
        : [],
    );
    return annotations
      .filter((annotation) => annotation.text || annotation.comment)
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  },
};

async function getPdfAttachments(
  Z: ZoteroGlobal,
  itemID: number,
): Promise<ZoteroItem[]> {
  const parent = await Z.Items.getAsync(itemID);
  if (!parent) return [];

  const attachmentItems = parent.isAttachment?.()
    ? [parent]
    : await Promise.all(parent.getAttachments().map((id) => Z.Items.getAsync(id)));

  return attachmentItems.filter(
    (att): att is ZoteroItem => att?.attachmentContentType === 'application/pdf',
  );
}

function annotationFromZoteroItem(item: ZoteroItem): ItemAnnotation {
  return {
    type: item.annotationType || 'annotation',
    text: item.annotationText || '',
    comment: item.annotationComment || undefined,
    pageLabel: item.annotationPageLabel || undefined,
    color: item.annotationColor || undefined,
    sortIndex: item.annotationSortIndex,
  };
}

// `getItemCacheFile` returns `{ path }` even when the cache file does not
// exist on disk; the read then throws with NS_ERROR_FILE_NOT_FOUND. We
// catch and return '' so callers can treat both "no PDF" and "no cache"
// uniformly. INVARIANT: `maxLength` here caps bytes read from disk — keeps
// 50MB scientific PDFs from pinning memory in JS land.
async function readFulltextCache(Z: ZoteroGlobal, item: ZoteroItem): Promise<string> {
  try {
    const cachePath = Z.Fulltext.getItemCacheFile(item).path;
    return await Z.File.getContentsAsync(
      cachePath,
      'utf-8',
      DEFAULT_CONTEXT_POLICY.fullTextCacheReadCharLimit,
    );
  } catch {
    return '';
  }
}

// Zotero stores `date` as a free-form string (e.g. "2023", "2023-04-15",
// "April 2023", "Spring 2023"). Scan for the first 4-digit year in
// [1900, 2099] — broad enough for any modern paper, narrow enough that
// random 4-digit numbers in titles won't match.
function parseYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  for (let index = 0; index <= date.length - 4; index++) {
    const candidate = date.slice(index, index + 4);
    if (!isFourDigitYear(candidate)) continue;
    const year = Number(candidate);
    if (year >= 1900 && year <= 2099) return year;
  }
  return undefined;
}

function isFourDigitYear(value: string): boolean {
  if (value.length !== 4) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}
