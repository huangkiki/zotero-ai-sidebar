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

  it("enforces the full-text highlight write quota", async () => {
    const session = createZoteroAgentToolSession({
      source,
      itemID: 1,
      policy: {
        ...sourcePolicy(),
        maxFullTextHighlights: 1,
      },
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

    expect(result.output).toContain("Highlight limit reached (1)");
    expect(saveCount).toBe(1);
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
      "zotero_search_pdf",
      "zotero_read_pdf_range",
      "zotero_get_full_pdf",
      "zotero_get_reader_pdf_text",
      "zotero_add_annotation_to_selection",
      "zotero_annotate_passage",
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
      fullTextChars: 8,
      fullTextTotalChars: 20,
      fullTextTruncated: true,
      rangeStart: 0,
      rangeEnd: 8,
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
    maxFullTextHighlights: 10,
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
