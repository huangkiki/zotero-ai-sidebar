import { beforeEach, describe, expect, it } from 'vitest';
import { createZoteroAgentTools } from '../../src/context/agent-tools';
import type { ContextSource } from '../../src/context/builder';

const source: ContextSource = {
  getItem: async () => null,
  getFullText: async () => '',
};

let savedJSON: Record<string, unknown> | null = null;

beforeEach(() => {
  savedJSON = null;
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Items: {
        getAsync: async (id: number) => ({ id, libraryID: 1 }),
      },
      DataObjectUtilities: {
        generateKey: () => 'GENKEY',
      },
      Annotations: {
        DEFAULT_COLOR: '#ffd400',
        saveFromJSON: async (_attachment: unknown, json: Record<string, unknown>) => {
          savedJSON = json;
          return { id: 99 };
        },
      },
    },
  });
});

describe('createZoteroAgentTools', () => {
  it('creates a permission-aware Zotero annotation from the current selection', async () => {
    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: 'Selected PDF text',
        attachmentID: 2,
        annotation: {
          id: 'ANNKEY',
          type: 'highlight',
          text: 'Selected PDF text',
          color: '#ff6666',
          pageLabel: '3',
          sortIndex: '00042',
          position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
        },
      }),
    });

    const tool = tools.find((candidate) => candidate.name === 'zotero_add_annotation_to_selection');
    expect(tool?.requiresApproval).toBe(true);

    const result = await tool!.execute({ comment: 'AI generated note' });

    expect(result.summary).toBe('新增 PDF 注释 17 字');
    expect(result.output).toContain('Annotation item ID: 99');
    expect(savedJSON).toMatchObject({
      key: 'ANNKEY',
      type: 'highlight',
      text: 'Selected PDF text',
      comment: 'AI generated note',
      color: '#ff6666',
      pageLabel: '3',
      sortIndex: '00042',
      position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
    });
  });
});
