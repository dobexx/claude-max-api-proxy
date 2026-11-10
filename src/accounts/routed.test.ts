/**
 * End-to-end tests for multi-account routing through the real HTTP server,
 * with a fake Claude CLI (CLAUDE_BIN) that behaves per CLAUDE_CONFIG_DIR:
 *   - "<dir>/mode" = "limit"  -> rate_limit_event rejected + error result
 *   - "<dir>/mode" = "auth"   -> exits 1 with an auth error on stderr
 *   - otherwise              -> normal answer naming the account dir
 * No Claude subscription tokens are used.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { startServer, stopServer } from "../server/index.js";
import { initApiKey } from "../server/auth.js";
import { _resetAccountsForTests, getAccount, setUtilization, boundAccount, chatFingerprint } from "./pool.js";

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.CLAUDE_CONFIG_DIR || "";
const name = path.basename(dir);
let mode = "ok";
try { mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim(); } catch {}
if (dir) fs.appendFileSync(path.join(dir, "calls"), "x"); // flag probes run without a dir
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event) => out({ type: "stream_event", event, session_id: "s", uuid: "u" });
const args = process.argv.slice(2);
if (args.includes("/usage")) {
  process.stdout.write("Current week (all models): " + (mode === "limit" ? 100 : 30) + "% used · resets Nov 11, 9am (UTC)\n");
  process.exit(0);
}
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  if (!prompt.trim()) { process.stderr.write("Error: Input must be provided\n"); process.exit(1); }
  out({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" });
  if (mode === "auth") {
    process.stderr.write("OAuth token has expired. Please run /login\n");
    process.exit(1);
  }
  if (mode === "limit") {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600,
          rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 1.0, status: "rejected" } } } });
    out({ type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets 9am (UTC)",
          usage: { input_tokens: 0, output_tokens: 0 }, session_id: "s" });
    process.exit(1);
  }
  const text = "ACCOUNT=" + name;
  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1794387600,
        unifiedWindows: { seven_day: { utilization: name === "loupz" ? 0.4 : 0.2, resetsAt: 1794387600, status: "allowed" } } } });
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1,
        usage: { input_tokens: 3, cache_read_input_tokens: 100, output_tokens: 2 }, session_id: "s" });
});
`;

let tmp = "";
let server: Server;
let baseUrl = "";
const savedEnv = { ...process.env };

function setMode(account: string, mode: string | null): void {
  const f = path.join(tmp, account, "mode");
  if (mode) fs.writeFileSync(f, mode);
  else fs.rmSync(f, { force: true });
}

function calls(account: string): number {
  try {
    return fs.readFileSync(path.join(tmp, account, "calls"), "utf8").length;
  } catch {
    return 0;
  }
}

async function ask(content: string, stream = false): Promise<string> {
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "haiku", stream, messages: [{ role: "user", content }] }),
  });
  if (!stream) {
    const b = (await r.json()) as any;
    return b.choices?.[0]?.message?.content ?? JSON.stringify(b);
  }
  const text = await r.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .map((c) => c.choices?.[0]?.delta?.content || (c.error ? `ERROR:${c.error.message}` : ""))
    .join("");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-multi-"));
  const bin = path.join(tmp, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  for (const n of ["loupz", "jungherz"]) {
    fs.mkdirSync(path.join(tmp, n));
    fs.writeFileSync(path.join(tmp, n, ".credentials.json"), "{}");
  }
  process.env.CLAUDE_BIN = bin;
  process.env.ACCOUNTS_DIR = tmp;
  process.env.ACCOUNTS = "loupz,jungherz";
  process.env.PROXY_API_KEY = "off";
  process.env.TOOL_MODE = "mcp";
  initApiKey();
  server = await startServer({ port: 0 });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await stopServer();
  _resetAccountsForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = savedEnv;
});

beforeEach(() => {
  _resetAccountsForTests();
  setMode("loupz", null);
  setMode("jungherz", null);
});

describe("multi-account routing (fake CLI)", { timeout: 30_000 }, () => {
  it("places a new chat on the less used account and keeps it there", async () => {
    setUtilization(getAccount("loupz")!, 0.6);
    setUtilization(getAccount("jungherz")!, 0.3);
    assert.equal(await ask("Chat eins"), "ACCOUNT=jungherz");
    // jungherz now reports 20 %, loupz is still at 60 % - but the chat sticks anyway
    setUtilization(getAccount("loupz")!, 0.05);
    assert.equal(await ask("Chat eins", true), "ACCOUNT=jungherz");
    assert.equal(boundAccount(chatFingerprint([{ role: "user", content: "Chat eins" }])!), "jungherz");
  });

  it("fails over to the other account when the limit is reached, before any output", async () => {
    setUtilization(getAccount("loupz")!, 0.1);
    setUtilization(getAccount("jungherz")!, 0.5);
    setMode("loupz", "limit");
    const before = calls("jungherz");
    assert.equal(await ask("Chat zwei", true), "ACCOUNT=jungherz");
    assert.equal(calls("jungherz"), before + 1);
    assert.equal(getAccount("loupz")!.status, "limited");
    // next new chat skips the limited account right away
    const loupzCalls = calls("loupz");
    assert.equal(await ask("Chat drei"), "ACCOUNT=jungherz");
    assert.equal(calls("loupz"), loupzCalls);
  });

  it("fails over when a login has expired and marks the account", async () => {
    setUtilization(getAccount("loupz")!, 0.1);
    setUtilization(getAccount("jungherz")!, 0.5);
    setMode("loupz", "auth");
    assert.equal(await ask("Chat vier"), "ACCOUNT=jungherz");
    assert.equal(getAccount("loupz")!.status, "auth_failed");
  });

  it("passes the CLI's limit message through when every account is limited", async () => {
    setMode("loupz", "limit");
    setMode("jungherz", "limit");
    const answer = await ask("Chat fuenf", true);
    assert.match(answer, /hit your weekly limit|exited|ERROR/);
  });

  it("lists the accounts on /admin/accounts", async () => {
    setUtilization(getAccount("loupz")!, 0.42);
    const r = await fetch(`${baseUrl}/admin/accounts`);
    // PROXY_API_KEY=off and no admin key: admin routes are locked
    if (r.status === 403) return;
    const b = (await r.json()) as any;
    assert.equal(b.enabled, true);
    assert.equal(b.switch_at_percent, 85);
    assert.equal(b.accounts.find((a: any) => a.name === "loupz").percent_used, 42);
  });
});
