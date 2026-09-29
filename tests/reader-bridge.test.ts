import { describe, expect, it, vi } from "vitest";
import { createHandler, validateArgs } from "../src/reader-bridge/protocol";
import { createReaderControls } from "../src/reader-bridge";

function client(execute = vi.fn().mockResolvedValue({ ok: true })) {
  const handler = createHandler("test-token", 23119, execute);
  const headers = {
    host: "127.0.0.1:23119",
    authorization: "Bearer test-token",
  };
  return {
    execute,
    headers,
    handler,
    call: (data: unknown) => handler({ method: "POST", headers, data }),
  };
}

describe("Reader MCP boundary", () => {
  it("rejects missing credentials, web origins and foreign hosts before dispatch", async () => {
    const { handler, headers, execute } = client();
    for (const bad of [
      { ...headers, authorization: "" },
      { ...headers, origin: "https://evil.test" },
      { ...headers, origin: "" },
      { ...headers, host: "evil.test:23119" },
    ]) {
      expect(
        (await handler({ method: "POST", headers: bad, data: {} }))[0],
      ).toBe(403);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("negotiates MCP, advertises five tools and accepts notifications", async () => {
    const { call, execute } = client();
    const init = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 1, method: "initialize" }))[2],
    );
    expect(init.result.protocolVersion).toBe("2025-03-26");
    const listing = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }))[2],
    );
    expect(listing.result.tools).toHaveLength(5);
    expect(
      (await call({ jsonrpc: "2.0", method: "notifications/initialized" }))[0],
    ).toBe(202);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unauthorized highlights, invalid pages, and extra fields", async () => {
    const { call, execute } = client();
    const args = {
      expectedAttachmentKey: "ABCD1234",
      page: 1,
      text: "Exact source.",
      comment: "Reading note",
    };
    for (const invalid of [
      args,
      { ...args, approved: false },
      { ...args, approved: true, page: 0 },
      { ...args, approved: true, page: 1.5 },
      { ...args, approved: true, color: "bad" },
      { ...args, approved: true, eval: "anything" },
    ]) {
      const result = JSON.parse(
        (
          await call({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "zotero_highlight", arguments: invalid },
          })
        )[2],
      );
      expect(result.result.isError).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(() =>
      validateArgs("zotero_highlight", { ...args, approved: true }),
    ).not.toThrow();
  });

  it("returns tool failures as MCP content and unknown methods as protocol errors", async () => {
    const { call } = client(
      vi.fn().mockRejectedValue(new Error("PDF changed")),
    );
    const failed = JSON.parse(
      (
        await call({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "zotero_reader_state" },
        })
      )[2],
    );
    expect(failed.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "PDF changed" }],
    });
    const unknown = JSON.parse(
      (await call({ jsonrpc: "2.0", id: 5, method: "eval" }))[2],
    );
    expect(unknown.error.code).toBe(-32601);
  });
});

function readerFixture() {
  const annotations: any[] = [];
  let selectedID = "pdf";
  let beforeText: (() => void) | undefined;
  const attachment = {
    id: 7,
    key: "ABCD1234",
    attachmentContentType: "application/pdf",
    parentID: false,
    getField: () => "Test paper",
    getAnnotations: () => annotations,
  };
  const reader = {
    _item: attachment,
    _internalReader: { _state: { primaryViewStats: { pageIndex: 0 } } },
    _iframeWindow: {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: 2,
          getPage: async () => ({
            view: [0, 0, 600, 800],
            getTextContent: async () => {
              beforeText?.();
              return {
                items: [
                  {
                    str: "Exact source sentence.",
                    transform: [10, 0, 0, 10, 10, 100],
                    width: 120,
                    height: 10,
                  },
                ],
              };
            },
          }),
        },
      },
    },
    navigate: vi.fn().mockResolvedValue(undefined),
    setAnnotations: vi.fn().mockResolvedValue(undefined),
  };
  const saveFromJSON = vi.fn(async (_item, data) => {
    const saved = {
      key: data.key,
      annotationType: data.type,
      annotationText: data.text,
      annotationComment: data.comment,
      annotationColor: data.color,
      annotationPageLabel: data.pageLabel,
      annotationPosition: JSON.stringify(data.position),
    };
    annotations.push(saved);
    return saved;
  });
  const native = {
    getMainWindow: () => ({ Zotero_Tabs: { selectedID }, JSON }),
    Reader: { getByTabID: (id: string) => (id === "pdf" ? reader : undefined) },
    Items: { get: () => attachment },
    DataObjectUtilities: { generateKey: () => "NEWKEY12" },
    Annotations: { saveFromJSON },
    debug: vi.fn(),
  };
  const controls = createReaderControls(
    native as unknown as Parameters<typeof createReaderControls>[0],
  );
  return {
    controls,
    reader,
    saveFromJSON,
    switchDuringRead: () => {
      beforeText = () => {
        selectedID = "library";
      };
    },
  };
}

describe("Active Reader controls", () => {
  it("reads real locator text, enforces attachment identity and bounds navigation", async () => {
    const { controls, reader } = readerFixture();
    expect(await controls.execute("zotero_reader_state", {})).toMatchObject({
      attachmentKey: "ABCD1234",
      page: 1,
      pageCount: 2,
    });
    expect(
      await controls.execute("zotero_read_page", {
        expectedAttachmentKey: "ABCD1234",
      }),
    ).toMatchObject({
      text: expect.stringContaining("Exact source sentence."),
    });
    await expect(
      controls.execute("zotero_navigate", {
        expectedAttachmentKey: "OTHERKEY",
        page: 1,
      }),
    ).rejects.toThrow("PDF changed");
    await expect(
      controls.execute("zotero_navigate", {
        expectedAttachmentKey: "ABCD1234",
        page: 3,
      }),
    ).rejects.toThrow("between 1 and 2");
    expect(reader.navigate).not.toHaveBeenCalled();
    await controls.execute("zotero_navigate", {
      expectedAttachmentKey: "ABCD1234",
      page: 2,
    });
    expect(reader.navigate).toHaveBeenCalledWith({ pageIndex: 1 });
  });

  it("refuses to write after the user changes tabs during PDF text extraction", async () => {
    const { controls, switchDuringRead, saveFromJSON } = readerFixture();
    switchDuringRead();
    await expect(
      controls.execute("zotero_highlight", {
        expectedAttachmentKey: "ABCD1234",
        page: 1,
        text: "Exact source sentence.",
        comment: "Note",
        approved: true,
      }),
    ).rejects.toThrow();
    expect(saveFromJSON).not.toHaveBeenCalled();
  });

  it("rejects invented text and persists matching geometry only once on retries", async () => {
    const { controls, saveFromJSON, reader } = readerFixture();
    const args = {
      expectedAttachmentKey: "ABCD1234",
      page: 1,
      text: "Exact source sentence.",
      comment: "Note",
      approved: true,
    };
    await expect(
      controls.execute("zotero_highlight", {
        ...args,
        text: "Invented source sentence.",
      }),
    ).rejects.toThrow("No exact");
    expect(saveFromJSON).not.toHaveBeenCalled();
    const first: any = await controls.execute("zotero_highlight", args);
    const second: any = await controls.execute("zotero_highlight", args);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.annotation.position).toMatchObject({ pageIndex: 0 });
    expect(first.annotation.position.rects.length).toBeGreaterThan(0);
    expect(saveFromJSON).toHaveBeenCalledTimes(1);
    expect(reader.setAnnotations).toHaveBeenCalledTimes(1);
  });
});
