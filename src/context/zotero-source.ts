import type { ContextSource, ItemMetadata } from './builder';
import { DEFAULT_CONTEXT_POLICY } from './policy';
import type { ItemAnnotation } from './types';

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

  async getFullText(itemID) {
    const Z = getZ();
    const parent = await Z.Items.getAsync(itemID);
    if (!parent) return '';

    const attachmentItems = parent.isAttachment?.()
      ? [parent]
      : await Promise.all(parent.getAttachments().map((id) => Z.Items.getAsync(id)));

    for (const att of attachmentItems) {
      if (att?.attachmentContentType === 'application/pdf') {
        const content = await readFulltextCache(Z, att);
        if (content) return content;
      }
    }
    return '';
  },

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
