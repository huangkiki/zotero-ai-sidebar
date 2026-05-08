const DEBUG_LOG_PATH = "/tmp/zai_translate_debug.log";
const MAX_DEBUG_LINES = 1200;

interface DebugState {
  lines: string[];
  writing: Promise<void>;
}

export function logTranslateDebug(
  channel: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const prefix = `[${channel}] ${message}`;
  const payload = extra ? `${prefix} ${safeStringify(extra)}` : prefix;
  try {
    const Z = (globalThis as unknown as {
      Zotero?: { debug?: (s: string) => void };
    }).Zotero;
    Z?.debug?.(payload);
  } catch {
    /* ignore */
  }
  try {
    console.log(payload);
  } catch {
    /* ignore */
  }
  writeDebugFile(payload);
}

function writeDebugFile(payload: string): void {
  try {
    const Z = (globalThis as unknown as {
      Zotero?: { File?: { putContentsAsync?: (path: string, data: string) => Promise<void> } };
    }).Zotero;
    const putContentsAsync = Z?.File?.putContentsAsync;
    if (typeof putContentsAsync !== "function") return;
    const state = debugState();
    state.lines.push(`${new Date().toISOString()} ${payload}`);
    if (state.lines.length > MAX_DEBUG_LINES) {
      state.lines.splice(0, state.lines.length - MAX_DEBUG_LINES);
    }
    state.writing = state.writing
      .catch(() => undefined)
      .then(() => putContentsAsync(DEBUG_LOG_PATH, `${state.lines.join("\n")}\n`))
      .catch(() => undefined);
  } catch {
    /* ignore */
  }
}

function debugState(): DebugState {
  const g = globalThis as unknown as { __zaiTranslateDebugState?: DebugState };
  if (!g.__zaiTranslateDebugState) {
    g.__zaiTranslateDebugState = { lines: [], writing: Promise.resolve() };
  }
  return g.__zaiTranslateDebugState;
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{\"error\":\"failed to stringify debug payload\"}";
  }
}
