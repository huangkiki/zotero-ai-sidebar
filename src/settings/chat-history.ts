import type { AssistantAnnotationDraft, ChatTaskMeta, Message } from '../providers/types';

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
  threadID?: string;
  title?: string;
  createdAt?: string;
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

interface ZoteroItemLike {
  key?: string;
  libraryID?: number;
}

interface ZoteroLibraryLike {
  libraryType?: 'user' | 'group';
  groupID?: number;
  id?: number;
}

interface ZoteroItemsAPI {
  get(itemID: number): ZoteroItemLike | false;
  getByLibraryAndKey(libraryID: number, key: string): ZoteroItemLike | false;
}

interface ZoteroLibrariesAPI {
  get(libraryID: number): ZoteroLibraryLike | undefined;
  userLibraryID: number;
}

interface ZoteroGroupLike {
  libraryID?: number;
}

interface ZoteroGroupsAPI {
  get(groupID: number): ZoteroGroupLike | false | undefined;
}

interface ZoteroGlobal {
  File: ZoteroFileAPI;
  Profile: ZoteroProfileAPI;
  Items?: ZoteroItemsAPI;
  Libraries?: ZoteroLibrariesAPI;
  Groups?: ZoteroGroupsAPI;
}

// Cross-machine portable form for cloud sync. WHY this shape: the local
// `itemID` numeric key is per-database (Zotero assigns them at insert
// time), so it CANNOT be sent to another machine. The portable identifier
// is `(libraryType, groupID?, itemKey)` — `itemKey` is the 8-char base32
// key Zotero sync uses, and it's stable across machines.
export interface PortableThread {
  libraryType: 'user' | 'group' | 'global';
  groupID?: number;
  itemKey?: string;
  threadID?: string;
  title?: string;
  createdAt?: string;
  updatedAt: string;
  messages: Message[];
}

export interface ImportThreadsResult {
  imported: number;
  unchanged: number;
  unresolved: number;
}

const HISTORY_FILE = 'zotero-ai-sidebar-chat-history.json';
export const DEFAULT_CHAT_THREAD_ID = 'main';
let writeQueue: Promise<void> = Promise.resolve();

export interface ChatThreadSnapshot {
  itemID: number | null;
  threadID: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface SaveChatMessagesOptions {
  threadID?: string;
  title?: string;
  createdAt?: string;
}

export async function loadChatMessages(
  itemID: number | null,
  threadID: string = DEFAULT_CHAT_THREAD_ID,
): Promise<Message[]> {
  const threads = await readThreads();
  return normalizeMessages(threads[threadKey(itemID, threadID)]?.messages);
}

export async function loadChatThreads(
  itemID: number | null,
): Promise<ChatThreadSnapshot[]> {
  const threads = await readThreads();
  const snapshots: ChatThreadSnapshot[] = [];
  for (const [key, thread] of Object.entries(threads)) {
    const parsed = parseThreadKey(key);
    if (!parsed || parsed.itemID !== itemID) continue;
    const messages = normalizeMessages(thread.messages);
    if (!messages.length) continue;
    const threadID = normalizeThreadID(thread.threadID || parsed.threadID);
    const updatedAt = stringOr(thread.updatedAt, new Date(0).toISOString());
    const createdAt = stringOr(thread.createdAt, updatedAt);
    snapshots.push({
      itemID,
      threadID,
      title: sanitizeThreadTitle(thread.title) || titleFromMessages(messages),
      createdAt,
      updatedAt,
      messages,
    });
  }
  return snapshots.sort(compareThreadSnapshots);
}

export function saveChatMessages(
  itemID: number | null,
  messages: Message[],
  options: SaveChatMessagesOptions | string = {},
): Promise<void> {
  const normalizedOptions =
    typeof options === 'string' ? { threadID: options } : options;
  const threadID = normalizeThreadID(normalizedOptions.threadID);
  // Chain the next write onto the queue. `.catch(() => undefined)` ensures
  // a previous write's failure does NOT cancel the next write — callers
  // observe their own write's outcome via the returned promise.
  // GOTCHA: an empty `messages` array deletes the thread entirely. The
  // sidebar uses this for "clear chat" without a separate delete API.
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const threads = await readThreads();
    const key = threadKey(itemID, threadID);
    const safeMessages = normalizeMessages(messages);

    if (safeMessages.length === 0) {
      delete threads[key];
    } else {
      threads[key] = {
        itemID,
        threadID,
        title:
          sanitizeThreadTitle(normalizedOptions.title) ||
          titleFromMessages(safeMessages),
        createdAt:
          stringOr(normalizedOptions.createdAt, threads[key]?.createdAt) ||
          new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: safeMessages,
      };
    }

    await writeThreads(threads);
  });
  return writeQueue;
}

export function deleteChatThread(
  itemID: number | null,
  threadID: string,
): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const threads = await readThreads();
    delete threads[threadKey(itemID, threadID)];
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
    const task = normalizeChatTask(m.task);
    return [{
      role: m.role,
      content: m.content,
      ...(typeof m.thinking === 'string' && m.thinking
        ? { thinking: m.thinking }
        : {}),
      ...(images.length ? { images } : {}),
      ...(isRecord(m.context) ? { context: m.context as Message['context'] } : {}),
      ...(annotationDraft ? { annotationDraft } : {}),
      ...(task ? { task } : {}),
    }];
  });
}

function normalizeChatTask(value: unknown): ChatTaskMeta | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const title = typeof value.title === 'string' ? value.title : '';
  const promptPreview = typeof value.promptPreview === 'string' ? value.promptPreview : '';
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0;
  if (!id || !title || !createdAt) return null;
  const kind =
    value.kind === 'selection' || value.kind === 'full_text' || value.kind === 'general'
      ? value.kind
      : 'general';
  const completedAt = optionalNumber(value.completedAt);
  const viewedAt = optionalNumber(value.viewedAt);
  const hiddenAt = optionalNumber(value.hiddenAt);
  const cancelledAt = optionalNumber(value.cancelledAt);
  const error = typeof value.error === 'string' && value.error ? value.error : undefined;
  const pdfSelection = normalizePdfSelectionLocator(value.pdfSelection);
  return {
    id,
    kind,
    title,
    promptPreview,
    createdAt,
    ...(completedAt != null ? { completedAt } : {}),
    ...(viewedAt != null ? { viewedAt } : {}),
    ...(hiddenAt != null ? { hiddenAt } : {}),
    ...(cancelledAt != null ? { cancelledAt } : {}),
    ...(error ? { error } : {}),
    ...(pdfSelection ? { pdfSelection } : {}),
  };
}

function normalizePdfSelectionLocator(value: unknown): ChatTaskMeta['pdfSelection'] | null {
  if (!isRecord(value)) return null;
  const attachmentID = typeof value.attachmentID === 'number' ? value.attachmentID : null;
  const selectedText = typeof value.selectedText === 'string' ? value.selectedText : '';
  const position = isRecord(value.position) ? value.position : null;
  if (attachmentID == null || !selectedText || !position) return null;
  const pageIndex = optionalNumber(value.pageIndex);
  const pageLabel = typeof value.pageLabel === 'string' ? value.pageLabel : undefined;
  return {
    attachmentID,
    selectedText,
    ...(pageIndex != null ? { pageIndex } : {}),
    ...(pageLabel ? { pageLabel } : {}),
    position: { ...position },
  };
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  const color = normalizeAnnotationColor(value.color);
  const state = normalizeAnnotationDraftState(value.state);
  const textState = normalizeAnnotationDraftState(value.textState);
  return {
    comment,
    ...(color ? { color } : {}),
    snapshot: { text, attachmentID, annotation },
    state,
    ...(textState.kind !== 'idle' ? { textState } : {}),
  };
}

function normalizeAnnotationColor(value: unknown): string {
  if (typeof value !== 'string') return '';
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : '';
}

function normalizeAnnotationDraftState(value: unknown): NonNullable<AssistantAnnotationDraft['textState']> {
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

function threadKey(
  itemID: number | null,
  threadID: string = DEFAULT_CHAT_THREAD_ID,
): string {
  const base = baseThreadKey(itemID);
  const safeThreadID = normalizeThreadID(threadID);
  return safeThreadID === DEFAULT_CHAT_THREAD_ID
    ? base
    : `${base}:chat:${safeThreadID}`;
}

function baseThreadKey(itemID: number | null): string {
  return itemID == null ? 'global' : `item:${itemID}`;
}

function parseThreadKey(
  key: string,
): { itemID: number | null; threadID: string } | null {
  const chatMarker = ':chat:';
  const markerIndex = key.indexOf(chatMarker);
  const base = markerIndex >= 0 ? key.slice(0, markerIndex) : key;
  const rawThreadID =
    markerIndex >= 0 ? key.slice(markerIndex + chatMarker.length) : '';
  if (base === 'global') {
    return {
      itemID: null,
      threadID: normalizeThreadID(rawThreadID),
    };
  }
  if (!base.startsWith('item:')) return null;
  const id = Number(base.slice('item:'.length));
  if (!Number.isFinite(id)) return null;
  return {
    itemID: id,
    threadID: normalizeThreadID(rawThreadID),
  };
}

function normalizeThreadID(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text === DEFAULT_CHAT_THREAD_ID) return DEFAULT_CHAT_THREAD_ID;
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return safe || DEFAULT_CHAT_THREAD_ID;
}

function sanitizeThreadTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

function titleFromMessages(messages: Message[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  const title =
    firstUser?.task?.title ||
    firstUser?.task?.promptPreview ||
    firstUser?.content ||
    messages[0]?.content ||
    '';
  const normalized = sanitizeThreadTitle(title);
  return normalized || '新对话';
}

function stringOr(value: unknown, fallback: unknown): string {
  return typeof value === 'string' && value ? value : typeof fallback === 'string' ? fallback : '';
}

function compareThreadSnapshots(
  a: ChatThreadSnapshot,
  b: ChatThreadSnapshot,
): number {
  if (a.threadID === DEFAULT_CHAT_THREAD_ID) return -1;
  if (b.threadID === DEFAULT_CHAT_THREAD_ID) return 1;
  return a.createdAt.localeCompare(b.createdAt) || a.threadID.localeCompare(b.threadID);
}

function getZotero(): ZoteroGlobal {
  return (globalThis as unknown as { Zotero: ZoteroGlobal }).Zotero;
}

// ---------------------------------------------------------------------------
// Cloud sync export/import.
//
// Both functions go DIRECTLY to the threads file (not through
// `saveChatMessages`) to keep bulk import as a single write — going through
// the public API would write once per thread and serialize on writeQueue.
// We DO chain on writeQueue so a concurrent in-flight chat save doesn't
// race with the import.

export async function exportAllThreads(): Promise<PortableThread[]> {
  const threads = await readThreads();
  const result: PortableThread[] = [];
  for (const [key, thread] of Object.entries(threads)) {
    const parsed = parseThreadKey(key);
    if (!parsed) continue;
    if (key === 'global' || thread.itemID == null) {
      result.push({
        libraryType: 'global',
        ...portableThreadFields(thread, parsed.threadID),
        updatedAt: thread.updatedAt,
        messages: thread.messages,
      });
      continue;
    }
    const portable = portableFromItemID(thread.itemID);
    if (!portable) continue; // item no longer in local library — drop
    result.push({
      ...portable,
      ...portableThreadFields(thread, parsed.threadID),
      updatedAt: thread.updatedAt,
      messages: thread.messages,
    });
  }
  return result;
}

export function importAllThreads(
  portable: PortableThread[],
): Promise<ImportThreadsResult> {
  // Chain on writeQueue so we don't race a chat save in flight.
  let outcome: ImportThreadsResult = { imported: 0, unchanged: 0, unresolved: 0 };
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const existing = await readThreads();
    let imported = 0;
    let unchanged = 0;
    let unresolved = 0;
    for (const candidate of portable) {
      const localKey = resolvePortableKey(candidate);
      if (!localKey) {
        unresolved += 1;
        continue;
      }
      const safeMessages = normalizeMessages(candidate.messages);
      if (safeMessages.length === 0) continue;
      const existingThread = existing[localKey];
      // Last-write-wins by updatedAt: only overwrite when the cloud copy is
      // strictly newer. Equal timestamps treated as "no change" to avoid
      // gratuitous updates.
      if (existingThread && existingThread.updatedAt >= candidate.updatedAt) {
        unchanged += 1;
        continue;
      }
      existing[localKey] = {
        itemID: candidate.libraryType === 'global' ? null : itemIDForKey(localKey),
        threadID: normalizeThreadID(candidate.threadID),
        title: sanitizeThreadTitle(candidate.title),
        createdAt: stringOr(candidate.createdAt, candidate.updatedAt),
        updatedAt: candidate.updatedAt,
        messages: safeMessages,
      };
      imported += 1;
    }
    await writeThreads(existing);
    outcome = { imported, unchanged, unresolved };
  });
  return writeQueue.then(() => outcome);
}

function portableThreadFields(
  thread: StoredThread,
  parsedThreadID: string,
): Pick<PortableThread, 'threadID' | 'title' | 'createdAt'> {
  const threadID = normalizeThreadID(thread.threadID || parsedThreadID);
  return {
    ...(threadID !== DEFAULT_CHAT_THREAD_ID ? { threadID } : {}),
    ...(sanitizeThreadTitle(thread.title) ? { title: sanitizeThreadTitle(thread.title) } : {}),
    ...(typeof thread.createdAt === 'string' && thread.createdAt
      ? { createdAt: thread.createdAt }
      : {}),
  };
}

function portableFromItemID(itemID: number): Omit<PortableThread, 'updatedAt' | 'messages'> | null {
  const Zotero = getZotero();
  const item = Zotero.Items?.get(itemID);
  if (!item || typeof item.key !== 'string' || item.key.length === 0) return null;
  const libraryID = item.libraryID;
  if (typeof libraryID !== 'number') return null;
  const library = Zotero.Libraries?.get(libraryID);
  if (library?.libraryType === 'group') {
    // Prefer the group's portable groupID (stable across machines) over the
    // local libraryID. WHY: libraryID is reassigned per database; groupID
    // is the global Zotero group identifier.
    const groupID = typeof library.groupID === 'number' ? library.groupID : undefined;
    if (typeof groupID !== 'number') return null;
    return { libraryType: 'group', groupID, itemKey: item.key };
  }
  return { libraryType: 'user', itemKey: item.key };
}

function resolvePortableKey(thread: PortableThread): string | null {
  const threadID = normalizeThreadID(thread.threadID);
  if (thread.libraryType === 'global') return threadKey(null, threadID);
  const Zotero = getZotero();
  if (typeof thread.itemKey !== 'string' || thread.itemKey.length === 0) return null;
  let libraryID: number | undefined;
  if (thread.libraryType === 'group') {
    if (typeof thread.groupID !== 'number') return null;
    const group = Zotero.Groups?.get(thread.groupID);
    if (!group || typeof group.libraryID !== 'number') return null;
    libraryID = group.libraryID;
  } else {
    libraryID = Zotero.Libraries?.userLibraryID;
  }
  if (typeof libraryID !== 'number') return null;
  const item = Zotero.Items?.getByLibraryAndKey(libraryID, thread.itemKey);
  if (!item) return null;
  // We don't have a public itemID accessor on the item-like; the legacy
  // storage layout is `item:<itemID>`, so we round-trip via Zotero's
  // typed shape. The cast is safe — Zotero items always expose `id`.
  const id = (item as unknown as { id?: number }).id;
  if (typeof id !== 'number') return null;
  return threadKey(id, threadID);
}

function itemIDForKey(threadKey: string): number | null {
  const parsed = parseThreadKey(threadKey);
  if (!parsed) return null;
  const id = parsed.itemID;
  return Number.isFinite(id) ? id : null;
}
