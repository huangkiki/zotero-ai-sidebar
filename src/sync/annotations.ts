// PDF annotation export/import for cloud sync.
//
// Annotations are children of PDF attachment items, which are themselves
// children of regular paper items. To round-trip across machines we keep
// the portable triple (libraryType, groupID?, parentItemKey, annotationKey)
// — same shape as chat-history's portable thread, just one level deeper.
//
// SCOPE LIMIT v1: image annotations are skipped on export. The image data
// is stored as a child attachment of the annotation item with binary PNG
// payload, which is significant code for a less-common annotation type.
// Highlight, underline, note, and ink annotations cover almost all real
// use; image support can land later if asked.
//
// MERGE STRATEGY: per-annotation last-write-wins by `dateModified`. Same
// model as chat threads. Deletions are NOT propagated (would need a
// tombstone log) — known v1 limit, surfaced in the pull-result message.

export type AnnotationType = 'highlight' | 'underline' | 'note' | 'ink';

export interface PortableAnnotation {
  libraryType: 'user' | 'group';
  groupID?: number;
  parentItemKey: string; // attachment (PDF) key
  parentParentItemKey?: string; // paper item key — diagnostics only
  key: string;
  dateModified: string;
  type: AnnotationType;
  json: Record<string, unknown>; // payload for Zotero.Annotations.saveFromJSON
  tags: string[];
}

export interface ImportAnnotationsResult {
  imported: number;
  unchanged: number;
  unresolved: number; // parent attachment not found locally
  skipped: number; // unsupported type, malformed payload, etc.
}

interface ZoteroAnnotationLike {
  key: string;
  dateModified: string;
  parentID: number;
  parentItem?: { key?: string; parentItem?: { key?: string } };
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationSortIndex?: string;
  annotationPageLabel?: string;
  annotationPosition?: string | Record<string, unknown>;
  annotationAuthorName?: string;
  getTags?: () => Array<{ tag: string }>;
}

interface ZoteroAttachmentLike {
  key?: string;
  libraryID?: number;
  parentItem?: { key?: string };
  isAttachment?: () => boolean;
  isPDFAttachment?: () => boolean;
  attachmentContentType?: string;
  getAnnotations?: () => ZoteroAnnotationLike[];
}

interface ZoteroLibraryLike {
  libraryType?: 'user' | 'group';
  groupID?: number;
}

interface ZoteroItemsAPI {
  getAll(
    libraryID: number,
  ): ZoteroAttachmentLike[] | Promise<ZoteroAttachmentLike[]>;
  getAsync(id: number): Promise<ZoteroAttachmentLike | null>;
  getByLibraryAndKey(
    libraryID: number,
    key: string,
  ): ZoteroAttachmentLike | false;
}

interface ZoteroLibrariesAPI {
  get(libraryID: number): ZoteroLibraryLike | undefined;
  userLibraryID: number;
}

interface ZoteroGroupsAPI {
  getAll(): Array<{ libraryID: number; id?: number }>;
  get(groupID: number): { libraryID?: number } | false | undefined;
}

interface ZoteroAnnotationsAPI {
  saveFromJSON(
    attachment: ZoteroAttachmentLike,
    json: Record<string, unknown>,
    saveOptions?: Record<string, unknown>,
  ): Promise<{ id: number; key: string }>;
}

interface ZoteroGlobal {
  Items: ZoteroItemsAPI;
  Libraries: ZoteroLibrariesAPI;
  Groups: ZoteroGroupsAPI;
  Annotations: ZoteroAnnotationsAPI;
}

const SUPPORTED_TYPES = new Set<AnnotationType>([
  'highlight',
  'underline',
  'note',
  'ink',
]);

export async function exportAllAnnotations(): Promise<PortableAnnotation[]> {
  const Zotero = getZotero();
  const result: PortableAnnotation[] = [];
  for (const { libraryID, libraryType, groupID } of enumerateLibraries(Zotero)) {
    for (const attachment of await pdfAttachmentsIn(Zotero, libraryID)) {
      const parentKey = attachment.key;
      if (typeof parentKey !== 'string' || parentKey.length === 0) continue;
      const parentParentKey = attachment.parentItem?.key;
      const annotations = attachment.getAnnotations?.() ?? [];
      for (const annotation of annotations) {
        const portable = portableFromAnnotation(annotation, {
          libraryType,
          groupID,
          parentItemKey: parentKey,
          parentParentItemKey: parentParentKey,
        });
        if (portable) result.push(portable);
      }
    }
  }
  return result;
}

export async function importAllAnnotations(
  portable: PortableAnnotation[],
): Promise<ImportAnnotationsResult> {
  const Zotero = getZotero();
  let imported = 0;
  let unchanged = 0;
  let unresolved = 0;
  let skipped = 0;

  for (const candidate of portable) {
    if (!SUPPORTED_TYPES.has(candidate.type)) {
      skipped += 1;
      continue;
    }
    const libraryID = resolveLibraryID(Zotero, candidate);
    if (libraryID == null) {
      unresolved += 1;
      continue;
    }
    const attachment = Zotero.Items.getByLibraryAndKey(
      libraryID,
      candidate.parentItemKey,
    );
    if (!attachment) {
      unresolved += 1;
      continue;
    }
    // Existing annotation lookup: walk the attachment's annotations and
    // match by key. WHY not Zotero.Items.getByLibraryAndKey: annotation
    // keys live in the SAME library as the attachment but a generic
    // lookup may not narrow to "annotation child of this attachment".
    // The attachment-scoped walk is O(n) in n=children-of-this-PDF, which
    // is small and avoids any cross-library ambiguity.
    const existing = (attachment.getAnnotations?.() ?? []).find(
      (a) => a.key === candidate.key,
    );
    if (existing && existing.dateModified >= candidate.dateModified) {
      unchanged += 1;
      continue;
    }
    try {
      await Zotero.Annotations.saveFromJSON(attachment, {
        ...candidate.json,
        key: candidate.key,
        tags: candidate.tags.map((tag) => ({ tag })),
      });
      imported += 1;
    } catch {
      // saveFromJSON throws on malformed JSON or position validation
      // failures; treat as a per-annotation skip rather than aborting the
      // whole import. The pull-result message reports the count.
      skipped += 1;
    }
  }
  return { imported, unchanged, unresolved, skipped };
}

function portableFromAnnotation(
  annotation: ZoteroAnnotationLike,
  parents: {
    libraryType: 'user' | 'group';
    groupID?: number;
    parentItemKey: string;
    parentParentItemKey?: string;
  },
): PortableAnnotation | null {
  const type = annotation.annotationType;
  if (!type || !SUPPORTED_TYPES.has(type as AnnotationType)) return null;
  const key = annotation.key;
  const dateModified = annotation.dateModified;
  if (!key || !dateModified) return null;

  // Position is stored as a JSON string by Zotero (varies per type). We
  // round-trip it as-is — saveFromJSON accepts the string form, and we
  // never need to introspect it on the import side.
  const position = annotation.annotationPosition ?? null;
  const json: Record<string, unknown> = {
    type,
    color: annotation.annotationColor ?? '',
    pageLabel: annotation.annotationPageLabel ?? '',
    sortIndex: annotation.annotationSortIndex ?? '',
    position,
  };
  // Optional fields — only include when set, to keep the snapshot tight.
  if (annotation.annotationText) json.text = annotation.annotationText;
  if (annotation.annotationComment) json.comment = annotation.annotationComment;
  if (annotation.annotationAuthorName) {
    json.authorName = annotation.annotationAuthorName;
  }

  const tags = (annotation.getTags?.() ?? [])
    .map((t) => t.tag)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  const portable: PortableAnnotation = {
    libraryType: parents.libraryType,
    parentItemKey: parents.parentItemKey,
    key,
    dateModified,
    type: type as AnnotationType,
    json,
    tags,
  };
  if (parents.groupID !== undefined) portable.groupID = parents.groupID;
  if (parents.parentParentItemKey) {
    portable.parentParentItemKey = parents.parentParentItemKey;
  }
  return portable;
}

function* enumerateLibraries(Zotero: ZoteroGlobal): Iterable<{
  libraryID: number;
  libraryType: 'user' | 'group';
  groupID?: number;
}> {
  yield { libraryID: Zotero.Libraries.userLibraryID, libraryType: 'user' };
  for (const group of Zotero.Groups.getAll() ?? []) {
    if (typeof group.libraryID !== 'number' || typeof group.id !== 'number') {
      continue;
    }
    yield {
      libraryID: group.libraryID,
      libraryType: 'group',
      groupID: group.id,
    };
  }
}

function pdfAttachmentsIn(
  Zotero: ZoteroGlobal,
  libraryID: number,
): Promise<ZoteroAttachmentLike[]> {
  return Promise.resolve(Zotero.Items.getAll(libraryID)).then((items) => {
    if (!Array.isArray(items)) return [];
    return items.filter((item) => {
      if (item.isPDFAttachment?.()) return true;
      return (
        item.isAttachment?.() === true &&
        item.attachmentContentType === 'application/pdf'
      );
    });
  });
}

function resolveLibraryID(
  Zotero: ZoteroGlobal,
  candidate: PortableAnnotation,
): number | null {
  if (candidate.libraryType === 'group') {
    if (typeof candidate.groupID !== 'number') return null;
    const group = Zotero.Groups.get(candidate.groupID);
    if (!group || typeof group.libraryID !== 'number') return null;
    return group.libraryID;
  }
  const userID = Zotero.Libraries.userLibraryID;
  return typeof userID === 'number' ? userID : null;
}

function getZotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}
