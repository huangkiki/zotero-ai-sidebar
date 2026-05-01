import type { AssistantAnnotationDraft, Message } from '../providers/types';

// Per-Zotero-item chat persistence.
//
// Storage shape: a single JSON file in the Zotero profile dir, keyed by
// `item:<itemID>` (or `global` for chats with no current item). Each entry
// holds the entire message history for that item — messages, context
// metadata, thinking traces, image attachments, and annotation drafts.
//
// INVARIANT: writes are SERIALIZED via `writeQueue` to prevent two concurrent
// `saveChatMessages` calls from racing on the same JSON file. WHY: we
// read-modify-write the whole file each time; two unsynchronized writes
// would clobber each other's threads.
//
// INVARIANT: `normalizeMessages` runs on EVERY read. Old persisted threads
// may pre-date the current Message schema (added images, annotationDraft,
// thinking, context). Normalization treats the file as untrusted and only
// re-emits well-typed fields — schema rot recovery, not validation.
//
// REF: CLAUDE.md "Chat history persistence lives in src/settings/chat-history.ts;
//      preserve messages, context traces, thinking summaries, and image metadata."

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
  // Chain the next write onto the queue. `.catch(() => undefined)` ensures
  // a previous write's failure does NOT cancel the next write — callers
  // observe their own write's outcome via the returned promise.
  // GOTCHA: an empty `messages` array deletes the thread entirely. The
  // sidebar uses this for "clear chat" without a separate delete API.
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

// Treat `value` as untrusted JSON (could be from an older plugin version
// or a hand-edited file). flatMap+[] is the discard pattern: any malformed
// entry is silently dropped rather than failing the whole load. WHY silent:
// we'd rather lose one corrupt message than refuse to open the chat.
function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const m = message as Partial<Message>;
    if (m.role !== 'user' && m.role !== 'assistant') return [];
    if (typeof m.content !== 'string') return [];
    const images = normalizeImages(m.images);
    const annotationDraft = normalizeAnnotationDraft(m.annotationDraft);
    return [{
      role: m.role,
      content: m.content,
      ...(typeof m.thinking === 'string' && m.thinking
        ? { thinking: m.thinking }
        : {}),
      ...(images.length ? { images } : {}),
      ...(isRecord(m.context) ? { context: m.context as Message['context'] } : {}),
      ...(annotationDraft ? { annotationDraft } : {}),
    }];
  });
}

function normalizeAnnotationDraft(value: unknown): AssistantAnnotationDraft | null {
  if (!isRecord(value)) return null;
  const comment = typeof value.comment === 'string' ? value.comment : '';
  if (!comment) return null;
  const snapshot = isRecord(value.snapshot) ? value.snapshot : null;
  if (!snapshot) return null;
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const attachmentID = typeof snapshot.attachmentID === 'number' ? snapshot.attachmentID : null;
  const annotation = isRecord(snapshot.annotation) ? snapshot.annotation : null;
  if (!text || attachmentID == null || !annotation) return null;
  const state = normalizeAnnotationDraftState(value.state);
  return {
    comment,
    snapshot: { text, attachmentID, annotation },
    state,
  };
}

function normalizeAnnotationDraftState(value: unknown): AssistantAnnotationDraft['state'] {
  if (!isRecord(value)) return { kind: 'idle' };
  if (value.kind === 'saved' && typeof value.annotationID === 'number') {
    const savedAt = typeof value.savedAt === 'number' ? value.savedAt : Date.now();
    return { kind: 'saved', annotationID: value.annotationID, savedAt };
  }
  if (value.kind === 'failed' && typeof value.error === 'string') {
    return { kind: 'failed', error: value.error };
  }
  return { kind: 'idle' };
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
      ...(typeof image.marker === 'string' ? { marker: image.marker } : {}),
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
