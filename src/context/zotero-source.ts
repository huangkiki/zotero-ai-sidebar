import type { ContextSource, ItemMetadata } from './builder';

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
  attachmentContentType?: string;
}

interface ZoteroGlobal {
  Items: { getAsync(id: number): Promise<ZoteroItem | null> };
  Fulltext: { getItemContent(id: number): Promise<{ content?: string } | null> };
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
    const attachmentItems = await Promise.all(
      parent.getAttachments().map((id) => Z.Items.getAsync(id)),
    );
    for (const att of attachmentItems) {
      if (att?.attachmentContentType === 'application/pdf') {
        const content = await Z.Fulltext.getItemContent(att.id);
        if (content?.content) return content.content;
      }
    }
    return '';
  },
};

function parseYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const m = date.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : undefined;
}
