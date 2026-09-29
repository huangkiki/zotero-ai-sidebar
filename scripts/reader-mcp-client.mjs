/* global fetch, AbortSignal */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import process from "node:process";
import { URL } from "node:url";

const [profileFlag, profile, tool, rawArgs = "{}"] = process.argv.slice(2);
if (profileFlag !== "--profile" || !profile || !tool) {
  process.stderr.write(
    "Usage: node scripts/reader-mcp-client.mjs --profile PROFILE (--stdio | TOOL [JSON_ARGS])\n",
  );
  process.exit(1);
}

async function send(message) {
  const config = JSON.parse(
    await readFile(
      resolve(profile, "zai-reader-bridge/connection.json"),
      "utf8",
    ),
  );
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/zai/reader-mcp" ||
    !/^[a-f0-9]{64}$/.test(config.token)
  ) {
    throw new Error("Invalid local Reader bridge connection file.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 202) return undefined;
  if (!response.ok)
    throw new Error(`Reader bridge returned HTTP ${response.status}`);
  return response.json();
}

if (tool === "--stdio") {
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
      const response = await send(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      if (request && !("id" in request)) continue;
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32000, message: error.message } })}\n`,
      );
    }
  }
} else {
  try {
    const response = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: JSON.parse(rawArgs) },
    });
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    if (response?.error || response?.result?.isError) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
