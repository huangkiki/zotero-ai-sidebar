import { beforeEach, describe, expect, it } from 'vitest';
import { loadChatMessages, saveChatMessages } from '../../src/settings/chat-history';

let stored = '{}';

beforeEach(() => {
  stored = '{}';
  Object.defineProperty(globalThis, 'Zotero', {
    configurable: true,
    value: {
      Profile: { dir: '/tmp/zotero-profile' },
      File: {
        getContentsAsync: async () => stored,
        putContentsAsync: async (_path: string, contents: string) => {
          stored = contents;
        },
      },
    },
  });
});

describe('chat history', () => {
  it('preserves screenshot attachments and agent context', async () => {
    await saveChatMessages(42, [
      {
        role: 'user',
        content: '分析截图',
        images: [
          {
            id: 'img-1',
            name: 'shot.png',
            mediaType: 'image/png',
            dataUrl: 'data:image/png;base64,abc',
            size: 3,
          },
        ],
        context: {
          selectedText: 'paper text',
          toolCalls: [
            {
              name: 'zotero_get_current_item',
              status: 'completed',
              summary: '读取当前条目',
            },
          ],
        },
      },
    ]);

    expect(await loadChatMessages(42)).toEqual([
      {
        role: 'user',
        content: '分析截图',
        images: [
          {
            id: 'img-1',
            name: 'shot.png',
            mediaType: 'image/png',
            dataUrl: 'data:image/png;base64,abc',
            size: 3,
          },
        ],
        context: {
          selectedText: 'paper text',
          toolCalls: [
            {
              name: 'zotero_get_current_item',
              status: 'completed',
              summary: '读取当前条目',
            },
          ],
        },
      },
    ]);
  });
});
