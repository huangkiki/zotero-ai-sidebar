import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportAllAnnotations,
  importAllAnnotations,
  type PortableAnnotation,
} from '../../src/sync/annotations';

interface MockAnnotation {
  key: string;
  dateModified: string;
  parentID: number;
  parentItem?: { key?: string; parentItem?: { key?: string } };
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  annotationPosition?: string;
  getTags?: () => Array<{ tag: string }>;
}

interface MockAttachment {
  key: string;
  libraryID: number;
  parentItem?: { key?: string };
  attachmentContentType?: string;
  isPDFAttachment?: () => boolean;
  isAttachment?: () => boolean;
  getAnnotations?: () => MockAnnotation[];
}

let savedJsonCalls: Array<{ attachmentKey: string; json: Record<string, unknown> }>;
let storedAnnotations: Map<string, MockAnnotation[]>; // attachmentKey → annotations

function makeAnnotation(overrides: Partial<MockAnnotation> = {}): MockAnnotation {
  return {
    key: 'ANN00001',
    dateModified: '2026-05-02T10:00:00Z',
    parentID: 1,
    parentItem: { key: 'PDF12345', parentItem: { key: 'PAPER001' } },
    annotationType: 'highlight',
    annotationText: 'an important sentence',
    annotationComment: 'why it matters',
    annotationColor: '#ffd400',
    annotationPageLabel: '7',
    annotationSortIndex: '00007|000123|00000',
    annotationPosition: '{"pageIndex":6,"rects":[[0,0,10,10]]}',
    getTags: () => [{ tag: 'core' }],
    ...overrides,
  };
}

beforeEach(() => {
  savedJsonCalls = [];
  storedAnnotations = new Map([
    [
      'PDF12345',
      [
        makeAnnotation(),
        makeAnnotation({
          key: 'ANN00002',
          annotationText: 'second highlight',
          annotationSortIndex: '00007|000200|00000',
          dateModified: '2026-05-02T11:00:00Z',
        }),
      ],
    ],
  ]);

  const attachmentByKey: Record<string, MockAttachment> = {
    PDF12345: {
      key: 'PDF12345',
      libraryID: 1,
      parentItem: { key: 'PAPER001' },
      attachmentContentType: 'application/pdf',
      isPDFAttachment: () => true,
      isAttachment: () => true,
      getAnnotations: () => storedAnnotations.get('PDF12345') ?? [],
    },
  };

  vi.stubGlobal('Zotero', {
    Items: {
      getAll: (libraryID: number) =>
        libraryID === 1 ? Object.values(attachmentByKey) : [],
      getAsync: async (id: number) =>
        id === 1 ? attachmentByKey.PDF12345 : null,
      getByLibraryAndKey: (libraryID: number, key: string) =>
        libraryID === 1 ? (attachmentByKey[key] ?? false) : false,
    },
    Libraries: {
      userLibraryID: 1,
      get: (libraryID: number) =>
        libraryID === 1 ? { libraryType: 'user', id: 1 } : undefined,
    },
    Groups: {
      getAll: () => [],
      get: () => false,
    },
    Annotations: {
      saveFromJSON: async (
        attachment: MockAttachment,
        json: Record<string, unknown>,
      ) => {
        savedJsonCalls.push({ attachmentKey: attachment.key, json });
        // Reflect into the in-memory store so subsequent imports see the
        // upsert (lets us verify last-write-wins idempotency).
        const list = storedAnnotations.get(attachment.key) ?? [];
        const incomingKey = String(json.key);
        const next = list.filter((a) => a.key !== incomingKey);
        next.push(
          makeAnnotation({
            key: incomingKey,
            dateModified: String(json.dateModified ?? new Date().toISOString()),
            annotationText: typeof json.text === 'string' ? json.text : '',
            annotationComment:
              typeof json.comment === 'string' ? json.comment : '',
          }),
        );
        storedAnnotations.set(attachment.key, next);
        return { id: list.length + 1, key: incomingKey };
      },
    },
  });
});

describe('annotation export/import', () => {
  it('exports highlights from the user library with portable parent keys', async () => {
    const exported = await exportAllAnnotations();
    expect(exported).toHaveLength(2);
    expect(exported[0]).toMatchObject({
      libraryType: 'user',
      parentItemKey: 'PDF12345',
      parentParentItemKey: 'PAPER001',
      key: 'ANN00001',
      type: 'highlight',
    });
    expect(exported[0].json.text).toBe('an important sentence');
    expect(exported[0].tags).toEqual(['core']);
  });

  it('awaits Zotero.Items.getAll before filtering PDF attachments', async () => {
    const zotero = (globalThis as unknown as {
      Zotero: {
        Items: {
          getAll: (
            libraryID: number,
          ) => MockAttachment[] | Promise<MockAttachment[]>;
        };
      };
    }).Zotero;
    const getAll = zotero.Items.getAll;
    zotero.Items.getAll = async (libraryID: number) => getAll(libraryID);

    const exported = await exportAllAnnotations();

    expect(exported).toHaveLength(2);
  });

  it('skips unsupported types like image annotations', async () => {
    storedAnnotations.set('PDF12345', [
      makeAnnotation({ key: 'IMGANN', annotationType: 'image' }),
    ]);
    const exported = await exportAllAnnotations();
    expect(exported).toEqual([]);
  });

  it('imports new annotations and counts unresolved when PDF is missing', async () => {
    const portable: PortableAnnotation[] = [
      {
        libraryType: 'user',
        parentItemKey: 'PDF12345',
        key: 'NEWANN1',
        dateModified: '2026-05-02T20:00:00Z',
        type: 'highlight',
        json: {
          type: 'highlight',
          color: '#ffd400',
          pageLabel: '1',
          sortIndex: '00001|000001|00000',
          position: '{"pageIndex":0,"rects":[[0,0,10,10]]}',
          text: 'cloud incoming',
          comment: 'from cloud',
        },
        tags: ['cloud'],
      },
      {
        libraryType: 'user',
        parentItemKey: 'PDF_NOT_LOCAL',
        key: 'ORPHAN1',
        dateModified: '2026-05-02T20:00:00Z',
        type: 'highlight',
        json: { type: 'highlight' },
        tags: [],
      },
    ];
    const result = await importAllAnnotations(portable);
    expect(result.imported).toBe(1);
    expect(result.unresolved).toBe(1);
    expect(savedJsonCalls).toHaveLength(1);
    expect(savedJsonCalls[0].attachmentKey).toBe('PDF12345');
    expect(savedJsonCalls[0].json.key).toBe('NEWANN1');
    expect(savedJsonCalls[0].json.tags).toEqual([{ tag: 'cloud' }]);
  });

  it('skips when local annotation has equal-or-newer dateModified', async () => {
    const portable: PortableAnnotation[] = [
      {
        libraryType: 'user',
        parentItemKey: 'PDF12345',
        key: 'ANN00001',
        // Equal to the local copy; last-write-wins treats this as no-op.
        dateModified: '2026-05-02T10:00:00Z',
        type: 'highlight',
        json: { type: 'highlight', text: 'older payload' },
        tags: [],
      },
    ];
    const result = await importAllAnnotations(portable);
    expect(result.unchanged).toBe(1);
    expect(result.imported).toBe(0);
    expect(savedJsonCalls).toHaveLength(0);
  });
});
