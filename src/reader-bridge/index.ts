import { createPdfLocator, type PdfLocator } from "../context/pdf-locator";
import { DEFAULT_CONTEXT_POLICY as policy } from "../context/policy";
import {
  createHandler,
  type BridgeRequest,
  type ExecuteTool,
} from "./protocol";

const endpointPath = "/zai/reader-mcp";

// These are Zotero's native Reader internals, not a second PDF implementation.
interface Reader {
  _item: Zotero.Item;
  _internalReader?: {
    _state?: {
      primaryViewStats?: { pageIndex?: number };
      primaryViewState?: { pageIndex?: number };
    };
  };
  navigate(location: { pageIndex: number; position?: unknown }): Promise<void>;
  setAnnotations(items: Zotero.Item[]): Promise<void>;
}

interface BridgeZotero {
  Profile: { dir: string };
  Server: {
    port: number;
    Endpoints: Record<string, unknown>;
    responseCodes: Record<number, string>;
  };
  Reader: { getByTabID(id: string): Reader | undefined };
  getMainWindow(): Window & {
    Zotero_Tabs?: { selectedID?: string };
    JSON: typeof JSON;
    crypto: Crypto;
  };
  Items: { get(id: number): Zotero.Item };
  DataObjectUtilities: { generateKey(): string };
  Annotations: {
    saveFromJSON(item: Zotero.Item, data: unknown): Promise<Zotero.Item>;
  };
  debug(message: string): void;
}

let stopServer: (() => void) | undefined;

export async function start(
  zotero: unknown = Zotero,
  io: typeof IOUtils = IOUtils,
): Promise<void> {
  if (stopServer) return;
  const Z = zotero as BridgeZotero;
  if (Z.Server.Endpoints[endpointPath])
    throw new Error("Reader MCP endpoint is already registered.");
  const directory = `${Z.Profile.dir}/zai-reader-bridge`;
  await io.makeDirectory(directory, {
    ignoreExisting: true,
    permissions: 0o700,
  });
  await io.setPermissions(directory, 0o700);
  const random = new Uint8Array(32);
  Z.getMainWindow().crypto.getRandomValues(random);
  const token = Array.from(random, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const port = Z.Server.port;
  const controls = createReaderControls(Z);
  const handle = createHandler(token, port, controls.execute);
  class Endpoint {
    supportedMethods = ["GET", "POST"];
    supportedDataTypes = ["application/json"];
    permitBookmarklet = false;
    allowRequestsFromUnsafeWebContent = false;
    init(request: BridgeRequest) {
      return handle(request);
    }
  }
  // Zotero's embedded server omits these standard HTTP reason phrases.
  Z.Server.responseCodes[202] ??= "Accepted";
  Z.Server.responseCodes[405] ??= "Method Not Allowed";
  await io.writeUTF8(
    `${directory}/connection.json`,
    JSON.stringify({
      endpoint: `http://127.0.0.1:${port}${endpointPath}`,
      token,
    }),
  );
  await io.setPermissions(`${directory}/connection.json`, 0o600);
  Z.Server.Endpoints[endpointPath] = Endpoint;
  stopServer = () => {
    if (Z.Server.Endpoints[endpointPath] === Endpoint)
      delete Z.Server.Endpoints[endpointPath];
    controls.dispose();
  };
  Z.debug("[AI Sidebar] Local Reader MCP bridge ready.");
}

export function stop(): void {
  stopServer?.();
  stopServer = undefined;
}

export function createReaderControls(Z: BridgeZotero) {
  let cached: { reader: Reader; locator: PdfLocator } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let alive = true;

  function activeReader(): Reader {
    if (!alive) throw new Error("Reader bridge has stopped.");
    const tabID = Z.getMainWindow()?.Zotero_Tabs?.selectedID;
    const reader = tabID ? Z.Reader.getByTabID(tabID) : undefined;
    if (!reader || reader._item?.attachmentContentType !== "application/pdf")
      throw new Error("Select a PDF tab in Zotero's main window first.");
    return reader;
  }

  function assertCurrent(reader: Reader, expectedKey?: unknown): void {
    if (
      activeReader() !== reader ||
      (expectedKey !== undefined && reader._item.key !== expectedKey)
    ) {
      throw new Error(
        "The active PDF changed. Read reader_state and confirm the intended attachment before retrying.",
      );
    }
  }

  async function locatorFor(reader: Reader): Promise<PdfLocator> {
    if (cached?.reader !== reader) {
      cached?.locator.dispose();
      cached = undefined;
      const locator = await createPdfLocator(reader);
      try {
        assertCurrent(reader);
      } catch (error) {
        locator.dispose();
        throw error;
      }
      cached = { reader, locator };
    }
    return cached.locator;
  }

  function currentPage(reader: Reader): number {
    const state = reader._internalReader?._state;
    const index =
      state?.primaryViewStats?.pageIndex ?? state?.primaryViewState?.pageIndex;
    if (!Number.isInteger(index))
      throw new Error("The Reader has not reported its current page yet.");
    return (index as number) + 1;
  }

  function annotationData(item: Zotero.Item) {
    return {
      key: item.key,
      text: item.annotationText,
      comment: item.annotationComment,
      color: item.annotationColor,
      pageLabel: item.annotationPageLabel,
      position: JSON.parse(item.annotationPosition),
    };
  }

  const executeOne: ExecuteTool = async (name, args) => {
    const reader = activeReader();
    assertCurrent(reader, args.expectedAttachmentKey);
    const locator = await locatorFor(reader);
    assertCurrent(reader, args.expectedAttachmentKey);
    const attachment = reader._item;
    const page =
      typeof args.page === "number" ? args.page : currentPage(reader);
    if (!Number.isInteger(page) || page < 1 || page > locator.pageCount)
      throw new Error(`Page must be between 1 and ${locator.pageCount}.`);
    const pageIndex = page - 1;

    switch (name) {
      case "zotero_reader_state": {
        const parent = attachment.parentID
          ? Z.Items.get(attachment.parentID)
          : attachment;
        return {
          attachmentKey: attachment.key,
          attachmentID: attachment.id,
          title: parent.getField("title"),
          page: currentPage(reader),
          pageCount: locator.pageCount,
        };
      }
      case "zotero_read_page": {
        const content = await locator.getPageContent(pageIndex);
        assertCurrent(reader, args.expectedAttachmentKey);
        if (!content)
          throw new Error("This page's Reader text layer is unavailable.");
        const annotations = attachment
          .getAnnotations()
          .filter(
            (item) =>
              JSON.parse(item.annotationPosition).pageIndex === pageIndex,
          )
          .slice(0, policy.maxAnnotations)
          .map(annotationData);
        return {
          attachmentKey: attachment.key,
          page,
          pageLabel: content.pageLabel,
          text: content.pageText.slice(0, policy.maxRangeChars),
          truncated: content.pageText.length > policy.maxRangeChars,
          annotations,
        };
      }
      case "zotero_navigate": {
        assertCurrent(reader, args.expectedAttachmentKey);
        await reader.navigate({ pageIndex });
        assertCurrent(reader, args.expectedAttachmentKey);
        // navigate() schedules PDF.js rendering; a later reader_state confirms its final page.
        return {
          attachmentKey: attachment.key,
          requestedPage: page,
          navigationRequested: true,
        };
      }
      case "zotero_find_passage":
      case "zotero_highlight": {
        const result = await locator.locate(args.text as string, {
          minConfidence: 1,
          ...(args.page === undefined ? {} : { pageIndex }),
        });
        assertCurrent(reader, args.expectedAttachmentKey);
        if (!result)
          throw new Error(
            "No exact normalized Reader-text match. Read the page and copy the passage verbatim.",
          );
        if (name === "zotero_find_passage")
          return {
            attachmentKey: attachment.key,
            ...result,
            page: result.pageIndex + 1,
          };
        const color = (
          (args.color as string | undefined) ?? "#ffd400"
        ).toLowerCase();
        const position = { pageIndex: result.pageIndex, rects: result.rects };
        const existing = attachment
          .getAnnotations()
          .find(
            (item) =>
              item.annotationType === "highlight" &&
              item.annotationText === result.matchedText &&
              item.annotationComment === args.comment &&
              item.annotationColor.toLowerCase() === color &&
              JSON.stringify(JSON.parse(item.annotationPosition)) ===
                JSON.stringify(position),
          );
        if (existing)
          return {
            attachmentKey: attachment.key,
            reused: true,
            annotation: annotationData(existing),
          };
        const annotationKey = Z.DataObjectUtilities.generateKey();
        const data = {
          id: annotationKey,
          key: annotationKey,
          type: "highlight",
          text: result.matchedText,
          comment: args.comment,
          color,
          pageLabel: result.pageLabel,
          sortIndex: result.sortIndex,
          position,
        };
        // Native JSON.parse creates the object in Zotero's privileged compartment.
        const nativeData = Z.getMainWindow().JSON.parse(JSON.stringify(data));
        assertCurrent(reader, args.expectedAttachmentKey);
        const saved = await Z.Annotations.saveFromJSON(attachment, nativeData);
        let displayWarning: string | undefined;
        try {
          await reader.setAnnotations([saved]);
        } catch {
          displayWarning =
            "Highlight saved; reopen this PDF to refresh its display.";
        }
        Z.debug(
          `[AI Sidebar Reader MCP] Saved highlight ${saved.key}, attachment ${attachment.key}, page ${page}.`,
        );
        return {
          attachmentKey: attachment.key,
          reused: false,
          annotation: annotationData(saved),
          ...(displayWarning ? { displayWarning } : {}),
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };

  return {
    execute(name: string, args: Record<string, unknown>) {
      const result = queue.then(() => executeOne(name, args));
      queue = result.catch(() => undefined);
      return result;
    },
    dispose() {
      alive = false;
      cached?.locator.dispose();
      cached = undefined;
    },
  };
}
