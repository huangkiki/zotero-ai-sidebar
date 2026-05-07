import { beforeEach, describe, expect, it } from "vitest";
import {
  createZoteroAgentTools,
  createZoteroAgentToolSession,
} from "../../src/context/agent-tools";
import type { ContextSource } from "../../src/context/builder";

const source: ContextSource = {
  getItem: async () => null,
  getFullText: async () => "",
};

let savedJSON: Record<string, unknown> | null = null;
let saveCount = 0;

beforeEach(() => {
  savedJSON = null;
  saveCount = 0;
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true,
    value: {
      Items: {
        getAsync: async (id: number) => ({ id, libraryID: 1 }),
      },
      DataObjectUtilities: {
        generateKey: () => "GENKEY",
      },
      Annotations: {
        DEFAULT_COLOR: "#ffd400",
        saveFromJSON: async (
          _attachment: unknown,
          json: Record<string, unknown>,
        ) => {
          savedJSON = json;
          saveCount += 1;
          return { id: 99 };
        },
      },
    },
  });
});

describe("createZoteroAgentTools", () => {
  it("creates a permission-aware Zotero annotation from the current selection", async () => {
    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Selected PDF text",
        attachmentID: 2,
        annotation: {
          id: "ANNKEY",
          type: "highlight",
          text: "Selected PDF text",
          color: "#ff6666",
          pageLabel: "3",
          sortIndex: "00042",
          position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) => candidate.name === "zotero_add_annotation_to_selection",
    );
    expect(tool?.requiresApproval).toBe(true);

    const result = await tool!.execute({ comment: "AI generated note" });

    expect(result.summary).toBe("新增 PDF 注释 17 字");
    expect(result.output).toContain("Annotation item ID: 99");
    expect(savedJSON).toMatchObject({
      key: "ANNKEY",
      type: "highlight",
      text: "Selected PDF text",
      comment: "AI generated note",
      color: "#ff6666",
      pageLabel: "3",
      sortIndex: "00042",
      position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
    });
  });

  it("exposes the current PDF selection as a read-only model tool", async () => {
    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Paragraph one.\n\n1) First question.\n2) Second question.",
        attachmentID: 2,
        annotation: {
          text: "Paragraph one.\n\n1) First question.\n2) Second question.",
          pageLabel: "8",
          position: { pageIndex: 7, rects: [[1, 2, 3, 4]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) => candidate.name === "zotero_get_current_pdf_selection",
    );
    expect(tool?.requiresApproval).toBeUndefined();

    const result = await tool!.execute({});

    expect(result.summary).toBe("读取当前 PDF 选区 54 字");
    expect(result.output).toContain("[Current PDF selection]");
    expect(result.output).toContain("Page: 8");
    expect(result.output).toContain("1) First question.\n2) Second question.");
    expect(result.context).toMatchObject({
      planMode: "selected_text",
      sourceKind: "zotero_item",
      sourceID: "1",
      selectedText: "Paragraph one.\n\n1) First question.\n2) Second question.",
    });
  });

  it("reports when the current PDF selection tool has no selection", async () => {
    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => null,
    });

    const tool = tools.find(
      (candidate) => candidate.name === "zotero_get_current_pdf_selection",
    );
    const result = await tool!.execute({});

    expect(result.output).toContain("No live PDF text selection is available");
  });

  it("creates a visible PDF text annotation near the current selection", async () => {
    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );
    expect(tool?.requiresApproval).toBe(true);

    const result = await tool!.execute({
      comment: "你好",
      color: "#ffcc00",
      fontSize: 16,
      placement: "below",
    });

    expect(result.summary).toBe("新增 PDF 文字（T 工具） 2 字");
    expect(result.output).toContain("Visible text: 你好");
    expect(savedJSON).toMatchObject({
      type: "text",
      text: "",
      comment: "你好",
      color: "#ffcc00",
      pageLabel: "5",
      sortIndex: "00004|000000|00100",
      position: {
        pageIndex: 4,
        fontSize: 16,
        rotation: 0,
      },
    });
    expect((savedJSON?.position as any).rects[0][1]).toBeGreaterThan(214);
  });

  it("writes visible text annotations directly through saveFromJSON, bypassing Reader's read-only UI lock", async () => {
    let selectedIDs: string[] = [];
    const manager = {
      _readOnly: true,
      setReadOnly(readOnly: boolean) {
        this._readOnly = readOnly;
      },
      // Reader.addAnnotation MUST NOT be called: a previous save failure left
      // it read-only and re-entering it would just keep failing. saveFromJSON
      // is the chrome-side write path that ignores the Reader UI lock.
      addAnnotation() {
        throw new Error("Reader.addAnnotation must not be invoked");
      },
    };
    const reader = {
      itemID: 2,
      _item: { id: 2 },
      _iframeWindow: {},
      _internalReader: {
        _state: { readOnly: true },
        _annotationManager: manager,
        setReadOnly(readOnly: boolean) {
          this._state.readOnly = readOnly;
        },
        setSelectedAnnotations(ids: string[]) {
          selectedIDs = ids;
        },
      },
    };

    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      getActiveReader: () => reader,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );
    const result = await tool!.execute({ comment: "你好", fontSize: 16 });

    expect(result.output).toContain("Annotation item ID: 99");
    expect(saveCount).toBe(1);
    // Best-effort UI niceties on the Reader: stale read-only is cleared and
    // the new annotation is selected so the user sees it highlighted.
    expect(reader._internalReader._state.readOnly).toBe(false);
    expect(manager._readOnly).toBe(false);
    expect(selectedIDs).toEqual(["GENKEY"]);
  });

  it("succeeds when post-save Reader nudges throw, since they're best-effort cosmetics", async () => {
    const reader = {
      itemID: 2,
      _item: { id: 2 },
      _iframeWindow: {},
      _internalReader: {
        _annotationManager: { _readOnly: false },
        setSelectedAnnotations() {
          throw new Error("Permission denied to pass object to privileged code");
        },
      },
    };

    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      getActiveReader: () => reader,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );
    const result = await tool!.execute({ comment: "你好", fontSize: 16 });

    expect(result.output).toContain("Annotation item ID: 99");
    expect(saveCount).toBe(1);
  });

  it("recovers via Notifier observation when saveFromJSON rejects after the item already landed", async () => {
    const savedByKey = new Map<string, { id: number; libraryID: number }>();
    const Z = (globalThis as any).Zotero;
    Z.Items.getByLibraryAndKey = (_libraryID: number, key: string) =>
      savedByKey.get(key) ?? false;
    Z.Annotations.saveFromJSON = async (
      _attachment: unknown,
      json: Record<string, unknown>,
    ) => {
      saveCount += 1;
      // Simulate the racy case: item is written to DB before the cross-scope
      // promise resolution chokes on the wrapped result object.
      savedByKey.set(json.key as string, { id: 250, libraryID: 1 });
      throw new Error("Permission denied to pass object to privileged code");
    };

    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );
    const result = await tool!.execute({ comment: "你好", fontSize: 16 });

    expect(result.output).toContain("Annotation item ID: 250");
    expect(saveCount).toBe(1);
  });

  it("propagates saveFromJSON errors when no item ever landed", async () => {
    const Z = (globalThis as any).Zotero;
    Z.Items.getByLibraryAndKey = () => false;
    Z.Annotations.saveFromJSON = async () => {
      saveCount += 1;
      throw new Error("Permission denied to pass object to privileged code");
    };

    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );

    await expect(
      tool!.execute({ comment: "你好", fontSize: 16 }),
    ).rejects.toThrow(/Permission denied/);
  });

  it("discovers an open Zotero Reader for the post-save UI nudge when no active reader is passed", async () => {
    let selectedIDs: string[] = [];
    const Z = (globalThis as any).Zotero;
    Z.Reader = {
      _readers: [
        {
          itemID: 2,
          _item: { id: 2 },
          _iframeWindow: {},
          _internalReader: {
            _annotationManager: { _readOnly: false },
            setSelectedAnnotations(ids: string[]) {
              selectedIDs = ids;
            },
          },
        },
      ],
    };

    const tools = createZoteroAgentTools({
      source,
      itemID: 1,
      selectionAnnotation: () => ({
        text: "Anchor text",
        attachmentID: 2,
        annotation: {
          text: "Anchor text",
          color: "#ffd400",
          pageLabel: "5",
          sortIndex: "00004|000000|00100",
          position: { pageIndex: 4, rects: [[100, 200, 220, 214]] },
        },
      }),
    });

    const tool = tools.find(
      (candidate) =>
        candidate.name === "zotero_add_text_annotation_to_selection",
    );
    const result = await tool!.execute({ comment: "你好", fontSize: 16 });

    expect(result.output).toContain("Annotation item ID: 99");
    expect(saveCount).toBe(1);
    expect(selectedIDs).toEqual(["GENKEY"]);
  });

  it("creates a full-text highlight annotation from a located passage", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      getActiveReader: () =>
        readerWithPdfText("Important contribution improves retrieval."),
    });

    const tool = session.tools.find(
      (candidate) => candidate.name === "zotero_annotate_passage",
    );
    expect(tool?.requiresApproval).toBe(true);

    const result = await tool!.execute({
      text: "Important contribution improves retrieval.",
      comment: "核心贡献句",
      color: "#ffcc00",
    });

    expect(result.summary).toBe("p.1 高亮 +5字");
    expect(result.context?.planMode).toBe("annotation_write");
    expect(savedJSON).toMatchObject({
      type: "highlight",
      text: "Important contribution improves retrieval.",
      comment: "核心贡献句",
      color: "#ffcc00",
      pageLabel: "1",
      position: { pageIndex: 0, rects: [[0, 100, 420, 110]] },
    });
    expect(savedJSON?.sortIndex).toBe("00000|000000|00110");
    session.dispose();
  });

  it("returns an error when full-text highlight has no active reader", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      getActiveReader: () => null,
    });
    const tool = session.tools.find(
      (candidate) => candidate.name === "zotero_annotate_passage",
    );

    const result = await tool!.execute({ text: "Important", comment: "note" });

    expect(result.output).toContain("No Reader/PDF.js text layer is available");
    expect(result.output).toContain("Please open the PDF in Zotero Reader");
    expect(saveCount).toBe(0);
  });

  it("validates required annotate passage arguments", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      getActiveReader: () => readerWithPdfText("Important text."),
    });
    const tool = session.tools.find(
      (candidate) => candidate.name === "zotero_annotate_passage",
    );

    await expect(tool!.execute({ comment: "note" })).resolves.toMatchObject({
      output: "zotero_annotate_passage requires a non-empty `text`.",
    });
    await expect(
      tool!.execute({ text: "Important text." }),
    ).resolves.toMatchObject({
      output: "zotero_annotate_passage requires a non-empty `comment`.",
    });
    expect(saveCount).toBe(0);
  });

  it("does not cap full-text highlight writes within one tool session", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      getActiveReader: () =>
        readerWithPdfText("First sentence. Second sentence."),
    });
    const tool = session.tools.find(
      (candidate) => candidate.name === "zotero_annotate_passage",
    );

    await tool!.execute({ text: "First sentence.", comment: "第一条" });
    const result = await tool!.execute({
      text: "Second sentence.",
      comment: "第二条",
    });

    expect(result.output).toContain("[Saved annotation #99]");
    expect(saveCount).toBe(2);
  });

  it("exposes reader-text and write tools in the default tool set", () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      getActiveReader: () => readerWithPdfText("Text."),
    });

    expect(session.tools.map((tool) => tool.name)).toEqual([
      "zotero_get_current_item",
      "zotero_get_annotations",
      "chat_get_previous_context",
      "zotero_search_pdf",
      "zotero_read_pdf_range",
      "zotero_get_full_pdf",
      "paper_search_arxiv",
      "paper_fetch_arxiv_fulltext",
      "zotero_get_reader_pdf_text",
      "zotero_get_current_pdf_selection",
      "zotero_add_text_annotation_to_selection",
      "zotero_add_annotation_to_selection",
      "zotero_annotate_passage",
      "zotero_append_to_note",
    ]);
    expect(
      session.tools.find((tool) => tool.name === "zotero_annotate_passage")
        ?.requiresApproval,
    ).toBe(true);
  });

  it("exposes full PDF truncation metadata", async () => {
    const session = createZoteroAgentToolSession({
      source: {
        ...source,
        getFullText: async () => "A".repeat(20),
      },
      itemID: 1,
      policy: {
        ...sourcePolicy(),
        fullPdfTokenBudget: 2,
      },
    });
    const tool = session.tools.find(
      (candidate) => candidate.name === "zotero_get_full_pdf",
    );

    const result = await tool!.execute({});

    expect(result.output).toContain("Chars: 8 / 20");
    expect(result.output).toContain("Truncated: yes");
    expect(result.context).toMatchObject({
      planMode: "full_pdf",
      sourceKind: "zotero_item",
      sourceID: "1",
      fullTextChars: 8,
      fullTextTotalChars: 20,
      fullTextTruncated: true,
      rangeStart: 0,
      rangeEnd: 8,
    });
  });

  it("lets the model reuse prior retained snippets without reading the PDF again", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      previousMessages: [
        {
          role: "user",
          content: "解释第三章",
          context: {
            planMode: "pdf_range",
            sourceKind: "zotero_item",
            sourceID: "1",
            sourceTitle: "Range View Paper",
            retrievedPassages: [
              {
                text: "Chapter 3 method text.",
                start: 12000,
                end: 13000,
                score: 1,
              },
            ],
          },
        },
      ],
    });
    const tool = session.tools.find(
      (candidate) => candidate.name === "chat_get_previous_context",
    );

    const result = await tool!.execute({
      sourceKind: "zotero_item",
      sourceID: "1",
      start: 11800,
      end: 14000,
    });

    expect(result.output).toContain("[Previous chat context]");
    expect(result.output).toContain("Chapter 3 method text.");
    expect(result.summary).toBe("复用历史上下文 1 段 / 22 字");
    expect(result.context).toMatchObject({
      planMode: "previous_context",
      sourceKind: "zotero_item",
      sourceID: "1",
      sourceTitle: "Range View Paper",
      retrievedPassages: [
        {
          text: "Chapter 3 method text.",
          start: 12000,
          end: 13000,
        },
      ],
    });
  });

  it("keeps cache full text separate from Reader text for annotation", async () => {
    const session = createZoteroAgentToolSession({
      source: {
        ...source,
        getFullText: async () => "cache text for ordinary summary",
      },
      itemID: 1,
      getActiveReader: () =>
        readerWithPdfText("reader text used for highlighting"),
    });
    const fullPdf = session.tools.find(
      (candidate) => candidate.name === "zotero_get_full_pdf",
    );
    const search = session.tools.find(
      (candidate) => candidate.name === "zotero_search_pdf",
    );
    const readerText = session.tools.find(
      (candidate) => candidate.name === "zotero_get_reader_pdf_text",
    );

    const fullResult = await fullPdf!.execute({});
    const searchResult = await search!.execute({
      query: "ordinary",
      topK: 1,
    });
    const readerResult = await readerText!.execute({});

    expect(fullResult.output).toContain("cache text for ordinary summary");
    expect(fullResult.output).not.toContain("reader text");
    expect(searchResult.output).toContain("cache text for ordinary summary");
    expect(readerResult.output).toContain("[Reader PDF text for annotation]");
    expect(readerResult.output).toContain("reader text used for highlighting");
    expect(readerResult.context).toMatchObject({
      planMode: "reader_pdf_text",
      fullTextChars: "reader text used for highlighting".length,
      fullTextTotalChars: "reader text used for highlighting".length,
      fullTextTruncated: false,
      rangeStart: 0,
      rangeEnd: "reader text used for highlighting".length,
    });
  });

  it("reads capped ranges from Reader text", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      policy: {
        ...sourcePolicy(),
        maxRangeChars: 4,
      },
      getActiveReader: () => readerWithPdfText("0123456789"),
    });
    const readerText = session.tools.find(
      (candidate) => candidate.name === "zotero_get_reader_pdf_text",
    );

    const result = await readerText!.execute({ start: 2, end: 9 });

    expect(result.output).toContain("Range: 2-6");
    expect(result.output).toContain("\n2345");
    expect(result.context).toMatchObject({
      planMode: "reader_pdf_text",
      rangeStart: 2,
      rangeEnd: 6,
    });
  });

  describe("zotero_append_to_note", () => {
    it("appends markdown to the child note via the injected callback and reports counts", async () => {
      const calls: string[] = [];
      const tools = createZoteroAgentTools({
        source,
        itemID: 1,
        appendToChildNote: async (content) => {
          calls.push(content);
          return { noteID: 555, created: false, usedBetterNotes: true };
        },
      });

      const tool = tools.find((t) => t.name === "zotero_append_to_note");
      expect(tool).toBeDefined();
      expect(tool!.requiresApproval).toBe(true);

      const md = "# 第一章\n\n关键观点 X 和 Y。";
      const result = await tool!.execute({ content: md });

      expect(calls).toEqual([md]);
      expect(result.summary).toContain("已追加");
      expect(result.output).toContain("Note item ID: 555");
      expect(result.output).toContain("Used Better Notes: yes");
      expect(result.context?.planMode).toBe("note_write");
    });

    it("reports note creation when the callback returns created: true", async () => {
      const tools = createZoteroAgentTools({
        source,
        itemID: 1,
        appendToChildNote: async () => ({
          noteID: 777,
          created: true,
          usedBetterNotes: false,
        }),
      });
      const tool = tools.find((t) => t.name === "zotero_append_to_note");
      const result = await tool!.execute({ content: "first ever entry" });
      expect(result.summary).toContain("已新建笔记");
      expect(result.output).toContain("Created new note: yes");
    });

    it("returns an error when no item is selected (no child-note target)", async () => {
      const tools = createZoteroAgentTools({
        source,
        itemID: null,
        appendToChildNote: async () => ({
          noteID: 1,
          created: false,
          usedBetterNotes: false,
        }),
      });
      const tool = tools.find((t) => t.name === "zotero_append_to_note");
      const result = await tool!.execute({ content: "anything" });
      expect(result.output).toContain("No Zotero item is currently selected");
    });

    it("returns an error when content is blank", async () => {
      const tools = createZoteroAgentTools({
        source,
        itemID: 1,
        appendToChildNote: async () => ({
          noteID: 1,
          created: false,
          usedBetterNotes: false,
        }),
      });
      const tool = tools.find((t) => t.name === "zotero_append_to_note");
      const result = await tool!.execute({ content: "   \n  " });
      expect(result.output).toContain("non-empty");
    });

    it("surfaces callback failures as a tool error rather than throwing", async () => {
      const tools = createZoteroAgentTools({
        source,
        itemID: 1,
        appendToChildNote: async () => {
          throw new Error("note locked");
        },
      });
      const tool = tools.find((t) => t.name === "zotero_append_to_note");
      const result = await tool!.execute({ content: "x" });
      expect(result.output).toContain("Failed to write");
      expect(result.output).toContain("note locked");
    });
  });
});

function sourcePolicy() {
  return {
    fullPdfTokenBudget: 60_000,
    searchContextTokenBudget: 100_000,
    searchCandidateCount: 8,
    maxSelectedTextChars: 20_000,
    maxPassageChars: 1200,
    passageOverlapChars: 160,
    maxRangeChars: 9000,
    maxAnnotations: 80,
    retainedContextTurnCount: 4,
    retainedContextCharBudget: 8000,
    maxSearchTopK: 8,
    maxSelectedPassages: 3,
    fullTextCacheReadCharLimit: 400_000,
    maxToolIterations: 100,
    maxAnnotationCommentChars: 4000,
    maxFullTextHighlightCommentChars: 80,
    minLocateConfidence: 0.85,
  };
}

function readerWithPdfText(text: string): unknown {
  const pdfDocument = {
    numPages: 1,
    getPageLabels: async () => ["1"],
    getPage: async () => ({
      getTextContent: async () => ({
        items: [
          {
            str: text,
            transform: [1, 0, 0, 10, 0, 100],
            width: text.length * 10,
            height: 10,
          },
        ],
      }),
    }),
  };
  return {
    itemID: 2,
    _item: { id: 2, parentID: 1 },
    _internalReader: {
      _primaryView: {
        _iframeWindow: {
          PDFViewerApplication: { pdfDocument },
        },
      },
    },
  };
}
