import type { Message } from '../providers/types';

interface StoredThread {
  itemID: number | null;
  updatedAt: string;
  messages: Message[];
}

type StoredThreads = Record<string, StoredThread>;

interface ZoteroFileAPI {
  getContentsAsync(path: string, charset?: string): Promise<string>;
  putContentsAsync(path: string, contents: string): Promise<void>;
}

interface ZoteroProfileAPI {
  dir: string;
}

interface ZoteroGlobal {
  File: ZoteroFileAPI;
  Profile: ZoteroProfileAPI;
}

const HISTORY_FILE = 'zotero-ai-sidebar-chat-history.json';
let writeQueue: Promise<void> = Promise.resolve();

export async function loadChatMessages(itemID: number | null): Promise<Message[]> {
  const threads = await readThreads();
  return normalizeMessages(threads[threadKey(itemID)]?.messages);
}

export function saveChatMessages(itemID: number | null, messages: Message[]): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const threads = await readThreads();
    const key = threadKey(itemID);
    const safeMessages = normalizeMessages(messages);

    if (safeMessages.length === 0) {
      delete threads[key];
    } else {
      threads[key] = {
        itemID,
        updatedAt: new Date().toISOString(),
        messages: safeMessages,
      };
    }

    await writeThreads(threads);
  });
  return writeQueue;
}

export function chatHistoryPath(): string {
  return `${getZotero().Profile.dir}/${HISTORY_FILE}`;
}

async function readThreads(): Promise<StoredThreads> {
  try {
    const raw = await getZotero().File.getContentsAsync(chatHistoryPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StoredThreads)
      : {};
  } catch {
    return {};
  }
}

async function writeThreads(threads: StoredThreads): Promise<void> {
  await getZotero().File.putContentsAsync(
    chatHistoryPath(),
    JSON.stringify(threads, null, 2),
  );
}

function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const m = message as Partial<Message>;
    if (m.role !== 'user' && m.role !== 'assistant') return [];
    if (typeof m.content !== 'string') return [];
    const images = normalizeImages(m.images);
    return [{
      role: m.role,
      content: m.content,
      ...(typeof m.thinking === 'string' && m.thinking
        ? { thinking: m.thinking }
        : {}),
      ...(images.length ? { images } : {}),
      ...(isRecord(m.context) ? { context: m.context as Message['context'] } : {}),
    }];
  });
}

function normalizeImages(value: unknown): NonNullable<Message['images']> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((image) => {
    if (!isRecord(image)) return [];
    if (
      typeof image.id !== 'string' ||
      typeof image.name !== 'string' ||
      typeof image.mediaType !== 'string' ||
      typeof image.dataUrl !== 'string' ||
      typeof image.size !== 'number'
    ) {
      return [];
    }
    return [{
      id: image.id,
      name: image.name,
      mediaType: image.mediaType,
      dataUrl: image.dataUrl,
      size: image.size,
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function threadKey(itemID: number | null): string {
  return itemID == null ? 'global' : `item:${itemID}`;
}

function getZotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}
