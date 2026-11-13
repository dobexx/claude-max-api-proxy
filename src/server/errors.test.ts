/**
 * CLI errors become real OpenAI errors (HTTP status / SSE error event), and
 * OpenWebUI background tasks are not bound to an account.
 *
 * Fake Claude CLI (CLAUDE_BIN) that reacts to markers in the prompt:
 *   TOOLONG  -> result is_error "Prompt is too long ..."  (api_error_status 400)
 *   LIMIT    -> result is_error "You've hit your weekly limit ..."
 *   BADMODEL -> synthetic assistant + result is_error (api_error_status 404)
 *   AUTH     -> exits 1 with an auth error on stderr
 *   PARTIAL  -> streams some text, then ends with an error result
 *   otherwise a normal answer
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
import { cliErrorInfo } from "./errors.js";
import { isTaskRequest, affinityKey, chatFingerprint, _resetAccountsForTests, boundAccount } from "../accounts/pool.js";

const FAKE_CLI = String.raw`#!/usr/bin/env node
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  if (!prompt.trim()) { process.stderr.write("Error: Input must be provided\n"); process.exit(1); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const ev = (event) => out({ type: "stream_event", event, session_id: "s", uuid: "u" });
  const fail = (text, status) => {
    out({ type: "result", subtype: "success", is_error: true, result: text, api_error_status: status,
          usage: { input_tokens: 0, output_tokens: 0 }, session_id: "s" });
    process.exit(1);
  };
  out({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" });
  if (prompt.includes("AUTH")) { process.stderr.write("OAuth token has expired. Please run /login\n"); process.exit(1); }
  if (prompt.includes("TOOLONG")) return fail("Prompt is too long · the request is ~1538455 tokens (limit 1000000)", 400);
  if (prompt.includes("LIMIT")) return fail("You've hit your weekly limit · resets Nov 15, 11am (UTC)", null);
  if (prompt.includes("BADMODEL")) {
    out({ type: "assistant", error: "model_not_found", message: { model: "<synthetic>", content: [{ type: "text", text: "There's an issue with the selected model" }] } });
    return fail("There's an issue with the selected model (claude-opus-0-0). It may not exist or you may not have access to it.", 404);
  }
  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Teilantwort" } });
  ev({ type: "content_block_stop", index: 0 });
  if (prompt.includes("PARTIAL")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: stream aborted",
          usage: { input_tokens: 3, output_tokens: 1 }, session_id: "s" });
    process.exit(1);
  }
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  out({ type: "result", subtype: "success", is_error: false, result: "Teilantwort", num_turns: 1,
        usage: { input_tokens: 3, output_tokens: 2 }, session_id: "s" });
});
`;

let baseUrl = "";
let server: Server;
let tmpDir = "";
const savedEnv = { ...process.env };

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-errors-"));
  const bin = path.join(tmpDir, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  for (const n of ["loupz", "jungherz"]) {
    fs.mkdirSync(path.join(tmpDir, n));
    fs.writeFileSync(path.join(tmpDir, n, ".credentials.json"), "{}");
  }
  process.env.CLAUDE_BIN = bin;
  process.env.ACCOUNTS_DIR = tmpDir;
  process.env.ACCOUNTS = "loupz,jungherz";
  process.env.ACCOUNT_POLL_MINUTES = "0";
  process.env.PROXY_API_KEY = "off";
  process.env.TOOL_MODE = "mcp";
  _resetAccountsForTests();
  initApiKey();
  server = await startServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await stopServer();
  _resetAccountsForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = savedEnv;
});

async function post(content: string, stream: boolean): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "haiku", stream, messages: [{ role: "user", content }] }),
  });
}

/** SSE body -> parsed data events (without [DONE]) + whether [DONE] came */
async function sse(r: Response): Promise<{ events: any[]; done: boolean }> {
  const text = await r.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  return {
    events: lines.filter((l) => l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6))),
    done: lines.includes("data: [DONE]"),
  };
}

describe("CLI errors as real errors", { timeout: 30_000 }, () => {
  it("non-streaming: prompt too long -> HTTP 400 with the CLI message", async () => {
    const r = await post("TOOLONG bitte", false);
    assert.equal(r.status, 400);
    const b = (await r.json()) as any;
    assert.equal(b.error.code, "context_length_exceeded");
    assert.match(b.error.message, /Prompt is too long/);
    assert.equal(b.choices, undefined, "no assistant message");
  });

  it("non-streaming: usage limit -> HTTP 429, unknown model -> HTTP 404", async () => {
    const r1 = await post("LIMIT bitte", false);
    assert.equal(r1.status, 429);
    assert.equal(((await r1.json()) as any).error.type, "rate_limit_error");
    _resetAccountsForTests(); // the limit marked both accounts - start fresh
    const r2 = await post("BADMODEL bitte", false);
    assert.equal(r2.status, 404);
    assert.equal(((await r2.json()) as any).error.code, "model_not_found");
  });

  it("streaming: error event + [DONE], no content chunk", async () => {
    const r = await post("TOOLONG bitte", true);
    assert.equal(r.status, 200);
    const { events, done } = await sse(r);
    assert.equal(done, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].error.code, "context_length_exceeded");
    assert.equal(events.some((e) => e.choices?.[0]?.delta?.content), false);
  });

  it("expired login -> error with relogin guidance (401 / SSE error)", async () => {
    _resetAccountsForTests();
    const r1 = await post("AUTH bitte", false);
    assert.equal(r1.status, 401);
    assert.match(((await r1.json()) as any).error.message, /relogin/);
    _resetAccountsForTests();
    const { events, done } = await sse(await post("AUTH bitte", true));
    assert.equal(done, true);
    assert.equal(events.at(-1).error.code, "auth_expired");
  });

  it("an error after partial output keeps the text (no error swap mid-answer)", async () => {
    _resetAccountsForTests();
    const { events, done } = await sse(await post("PARTIAL bitte", true));
    assert.equal(done, true);
    const text = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
    assert.equal(text, "Teilantwort");
  });

  it("normal answers are unchanged", async () => {
    _resetAccountsForTests();
    const r = await post("Hallo", false);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).choices[0].message.content, "Teilantwort");
  });
});

describe("error mapping", () => {
  it("maps CLI results to HTTP statuses", () => {
    assert.equal(cliErrorInfo({ is_error: false, result: "ok" }), null);
    assert.equal(cliErrorInfo({ is_error: true, result: "Prompt is too long · ..." })!.status, 400);
    assert.equal(cliErrorInfo({ is_error: true, result: "Usage limit reached" })!.status, 429);
    assert.equal(cliErrorInfo({ is_error: true, result: "x", api_error_status: 429 })!.status, 429);
    assert.equal(cliErrorInfo({ is_error: true, result: "Overloaded" })!.status, 503);
    assert.equal(cliErrorInfo({ is_error: true, result: "x", api_error_status: 404 })!.status, 404);
    assert.equal(cliErrorInfo({ is_error: true, result: "x", api_error_status: 413 })!.status, 413);
    assert.equal(cliErrorInfo({ is_error: true, result: "x", api_error_status: 500 })!.status, 502);
    assert.equal(cliErrorInfo({ is_error: true, result: "" })!.status, 500);
  });
});

describe("OpenWebUI background tasks", () => {
  const title = {
    role: "user" as const,
    content: "### Task:\nGenerate a concise title.\n### Chat History:\n<chat_history>\nUSER: Hallo\n</chat_history>",
  };

  it("recognizes title/tags/follow-up requests, not chats or compaction", () => {
    assert.equal(isTaskRequest([title]), true);
    assert.equal(isTaskRequest([{ role: "user", content: [{ type: "text", text: title.content }] }]), true);
    // Model with its own system prompt in OpenWebUI
    assert.equal(isTaskRequest([{ role: "system", content: "Du bist hilfreich." }, title]), true);
    // A user who starts a chat with "### Task:" but no chat history
    assert.equal(isTaskRequest([{ role: "user", content: "### Task: Schreib ein Gedicht" }]), false);
    // Compaction: full chat + appended task prompt -> stays with its chat
    const compaction = [
      { role: "user" as const, content: "Erste Frage" },
      { role: "assistant" as const, content: "Antwort" },
      { role: "user" as const, content: "### Task:\nSummarize the conversation history ..." },
    ];
    assert.equal(isTaskRequest(compaction), false);
    assert.equal(affinityKey(compaction), chatFingerprint(compaction));
    // RAG-wrapped normal turn
    assert.equal(isTaskRequest([{ role: "user", content: "### Task:\nRespond to the user query\n<context>x</context>\nFrage" }]), false);
  });

  it("answers a task request without binding it to an account", async () => {
    const before = fs.existsSync(path.join(tmpDir, "affinity.json"));
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "haiku", stream: false, messages: [title] }),
    });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).choices[0].message.content, "Teilantwort");
    assert.equal(affinityKey([title]), undefined);
    assert.equal(boundAccount(chatFingerprint([title])!), undefined);
    assert.equal(before, fs.existsSync(path.join(tmpDir, "affinity.json")));
  });
});
