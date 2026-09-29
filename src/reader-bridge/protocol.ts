import { DEFAULT_CONTEXT_POLICY as policy } from "../context/policy";

type Args = Record<string, unknown>;
export type ExecuteTool = (name: string, args: Args) => Promise<unknown>;
export type HttpReply = [number, string, string];
export interface BridgeRequest {
  method: string;
  headers: Record<string, string>;
  data: unknown;
}

const key = { type: "string", minLength: 8, maxLength: 8 };
const page = {
  type: "integer",
  minimum: 1,
  description: "Physical PDF page, starting at 1.",
};
const text = {
  type: "string",
  minLength: 1,
  maxLength: policy.maxPassageChars,
};
const schema = (properties: Args, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const readerTools = [
  {
    name: "zotero_reader_state",
    description:
      "Read the active Zotero PDF title, attachment key, current page and page count. Call before other tools. No library-wide access.",
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "zotero_read_page",
    description:
      "Read a page directly from the active Reader text layer, including its saved highlights. Copy passages from this output before highlighting. Omit page for the current page.",
    inputSchema: schema({ expectedAttachmentKey: key, page }, [
      "expectedAttachmentKey",
    ]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "zotero_find_passage",
    description:
      "Locate a verbatim passage in the active PDF without navigating or writing. Optionally restrict to a page. Returns matched text, page and rectangles.",
    inputSchema: schema({ expectedAttachmentKey: key, text, page }, [
      "expectedAttachmentKey",
      "text",
    ]),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "zotero_navigate",
    description:
      "Move the active Zotero Reader to the requested physical PDF page. Requires the attachment key obtained from reader_state.",
    inputSchema: schema({ expectedAttachmentKey: key, page }, [
      "expectedAttachmentKey",
      "page",
    ]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "zotero_highlight",
    description:
      "Save a highlight on an exact passage read from zotero_read_page, with a brief reading note. Only call when the user has explicitly authorized highlighting; set approved=true to attest that authorization. Requires an exact normalized match on the specified page. Existing identical highlights are reused.",
    inputSchema: schema(
      {
        expectedAttachmentKey: key,
        page,
        text,
        comment: {
          type: "string",
          minLength: 1,
          maxLength: policy.maxFullTextHighlightCommentChars,
        },
        color: {
          type: "string",
          pattern: "^#[0-9a-fA-F]{6}$",
          default: "#ffd400",
        },
        approved: { type: "boolean", const: true },
      },
      ["expectedAttachmentKey", "page", "text", "comment", "approved"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function object(value: unknown): value is Args {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// The same declared contracts drive runtime validation; unknown fields are errors.
export function validateArgs(name: string, value: unknown): Args {
  const tool = readerTools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!object(value)) throw new Error("Tool arguments must be an object.");
  for (const required of tool.inputSchema.required) {
    if (!(required in value)) throw new Error(`Missing argument: ${required}`);
  }
  for (const [field, input] of Object.entries(value)) {
    const rule = tool.inputSchema.properties[field] as Args | undefined;
    if (!rule) throw new Error(`Unknown argument: ${field}`);
    if (
      rule.type === "string" &&
      (typeof input !== "string" ||
        !input.trim() ||
        (typeof rule.minLength === "number" && input.length < rule.minLength) ||
        (typeof rule.maxLength === "number" && input.length > rule.maxLength) ||
        (typeof rule.pattern === "string" &&
          !new RegExp(rule.pattern).test(input)))
    )
      throw new Error(`Invalid string argument: ${field}`);
    if (
      rule.type === "integer" &&
      (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    ) {
      throw new Error(`Invalid page: ${field}`);
    }
    if (rule.type === "boolean" && input !== true)
      throw new Error(
        "Highlighting requires explicit user authorization (approved=true).",
      );
  }
  return value;
}

// Stateless Streamable HTTP MCP. The secret never appears in tool output.
export function createHandler(
  token: string,
  port: number,
  execute: ExecuteTool,
) {
  return async (request: BridgeRequest): Promise<HttpReply> => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (
      "origin" in headers ||
      ![`127.0.0.1:${port}`, `localhost:${port}`].includes(headers.host) ||
      headers.authorization !== `Bearer ${token}`
    ) {
      return [403, "text/plain", "Forbidden"];
    }
    if (request.method !== "POST") return [405, "text/plain", "POST required"];
    const input = request.data;
    const id =
      object(input) &&
      (typeof input.id === "string" || typeof input.id === "number")
        ? input.id
        : null;
    const reply = (result: unknown): HttpReply => [
      200,
      "application/json",
      JSON.stringify({ jsonrpc: "2.0", id, result }),
    ];
    const error = (code: number, message: string): HttpReply => [
      200,
      "application/json",
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    ];
    if (
      !object(input) ||
      input.jsonrpc !== "2.0" ||
      typeof input.method !== "string"
    )
      return error(-32600, "Invalid Request");
    if (!("id" in input)) return [202, "text/plain", ""];
    if (id === null) return error(-32600, "Invalid request id");
    switch (input.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "zotero-ai-sidebar-reader", version: "0.1.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: readerTools });
      case "tools/call": {
        const params = input.params;
        if (!object(params) || typeof params.name !== "string")
          return error(-32602, "Invalid tool parameters");
        if (!readerTools.some((tool) => tool.name === params.name))
          return error(-32602, "Unknown tool");
        try {
          const args = validateArgs(params.name, params.arguments ?? {});
          const result = await execute(params.name, args);
          return reply({
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        } catch (cause) {
          return reply({
            isError: true,
            content: [
              {
                type: "text",
                text: cause instanceof Error ? cause.message : String(cause),
              },
            ],
          });
        }
      }
      default:
        return error(-32601, "Method not found");
    }
  };
}
