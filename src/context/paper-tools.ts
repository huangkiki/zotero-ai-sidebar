import type { AgentTool, ToolExecutionResult } from "../providers/types";
import type { ContextPolicy } from "./policy";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const AR5IV_HTML_BASE = "https://ar5iv.labs.arxiv.org/html";
const DEFAULT_SEARCH_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 25_000;

interface ArxivEntry {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  absUrl: string;
  pdfUrl: string;
}

export function createPaperTools(policy: ContextPolicy): AgentTool[] {
  return [
    {
      name: "paper_search_arxiv",
      description:
        "Search arXiv by paper title, natural-language query, DOI-like text, or arXiv URL/ID. Use when the user names a paper but the exact arXiv ID or PDF URL is not known. Returns metadata and PDF URLs; it does not read the full paper body.",
      parameters: objectSchema(
        {
          query: stringSchema("Paper title, topic, arXiv URL, or arXiv ID."),
          maxResults: numberSchema(
            "Maximum candidates to return. The harness clamps this to 1-10.",
          ),
        },
        ["query"],
      ),
      execute: async (args) => {
        const parsed = objectArgs(args);
        const query = stringArg(parsed, "query");
        if (!query) return errorResult("paper_search_arxiv requires query.");
        const maxResults = clamp(
          Math.floor(numberArg(parsed, "maxResults") ?? DEFAULT_SEARCH_RESULTS),
          1,
          10,
        );
        const entries = await searchArxiv(query, maxResults);
        if (!entries.length) {
          return errorResult(`No arXiv papers found for: ${query}`);
        }
        return {
          output: formatSearchResults(entries),
          summary: `arXiv 搜索返回 ${entries.length} 篇`,
          context: {
            planMode: "remote_paper",
            sourceKind: "arxiv",
            sourceID: entries.map((entry) => entry.id).join(","),
            ...(entries.length === 1
              ? {
                  sourceTitle: entries[0].title,
                  sourceUrl: entries[0].pdfUrl,
                }
              : {}),
            query,
            candidatePassageCount: entries.length,
          },
        };
      },
    },
    {
      name: "paper_fetch_arxiv_fulltext",
      description:
        "Fetch readable full text for an arXiv paper from an arXiv URL/ID, PDF URL, or paper title/query. Use when the user asks to summarize or analyze a paper that is not necessarily the current Zotero item. The model decides when to call this tool; the harness only resolves arXiv metadata and reads ar5iv HTML text. Optional start/end read a bounded character range from the remote paper text.",
      parameters: objectSchema(
        {
          queryOrUrl: stringSchema(
            "arXiv abs/PDF URL, arXiv ID, or paper title/query.",
          ),
          start: numberSchema(
            "Optional zero-based start character offset from a previous result.",
          ),
          end: numberSchema("Optional end character offset."),
        },
        ["queryOrUrl"],
      ),
      execute: async (args) => {
        const parsed = objectArgs(args);
        const queryOrUrl = stringArg(parsed, "queryOrUrl");
        if (!queryOrUrl) {
          return errorResult("paper_fetch_arxiv_fulltext requires queryOrUrl.");
        }
        const entry = await resolveArxivEntry(queryOrUrl);
        if (!entry) return errorResult(`No arXiv paper found for: ${queryOrUrl}`);
        const fullText = await fetchArxivReadableText(entry.id);
        const sourceText = fullText || entry.summary;
        if (!sourceText) {
          return errorResult(`No readable text found for arXiv:${entry.id}`);
        }
        const slice = remoteTextSlice(sourceText, parsed, policy);
        if (!slice) {
          return errorResult(
            "paper_fetch_arxiv_fulltext requires both numeric start and end when either range field is provided, and the range must be valid.",
          );
        }
        const truncated = slice.end < sourceText.length;
        return {
          output: formatFullTextResult(entry, slice, sourceText.length, !!fullText),
          summary: `读取 arXiv:${entry.id} ${slice.text.length}/${sourceText.length} 字`,
          context: {
            planMode: "remote_paper",
            sourceKind: "arxiv",
            sourceID: entry.id,
            sourceTitle: entry.title,
            sourceUrl: entry.pdfUrl,
            query: queryOrUrl,
            fullTextChars: slice.text.length,
            fullTextTotalChars: sourceText.length,
            fullTextTruncated: truncated,
            rangeStart: slice.start,
            rangeEnd: slice.end,
          },
        };
      },
    },
  ];
}

async function resolveArxivEntry(queryOrUrl: string): Promise<ArxivEntry | null> {
  const id = extractArxivID(queryOrUrl);
  const entries = await searchArxiv(id || queryOrUrl, 1);
  return entries[0] ?? null;
}

async function searchArxiv(queryOrUrl: string, maxResults: number): Promise<ArxivEntry[]> {
  const id = extractArxivID(queryOrUrl);
  const params = new URLSearchParams({
    start: "0",
    max_results: String(maxResults),
  });
  if (id) {
    params.set("id_list", id);
  } else {
    params.set("search_query", `all:${queryOrUrl}`);
    params.set("sortBy", "relevance");
    params.set("sortOrder", "descending");
  }
  const xml = await httpGetText(`${ARXIV_API_URL}?${params.toString()}`);
  return parseArxivAtom(xml);
}

async function fetchArxivReadableText(id: string): Promise<string> {
  try {
    const html = await httpGetText(`${AR5IV_HTML_BASE}/${encodeURIComponent(id)}`);
    return htmlToText(html);
  } catch {
    return "";
  }
}

async function httpGetText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/atom+xml,text/html,text/plain,*/*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseArxivAtom(xml: string): ArxivEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const entries = Array.from(
    doc.getElementsByTagName("entry") as unknown as Element[],
  );
  return entries.map((entry) => {
    const absUrl = textOf(entry, "id");
    const id = extractArxivID(absUrl) || absUrl.split("/").pop() || "";
    const links = Array.from(
      entry.getElementsByTagName("link") as unknown as Element[],
    );
    const pdfUrl =
      links
        .map((link) => ({
          title: link.getAttribute("title") || "",
          type: link.getAttribute("type") || "",
          href: link.getAttribute("href") || "",
        }))
        .find((link) => link.title === "pdf" || link.type === "application/pdf")
        ?.href || `https://arxiv.org/pdf/${id}`;
    return {
      id,
      title: normalizeText(textOf(entry, "title")),
      authors: Array.from(
        entry.getElementsByTagName("author") as unknown as Element[],
      )
        .map((author) => normalizeText(textOf(author, "name")))
        .filter(Boolean),
      summary: normalizeText(textOf(entry, "summary")),
      published: textOf(entry, "published"),
      updated: textOf(entry, "updated"),
      absUrl,
      pdfUrl,
    };
  });
}

function textOf(element: Element, tagName: string): string {
  return element.getElementsByTagName(tagName)[0]?.textContent?.trim() ?? "";
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script, style, noscript, nav, header, footer, annotation-xml")
    .forEach((node: Element) => node.remove());
  const body = doc.querySelector("article") ?? doc.body;
  return normalizeText(body?.textContent ?? "");
}

function formatSearchResults(entries: ArxivEntry[]): string {
  return [
    "[arXiv search results]",
    ...entries.map((entry, index) =>
      [
        `#${index + 1}`,
        `Title: ${entry.title}`,
        `arXiv ID: ${entry.id}`,
        `Authors: ${entry.authors.slice(0, 8).join(", ")}`,
        `Published: ${entry.published}`,
        `Abs URL: ${entry.absUrl}`,
        `PDF URL: ${entry.pdfUrl}`,
        `Abstract: ${entry.summary}`,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function formatFullTextResult(
  entry: ArxivEntry,
  slice: { start: number; end: number; text: string },
  totalChars: number,
  hasFullText: boolean,
): string {
  return [
    "[arXiv paper text]",
    `Title: ${entry.title}`,
    `arXiv ID: ${entry.id}`,
    `Authors: ${entry.authors.join(", ")}`,
    `Published: ${entry.published}`,
    `Abs URL: ${entry.absUrl}`,
    `PDF URL: ${entry.pdfUrl}`,
    `Source: ${hasFullText ? "ar5iv HTML" : "arXiv abstract fallback"}`,
    `Chars: ${slice.text.length} / ${totalChars}`,
    `Truncated: ${slice.end < totalChars ? "yes" : "no"}`,
    `Range: ${slice.start}-${slice.end}`,
    "",
    slice.text,
  ].join("\n");
}

function remoteTextSlice(
  text: string,
  args: Record<string, unknown>,
  policy: ContextPolicy,
): { start: number; end: number; text: string } | null {
  const startArg = numberArg(args, "start");
  const endArg = numberArg(args, "end");
  const hasStart = startArg != null;
  const hasEnd = endArg != null;
  if (hasStart !== hasEnd) return null;

  if (!hasStart && !hasEnd) {
    const end = Math.min(text.length, policy.fullPdfTokenBudget * 4);
    return { start: 0, end, text: text.slice(0, end) };
  }
  if (startArg == null || endArg == null) return null;
  const start = Math.floor(startArg);
  const requestedEnd = Math.floor(endArg);
  if (start !== startArg || requestedEnd !== endArg) return null;
  if (start < 0 || requestedEnd <= start || start >= text.length) return null;
  const end = Math.min(requestedEnd, start + policy.maxRangeChars, text.length);
  return { start, end, text: text.slice(start, end) };
}

function extractArxivID(value: string): string {
  const normalized = value.trim();
  const modern = normalized.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?/i);
  if (modern) return modern[1];
  const oldStyle = normalized.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?/i);
  return oldStyle?.[1] ?? "";
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): { [key: string]: unknown } {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): { [key: string]: unknown } {
  return { type: "string", description };
}

function numberSchema(description: string): { [key: string]: unknown } {
  return { type: "number", description };
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function errorResult(output: string): ToolExecutionResult {
  return { output, summary: output };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
