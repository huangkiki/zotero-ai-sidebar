import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexSession,
  CodexProvider,
  codexInput,
  readCodexAccount,
  windowsDesktopCodexCandidates,
  type CodexProcess,
} from "../../src/providers/codex";
import { hasPresetAuth, type ModelPreset } from "../../src/settings/types";
import { normalizePresetList } from "../../src/settings/storage";

function fakeProcess() {
  const chunks: Array<string | null> = [];
  let waiter: ((value: string | null) => void) | undefined;
  const push = (value: string | null) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(value);
    } else chunks.push(value);
  };
  const process: CodexProcess = {
    stdin: { write: vi.fn(async () => undefined) },
    stdout: {
      readString: () =>
        chunks.length
          ? Promise.resolve(chunks.shift()!)
          : new Promise((resolve) => {
              waiter = resolve;
            }),
    },
    kill: vi.fn(() => push(null)),
  };
  return {
    process,
    push,
    send: (v: unknown) => push(JSON.stringify(v) + "\n"),
  };
}
const sessions: CodexSession[] = [];
afterEach(() => {
  sessions.forEach((s) => s.close());
  sessions.length = 0;
  vi.unstubAllGlobals();
});
function fixture() {
  const f = fakeProcess();
  const session = new CodexSession(f.process);
  sessions.push(session);
  return { ...f, session };
}
const preset: ModelPreset = {
  id: "local",
  provider: "codex",
  label: "Local ChatGPT",
  apiKey: "",
  baseUrl: "",
  model: "test-model",
  maxTokens: 512,
};

describe("Codex local account adapter", () => {
  it("discovers the versioned Codex executable bundled with the Windows desktop app", async () => {
    const listChildren = vi.fn(async () => [
      "C:\\Users\\Me\\AppData\\Local\\OpenAI\\Codex\\bin\\version-a",
      "C:\\Users\\Me\\AppData\\Local\\OpenAI\\Codex\\bin\\version-b",
    ]);
    await expect(
      windowsDesktopCodexCandidates(
        "C:\\Users\\Me\\AppData\\Local",
        listChildren,
      ),
    ).resolves.toEqual([
      "C:\\Users\\Me\\AppData\\Local\\OpenAI\\Codex\\bin\\version-a\\codex.exe",
      "C:\\Users\\Me\\AppData\\Local\\OpenAI\\Codex\\bin\\version-b\\codex.exe",
    ]);
    expect(listChildren).toHaveBeenCalledWith(
      "C:\\Users\\Me\\AppData\\Local\\OpenAI\\Codex\\bin",
    );
  });
  it("accepts local presets without API credentials and preserves them through storage", () => {
    expect(hasPresetAuth(preset)).toBe(true);
    expect(hasPresetAuth({ ...preset, provider: "openai" })).toBe(false);
    expect(hasPresetAuth(null)).toBe(false);
    expect(normalizePresetList([preset])[0].provider).toBe("codex");
  });
  it("parses split and batched protocol frames, matching request IDs", async () => {
    const f = fixture();
    const a = f.session.request("first");
    const b = f.session.request("second");
    f.push('{"id":2,"res');
    f.push('ult":"two"}\n{"id":1,"result":"one"}\n');
    expect(await a).toBe("one");
    expect(await b).toBe("two");
  });
  it("propagates protocol errors", async () => {
    const f = fixture();
    const request = f.session.request("bad");
    f.send({ id: 1, error: { message: "Login expired" } });
    await expect(request).rejects.toThrow("Login expired");
  });
  it("rejects pending requests when the process exits", async () => {
    const f = fixture();
    const request = f.session.request("pending");
    f.push(null);
    await expect(request).rejects.toThrow("连接已关闭");
  });
  it("cancels pending requests and readers on close", async () => {
    const f = fixture();
    const request = f.session.request("pending");
    const event = f.session.event();
    f.session.close(new Error("cancelled"));
    await expect(request).rejects.toThrow("cancelled");
    await expect(event).rejects.toThrow("cancelled");
    expect(f.process.kill).toHaveBeenCalledOnce();
  });
  it("never grants native tool approval requests", async () => {
    const f = fixture();
    f.send({
      id: 33,
      method: "item/commandExecution/requestApproval",
      params: {},
    });
    await vi.waitFor(() => expect(f.process.stdin.write).toHaveBeenCalled());
    const response = JSON.parse(
      vi.mocked(f.process.stdin.write).mock.calls[0][0],
    );
    expect(response.id).toBe(33);
    expect(response.error.code).toBe(-32601);
  });
  it("requires a ChatGPT account rather than accepting API-key auth", async () => {
    const f = fixture();
    const request = readCodexAccount(f.session);
    f.send({ id: 1, result: { account: { type: "apiKey" } } });
    await expect(request).rejects.toThrow("codex login");
  });
  it("reads account status without reading or exposing tokens", async () => {
    const f = fixture();
    const request = readCodexAccount(f.session);
    f.send({
      id: 1,
      result: { account: { type: "chatgpt", planType: "test" } },
    });
    expect((await request).type).toBe("chatgpt");
    expect(
      JSON.parse(vi.mocked(f.process.stdin.write).mock.calls[0][0]).params,
    ).toEqual({ refreshToken: false });
  });
  it("carries conversation history and image input to the model", () => {
    const result = codexInput([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
      {
        role: "user",
        content: "Follow up",
        images: [
          {
            id: "i",
            name: "figure",
            mediaType: "image/png",
            dataUrl: "data:image/png;base64,abc",
            size: 3,
          },
        ],
      },
    ]);
    expect(result[0].text).toContain("Answer");
    expect(result[0].text).toContain("Follow up");
    expect(result[1]).toEqual({
      type: "image",
      url: "data:image/png;base64,abc",
    });
  });
  it("uses English role wrappers and instructions in English interface mode", () => {
    vi.stubGlobal("Zotero", { Prefs: { get: () => "en-US" } });
    const result = codexInput([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
    expect(result[0].text).toContain("Zotero research chat history");
    expect(result[0].text).toContain("User:\nQuestion");
    expect(result[0].text).toContain("Assistant:\nAnswer");
    expect(result[0].text).not.toMatch(/[用户助手]：/u);
  });
  it("streams output, ignores another thread, and cleans up on completion", async () => {
    const f = fakeProcess();
    vi.mocked(f.process.stdin.write).mockImplementation(async (line) => {
      const p = JSON.parse(line);
      const responses: Record<string, unknown> = {
        initialize: {},
        "account/read": { account: { type: "chatgpt" } },
        "thread/start": { thread: { id: "t" } },
        "turn/start": { turn: { id: "u" } },
      };
      if (p.id) f.send({ id: p.id, result: responses[p.method] });
      if (p.method === "turn/start") {
        f.send({
          method: "item/agentMessage/delta",
          params: { threadId: "other", turnId: "u", delta: "ignore" },
        });
        f.send({
          method: "item/agentMessage/delta",
          params: { threadId: "t", turnId: "u", delta: "OK" },
        });
        f.send({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "u", status: "completed" } },
        });
      }
    });
    vi.stubGlobal("ChromeUtils", {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async () => "/fake",
          call: async () => f.process,
        },
      }),
    });
    const results = [];
    for await (const chunk of new CodexProvider().stream(
      [{ role: "user", content: "Hi" }],
      "system",
      preset,
      new AbortController().signal,
    ))
      results.push(chunk);
    expect(results.filter((c) => c.type === "text_delta")).toEqual([
      { type: "text_delta", text: "OK" },
    ]);
    expect(f.process.kill).toHaveBeenCalledOnce();
  });
});

describe("Zotero dynamic tools through Codex", () => {
  it.each([
    {
      name: "retrieves paper text",
      write: false,
      mode: "default",
      shouldRun: true,
    },
    {
      name: "refuses unapproved annotation writes",
      write: true,
      mode: "default",
      shouldRun: false,
    },
    {
      name: "writes annotations in YOLO mode",
      write: true,
      mode: "yolo",
      shouldRun: true,
    },
  ] as const)("$name", async ({ write, mode, shouldRun }) => {
    const f = fakeProcess();
    const execute = vi.fn(async () => ({
      output: "paper evidence",
      summary: "Evidence loaded",
      context: { planMode: "full_pdf" as const, fullTextChars: 14 },
    }));
    let toolReply: any;
    let declaration: any;
    vi.mocked(f.process.stdin.write).mockImplementation(async (line) => {
      const p = JSON.parse(line);
      if (p.method === "thread/start") declaration = p.params.dynamicTools;
      const responses: Record<string, unknown> = {
        initialize: {},
        "account/read": { account: { type: "chatgpt" } },
        "thread/start": { thread: { id: "t" } },
        "turn/start": { turn: { id: "u" } },
      };
      if (p.method && p.id) f.send({ id: p.id, result: responses[p.method] });
      if (p.method === "turn/start")
        f.send({
          id: 900,
          method: "item/tool/call",
          params: {
            threadId: "t",
            turnId: "u",
            callId: "call1",
            tool: "zotero_get_full_pdf",
            arguments: {},
          },
        });
      if (p.id === 900 && p.result) {
        toolReply = p.result;
        f.send({
          method: "item/agentMessage/delta",
          params: { threadId: "t", turnId: "u", delta: "Done" },
        });
        f.send({
          method: "turn/completed",
          params: { threadId: "t", turn: { id: "u", status: "completed" } },
        });
      }
    });
    vi.stubGlobal("ChromeUtils", {
      importESModule: () => ({
        Subprocess: {
          pathSearch: async () => "/fake",
          call: async () => f.process,
        },
      }),
    });
    const chunks = [];
    for await (const c of new CodexProvider().stream(
      [{ role: "user", content: "Read paper" }],
      "system",
      preset,
      new AbortController().signal,
      {
        permissionMode: mode,
        tools: [
          {
            name: "zotero_get_full_pdf",
            description: "Read paper",
            parameters: { type: "object", properties: {} },
            requiresApproval: write,
            execute,
          },
        ],
      },
    ))
      chunks.push(c);
    expect(declaration[0]).toMatchObject({
      type: "function",
      name: "zotero_get_full_pdf",
      inputSchema: { type: "object" },
    });
    expect(execute).toHaveBeenCalledTimes(shouldRun ? 1 : 0);
    expect(toolReply.success).toBe(shouldRun);
    expect(toolReply.contentItems[0].type).toBe("inputText");
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        status: shouldRun ? "completed" : "error",
      }),
    );
    if (shouldRun)
      expect(chunks).toContainEqual(
        expect.objectContaining({
          context: { planMode: "full_pdf", fullTextChars: 14 },
        }),
      );
    expect(f.process.kill).toHaveBeenCalledOnce();
  });
});
