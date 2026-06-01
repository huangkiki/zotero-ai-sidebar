import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteChatThread,
  loadChatMessages,
  loadChatThreads,
  saveChatMessages,
} from '../../src/settings/chat-history';

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

  it('preserves assistant annotation draft color', async () => {
    await saveChatMessages(42, [
      {
        role: 'assistant',
        content: '解释正文',
        annotationDraft: {
          comment: '- 核心问题',
          color: '#ff6666',
          snapshot: {
            text: 'selected sentence',
            attachmentID: 7,
            annotation: { position: { pageIndex: 0, rects: [] } },
          },
          state: { kind: 'idle' },
          textState: { kind: 'saved', annotationID: 8, savedAt: 1234 },
        },
      },
    ]);

    expect(await loadChatMessages(42)).toEqual([
      {
        role: 'assistant',
        content: '解释正文',
        annotationDraft: {
          comment: '- 核心问题',
          color: '#ff6666',
          snapshot: {
            text: 'selected sentence',
            attachmentID: 7,
            annotation: { position: { pageIndex: 0, rects: [] } },
          },
          state: { kind: 'idle' },
          textState: { kind: 'saved', annotationID: 8, savedAt: 1234 },
        },
      },
    ]);
  });

  it('preserves local task queue metadata', async () => {
    await saveChatMessages(42, [
      {
        role: 'user',
        content: '解释这句话',
        task: {
          id: 'task-1',
          kind: 'selection',
          title: '选中文字提问',
          promptPreview: 'While most robotic learning systems...',
          createdAt: 100,
          completedAt: 200,
          viewedAt: 300,
          pdfSelection: {
            attachmentID: 7,
            selectedText: 'While most robotic learning systems...',
            pageIndex: 0,
            pageLabel: '1',
            position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
          },
        },
      },
    ]);

    expect(await loadChatMessages(42)).toEqual([
      {
        role: 'user',
        content: '解释这句话',
        task: {
          id: 'task-1',
          kind: 'selection',
          title: '选中文字提问',
          promptPreview: 'While most robotic learning systems...',
          createdAt: 100,
          completedAt: 200,
          viewedAt: 300,
          pdfSelection: {
            attachmentID: 7,
            selectedText: 'While most robotic learning systems...',
            pageIndex: 0,
            pageLabel: '1',
            position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
          },
        },
      },
    ]);
  });

  it('stores multiple chat threads for the same Zotero item', async () => {
    await saveChatMessages(42, [{ role: 'user', content: 'default chat' }]);
    await saveChatMessages(
      42,
      [{ role: 'user', content: 'parallel chat' }],
      { threadID: 'chat-second', title: '第二个对话', createdAt: '2026-05-01T00:00:00.000Z' },
    );

    expect(await loadChatMessages(42)).toEqual([
      { role: 'user', content: 'default chat' },
    ]);
    expect(await loadChatMessages(42, 'chat-second')).toEqual([
      { role: 'user', content: 'parallel chat' },
    ]);
    const threads = await loadChatThreads(42);
    expect(threads.map((thread) => thread.threadID)).toEqual([
      'main',
      'chat-second',
    ]);
    expect(threads[1].title).toBe('第二个对话');
  });

  it('deletes only the selected chat thread', async () => {
    await saveChatMessages(42, [{ role: 'user', content: 'default chat' }]);
    await saveChatMessages(42, [{ role: 'user', content: 'parallel chat' }], {
      threadID: 'chat-second',
    });

    await deleteChatThread(42, 'chat-second');

    expect(await loadChatMessages(42)).toHaveLength(1);
    expect(await loadChatMessages(42, 'chat-second')).toEqual([]);
    expect((await loadChatThreads(42)).map((thread) => thread.threadID)).toEqual([
      'main',
    ]);
  });
});
