import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperTools } from "../../src/context/paper-tools";
import type { ContextPolicy } from "../../src/context/policy";

const policy: ContextPolicy = {
  fullPdfTokenBudget: 20,
  searchContextTokenBudget: 100_000,
  searchCandidateCount: 8,
  maxSelectedTextChars: 20_000,
  maxPassageChars: 1200,
  passageOverlapChars: 160,
  maxRangeChars: 12,
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

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1506.02640v5</id>
    <updated>2016-05-09T00:00:00Z</updated>
    <published>2015-06-08T00:00:00Z</published>
    <title>You Only Look Once: Unified, Real-Time Object Detection</title>
    <summary>We present YOLO, a unified object detector.</summary>
    <author><name>Joseph Redmon</name></author>
    <author><name>Ali Farhadi</name></author>
    <link href="http://arxiv.org/abs/1506.02640v5" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1506.02640v5" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

const html = `<!doctype html><html><body><article>
  <h1>YOLO</h1>
  <p>Introduction text.</p>
  <p>Method text describes unified detection.</p>
</article></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paper tools", () => {
  it("searches arXiv metadata from a paper title", async () => {
    mockFetch([atom]);
    const search = createPaperTools(policy).find(
      (tool) => tool.name === "paper_search_arxiv",
    );

    const result = await search!.execute({ query: "YOLO object detection" });

    expect(result.output).toContain("[arXiv search results]");
    expect(result.output).toContain("arXiv ID: 1506.02640");
    expect(result.summary).toBe("arXiv 搜索返回 1 篇");
    expect(result.context).toMatchObject({
      planMode: "remote_paper",
      sourceKind: "arxiv",
      sourceID: "1506.02640",
      sourceTitle: "You Only Look Once: Unified, Real-Time Object Detection",
      query: "YOLO object detection",
      candidatePassageCount: 1,
    });
  });

  it("fetches ar5iv text for an arXiv PDF URL", async () => {
    mockFetch([atom, html]);
    const fetchTool = createPaperTools(policy).find(
      (tool) => tool.name === "paper_fetch_arxiv_fulltext",
    );

    const result = await fetchTool!.execute({
      queryOrUrl: "https://arxiv.org/pdf/1506.02640",
    });

    expect(result.output).toContain("[arXiv paper text]");
    expect(result.output).toContain("Source: ar5iv HTML");
    expect(result.output).toContain("Method text describes unified detection.");
    expect(result.summary).toContain("读取 arXiv:1506.02640");
    expect(result.context).toMatchObject({
      planMode: "remote_paper",
      sourceKind: "arxiv",
      sourceID: "1506.02640",
      sourceTitle: "You Only Look Once: Unified, Real-Time Object Detection",
      sourceUrl: "http://arxiv.org/pdf/1506.02640v5",
      query: "https://arxiv.org/pdf/1506.02640",
      fullTextTruncated: false,
      rangeStart: 0,
    });
  });

  it("reads a bounded remote paper range", async () => {
    mockFetch([atom, html]);
    const fetchTool = createPaperTools(policy).find(
      (tool) => tool.name === "paper_fetch_arxiv_fulltext",
    );

    const result = await fetchTool!.execute({
      queryOrUrl: "1506.02640",
      start: 6,
      end: 40,
    });

    expect(result.output).toContain("Range: 6-18");
    expect(result.context).toMatchObject({
      planMode: "remote_paper",
      rangeStart: 6,
      rangeEnd: 18,
    });
  });
});

function mockFetch(bodies: string[]) {
  const queue = bodies.slice();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = queue.shift();
      if (body == null) throw new Error("unexpected fetch");
      return {
        ok: true,
        text: async () => body,
      } as Response;
    }),
  );
}
