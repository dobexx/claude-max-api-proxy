/**
 * Deterministic tests for native client-tool runs (TOOL_MODE=mcp).
 *
 * Uses a fake Claude CLI (CLAUDE_BIN) that behaves like the real one in the
 * spike: it streams text + tool_use blocks as stream-json, stops with
 * stop_reason "tool_use", calls the MCP bridge (tools/call, sequentially,
 * with _meta["claudecode/toolUseId"]) and continues once results arrive.
 * No Claude subscription tokens are used.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "./index.js";
import { initApiKey } from "./auth.js";
import { stopBridge } from "../mcp/bridge.js";

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const mcpIdx = args.indexOf("--mcp-config");
const cfg = mcpIdx >= 0 ? JSON.parse(fs.readFileSync(args[mcpIdx + 1], "utf8")).mcpServers.client : null;
const streamJsonIn = args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json";
let prompt = "";
let imageTypes = [];
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  // Flag probe (--print with empty stdin): behave like the real CLI
  if (!prompt.trim()) {
    process.stderr.write("Error: Input must be provided either through stdin or as a prompt argument when using --print\n");
    process.exit(1);
  }
  if (streamJsonIn) {
    const msg = JSON.parse(prompt.trim().split("\n")[0]);
    const blocks = msg.message.content;
    imageTypes = blocks.filter((b) => b.type === "image").map((b) => b.source.media_type);
    prompt = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  if (!cfg) return plain();
  main();
});

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event) => out({ type: "stream_event", event, session_id: "s", uuid: "u" });

// No MCP config (no client tools): echo what arrived, incl. inline images
function plain() {
  const text = "PLAIN images=" + (imageTypes.join(",") || "none") + " note=" + (prompt.includes("could not be passed on") ? "yes" : "no");
  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1,
        usage: { input_tokens: 3, output_tokens: 2 }, session_id: "s" });
}

async function rpc(method, params, id) {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { ...cfg.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop() || text;
  return JSON.parse(data);
}

function toolBlock(index, id, name, args) {
  ev({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
  const json = JSON.stringify(args);
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
  ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
  ev({ type: "content_block_stop", index });
}

async function main() {
  // Fallback path: history replayed as text after a run was abandoned
  if (prompt.includes("<tool_result")) {
    const final = "REPLAY:" + (prompt.includes("spaet geliefert") ? "ok" : "missing");
    ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 5, output_tokens: 0 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: final } });
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
    out({ type: "result", subtype: "success", is_error: false, result: final, num_turns: 1,
          usage: { input_tokens: 5, output_tokens: 2 }, session_id: "s" });
    return;
  }
  const list = await rpc("tools/list", {}, 1);
  const tool = "mcp__client__" + list.result.tools[0].name;
  const two = prompt.includes("TWO");
  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 10, output_tokens: 0 } } });
  if (args.includes("--thinking-display")) {
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Erst das Tool, " } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "dann antworten." } });
    ev({ type: "content_block_stop", index: 0 });
  }
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ich " } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "schaue nach." } });
  ev({ type: "content_block_stop", index: 0 });
  const calls = [["toolu_01AAA", { city: "Berlin" }]];
  if (two) calls.push(["toolu_01BBB", { city: "Koeln" }]);
  calls.forEach(([id, a], i) => toolBlock(i + 1, id, tool, a));
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } });
  ev({ type: "message_stop" });

  const results = [];
  for (let i = 0; i < calls.length; i++) {
    const [id, a] = calls[i];
    const r = await rpc("tools/call", { name: list.result.tools[0].name, arguments: a, _meta: { "claudecode/toolUseId": id } }, 10 + i);
    results.push(r.result.content[0].text);
  }

  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 20, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const final = "Ergebnis: " + results.join(" | ") + (imageTypes.length ? " [images:" + imageTypes.join(",") + "]" : "");
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: final } });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  ev({ type: "message_stop" });
  out({ type: "result", subtype: "success", is_error: false, result: final, num_turns: 2,
        usage: { input_tokens: 30, output_tokens: 12 }, session_id: "s" });
}
`;

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
}];

let baseUrl: string;
let server: Server;
let tmpDir: string;
const savedEnv = { ...process.env };

// 1x1 transparent PNG
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-fakecli-"));
  const bin = path.join(tmpDir, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  // Fake CLI ignores credentials, but the proxy checks they exist
  const cfgDir = path.join(tmpDir, "claude-config");
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, ".credentials.json"), "{}");
  process.env.CLAUDE_BIN = bin;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  process.env.PROXY_API_KEY = "off";
  process.env.TOOL_MODE = "mcp";
  initApiKey();
  server = await startServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await stopServer();
  await stopBridge();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = savedEnv;
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Parse an SSE body into chunk objects (ignores comments and [DONE]) */
async function readChunks(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

function collect(chunks: any[]) {
  let content = "";
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  let finish: string | null = null;
  for (const c of chunks) {
    const ch = c.choices?.[0];
    if (!ch) continue;
    if (ch.delta?.content) content += ch.delta.content;
    for (const tc of ch.delta?.tool_calls || []) {
      if (tc.id) calls[tc.index] = { id: tc.id, name: tc.function.name, arguments: "" };
      if (tc.function?.arguments) calls[tc.index].arguments += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  return { content, calls, finish };
}

describe("native client tools via MCP", { timeout: 30_000 }, () => {
  it("passes images inline together with client tools", async () => {
    const messages: any[] = [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
        { type: "text", text: "Was siehst du? Nutze das Tool." },
      ],
    }];
    const r1 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t1 = collect(await readChunks(r1));
    assert.equal(t1.finish, "tool_calls");
    messages.push(
      { role: "assistant", content: null, tool_calls: t1.calls.map((c) => ({
        id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      { role: "tool", tool_call_id: t1.calls[0].id, content: "ok" }
    );
    const r2 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t2 = collect(await readChunks(r2));
    assert.equal(t2.content, "Ergebnis: ok [images:image/png]");
  });

  it("passes images inline without tools and sniffs the real type", async () => {
    // Declared as jpeg, actually PNG: the media_type must follow the bytes
    const r = await post({ model: "haiku", messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${TINY_PNG}` } },
        { type: "text", text: "Bild?" },
      ],
    }] });
    const b = (await r.json()) as any;
    assert.equal(b.choices[0].message.content, "PLAIN images=image/png note=no");
  });

  it("skips unsupported image formats and tells the model", async () => {
    const heicLike = Buffer.from("0000001866747970686569630000", "hex").toString("base64");
    const r = await post({ model: "haiku", messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/heic;base64,${heicLike}` } },
        { type: "text", text: "Bild?" },
      ],
    }] });
    const b = (await r.json()) as any;
    assert.equal(b.choices[0].message.content, "PLAIN images=none note=yes");
  });

  it("streams text and tool_calls, then continues the same run with the results", async () => {
    const messages: any[] = [{ role: "user", content: "Wetter in Berlin?" }];

    const r1 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t1 = collect(await readChunks(r1));
    assert.equal(t1.content, "Ich schaue nach.");
    assert.equal(t1.finish, "tool_calls");
    assert.equal(t1.calls.length, 1);
    assert.equal(t1.calls[0].id, "call_01AAA");
    assert.equal(t1.calls[0].name, "get_weather");
    assert.deepEqual(JSON.parse(t1.calls[0].arguments), { city: "Berlin" });

    messages.push(
      { role: "assistant", content: t1.content, tool_calls: t1.calls.map((c) => ({
        id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      { role: "tool", tool_call_id: "call_01AAA", content: "Berlin: 13 Grad, Regen" }
    );
    const r2 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t2 = collect(await readChunks(r2));
    assert.equal(t2.finish, "stop");
    assert.equal(t2.content, "Ergebnis: Berlin: 13 Grad, Regen");
  });

  it("handles two tool calls in one turn (CLI asks for them sequentially)", async () => {
    const messages: any[] = [{ role: "user", content: "TWO cities please" }];
    const r1 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t1 = collect(await readChunks(r1));
    assert.equal(t1.finish, "tool_calls");
    assert.deepEqual(t1.calls.map((c) => c.id), ["call_01AAA", "call_01BBB"]);

    messages.push(
      { role: "assistant", content: null, tool_calls: t1.calls.map((c) => ({
        id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
      { role: "tool", tool_call_id: "call_01AAA", content: "Berlin sonnig" },
      { role: "tool", tool_call_id: "call_01BBB", content: "Koeln bewoelkt" }
    );
    const r2 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
    const t2 = collect(await readChunks(r2));
    assert.equal(t2.content, "Ergebnis: Berlin sonnig | Koeln bewoelkt");
  });

  it("works non-streaming (tool_calls message, then final answer)", async () => {
    const messages: any[] = [{ role: "user", content: "Wetter?" }];
    const r1 = await post({ model: "haiku", messages, tools: TOOLS });
    const b1 = (await r1.json()) as any;
    assert.equal(b1.choices[0].finish_reason, "tool_calls");
    const call = b1.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "get_weather");
    assert.equal(b1.choices[0].message.content, "Ich schaue nach.");

    messages.push(b1.choices[0].message, { role: "tool", tool_call_id: call.id, content: "warm" });
    const r2 = await post({ model: "haiku", messages, tools: TOOLS });
    const b2 = (await r2.json()) as any;
    assert.equal(b2.choices[0].finish_reason, "stop");
    assert.equal(b2.choices[0].message.content, "Ergebnis: warm");
  });

  it("falls back to a fresh run with replayed history after the park timeout", async () => {
    process.env.TOOL_RESULT_TIMEOUT_MS = "300";
    try {
      const messages: any[] = [{ role: "user", content: "Wetter?" }];
      const r1 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
      const t1 = collect(await readChunks(r1));
      assert.equal(t1.finish, "tool_calls");

      await new Promise((r) => setTimeout(r, 700)); // parked run times out

      messages.push(
        { role: "assistant", content: null, tool_calls: t1.calls.map((c) => ({
          id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) },
        { role: "tool", tool_call_id: t1.calls[0].id, content: "spaet geliefert" }
      );
      const r2 = await post({ model: "haiku", stream: true, messages, tools: TOOLS });
      const t2 = collect(await readChunks(r2));
      assert.equal(t2.finish, "stop");
      assert.equal(t2.content, "REPLAY:ok");
    } finally {
      delete process.env.TOOL_RESULT_TIMEOUT_MS;
    }
  });

  it("streams thinking summaries as reasoning before the text", async () => {
    const r = await post({ model: "haiku", stream: true, messages: [{ role: "user", content: "Wetter?" }], tools: TOOLS });
    const chunks = await readChunks(r);
    const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning || "").join("");
    assert.equal(reasoning, "Erst das Tool, dann antworten.");
    const firstReasoning = chunks.findIndex((c) => c.choices?.[0]?.delta?.reasoning);
    const firstContent = chunks.findIndex((c) => c.choices?.[0]?.delta?.content);
    assert.ok(firstReasoning >= 0 && firstReasoning < firstContent);
  });

  it("rejects MCP bridge calls without the run token", async () => {
    // Start a run so the bridge is up, then probe it with a wrong token
    const r1 = await post({ model: "haiku", stream: true, messages: [{ role: "user", content: "x" }], tools: TOOLS });
    const t1 = collect(await readChunks(r1));
    assert.equal(t1.finish, "tool_calls");
    const { getBridgeBaseUrl } = await import("../mcp/bridge.js");
    const bridge = await getBridgeBaseUrl();
    const probe = await fetch(`${bridge}/mcp/doesnotexist`, {
      method: "POST",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(probe.status, 401);
  });
});
