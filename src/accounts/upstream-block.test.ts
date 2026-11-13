/**
 * Outage at Anthropic: Cloudflare rejects requests with an HTML page and the
 * CLI words it as "Failed to authenticate. API Error: 403 Attention
 * Required! | Cloudflare" (seen live on 13.11.2026, 09:49 UTC).
 *
 * Expected: no "login invalid" - the account pauses briefly (status
 * "blocked"), the request moves to the other account, and the account comes
 * back on its own. Accounts marked auth_failed are re-checked every minute.
 *
 * Fake Claude CLI (CLAUDE_BIN) per CLAUDE_CONFIG_DIR, controlled by
 * "<dir>/mode":
 *   block        -> result is_error with the Cloudflare text (as on stdout live)
 *   block-stderr -> HTML 403 page on stderr, exit 1
 *   auth         -> result is_error "OAuth session expired and could not be refreshed"
 *   otherwise    -> normal answer; /usage answers with numbers
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
import { cliErrorInfo } from "../server/errors.js";
import { isAuthError, isUpstreamBlock } from "../subprocess/manager.js";
import {
  _resetAccountsForTests,
  getAccount,
  setUtilization,
  pickAccount,
  markBlocked,
  markAuthFailed,
  markLimited,
  observeRateLimit,
} from "./pool.js";
import { refreshAccount, recheckFailedLogins } from "./usage.js";

const CLOUDFLARE_TEXT = "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare";

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.CLAUDE_CONFIG_DIR || "";
const name = path.basename(dir);
let mode = "ok";
try { mode = fs.readFileSync(path.join(dir, "mode"), "utf8").trim(); } catch {}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const ev = (event) => out({ type: "stream_event", event, session_id: "s", uuid: "u" });
const args = process.argv.slice(2);
if (args.includes("/usage")) {
  if (mode === "block" || mode === "block-stderr") {
    process.stderr.write("API Error: 403 <!DOCTYPE html><title>Attention Required! | Cloudflare</title>\n");
    process.exit(1);
  }
  if (mode === "auth") {
    process.stderr.write("Failed to authenticate: OAuth session expired and could not be refreshed\n");
    process.exit(1);
  }
  process.stdout.write("Current week (all models): 30% used · resets Nov 18, 9am (UTC)\n");
  process.exit(0);
}
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  if (!prompt.trim()) { process.stderr.write("Error: Input must be provided\n"); process.exit(1); }
  if (dir) fs.appendFileSync(path.join(dir, "calls"), "x");
  out({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" });
  const fail = (text, status) => {
    out({ type: "assistant", error: "authentication_failed", isApiErrorMessage: true,
          message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "success", is_error: true, result: text, api_error_status: status,
          usage: { input_tokens: 0, output_tokens: 0 }, session_id: "s" });
    process.exit(1);
  };
  if (mode === "block") return fail(${JSON.stringify(CLOUDFLARE_TEXT)}, 403);
  if (mode === "auth") return fail("Failed to authenticate: OAuth session expired and could not be refreshed", null);
  if (mode === "block-stderr") {
    process.stderr.write("API Error: 403 <!DOCTYPE html>\n<title>Attention Required! | Cloudflare</title>\n");
    process.exit(1);
  }
  const text = "ACCOUNT=" + name;
  ev({ type: "message_start", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, output_tokens: 0 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1,
        usage: { input_tokens: 3, output_tokens: 2 }, session_id: "s" });
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

async function ask(content: string, stream = false): Promise<{ status: number; text: string; code?: string }> {
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "haiku", stream, messages: [{ role: "user", content }] }),
  });
  if (!stream) {
    const b = (await r.json()) as any;
    return { status: r.status, text: b.choices?.[0]?.message?.content ?? b.error?.message ?? "", code: b.error?.code };
  }
  const events = (await r.text())
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
  const err = events.find((e) => e.error)?.error;
  const text = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
  return { status: r.status, text: err ? err.message : text, code: err?.code };
}

/** Run fn with Date.now shifted forward */
async function later<T>(ms: number, fn: () => T | Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-block-"));
  const bin = path.join(tmp, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  for (const n of ["loupz", "jungherz"]) {
    fs.mkdirSync(path.join(tmp, n));
    fs.writeFileSync(path.join(tmp, n, ".credentials.json"), "{}");
  }
  process.env.CLAUDE_BIN = bin;
  process.env.ACCOUNTS_DIR = tmp;
  process.env.ACCOUNTS = "loupz,jungherz";
  process.env.ACCOUNT_POLL_MINUTES = "0";
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
  setUtilization(getAccount("loupz")!, 0.1);
  setUtilization(getAccount("jungherz")!, 0.5);
});

describe("outage block (Cloudflare 403) instead of 'login invalid'", { timeout: 30_000 }, () => {
  it("recognizes the outage text, but still real login errors", () => {
    assert.equal(isUpstreamBlock(CLOUDFLARE_TEXT), true);
    assert.equal(isUpstreamBlock("API Error: 403 <!DOCTYPE html>\n<html class=\"no-js\">"), true);
    assert.equal(isAuthError(CLOUDFLARE_TEXT, null), false);
    assert.equal(isAuthError("Failed to authenticate: OAuth session expired and could not be refreshed", null), true);
    assert.equal(isAuthError("OAuth token has expired. Please run /login", null), true);
    assert.equal(isUpstreamBlock("Failed to authenticate: OAuth session expired and could not be refreshed"), false);
    const info = cliErrorInfo({ is_error: true, result: CLOUDFLARE_TEXT, api_error_status: 403 })!;
    assert.equal(info.status, 503);
    assert.equal(info.body.error.code, "upstream_blocked");
  });

  it("moves the request to the other account and only pauses the blocked one", async () => {
    setMode("loupz", "block");
    const r = await ask("Chat eins", true);
    assert.equal(r.text, "ACCOUNT=jungherz");
    assert.equal(getAccount("loupz")!.status, "blocked");
    assert.ok(getAccount("loupz")!.limitedUntil! > Date.now());
    // during the cool-down new chats skip it without trying
    const before = calls("loupz");
    assert.equal((await ask("Chat zwei")).text, "ACCOUNT=jungherz");
    assert.equal(calls("loupz"), before);
  });

  it("uses the account again by itself after the cool-down (no refresh needed)", async () => {
    setMode("loupz", "block");
    await ask("Chat drei");
    assert.equal(getAccount("loupz")!.status, "blocked");
    setMode("loupz", null); // Anthropic answers again
    const p = await later(61_000, () => pickAccount("neuer chat"));
    assert.equal(p!.account.name, "loupz");
    assert.equal(getAccount("loupz")!.status, "ok");
  });

  it("all accounts blocked: 503 with the outage hint, no relogin text", async () => {
    setMode("loupz", "block");
    setMode("jungherz", "block");
    const r1 = await ask("Chat vier");
    assert.equal(r1.status, 503);
    assert.equal(r1.code, "upstream_blocked");
    assert.match(r1.text, /Stoerung bei Anthropic/);
    assert.doesNotMatch(r1.text, /relogin/i);
    assert.equal(getAccount("loupz")!.status, "blocked");
    assert.equal(getAccount("jungherz")!.status, "blocked");
    // next request while both pause: still tried (best effort), still the outage hint
    const r2 = await ask("Chat fuenf", true);
    assert.equal(r2.code, "upstream_blocked");
  });

  it("an HTML 403 page on stderr counts as outage too", async () => {
    setMode("loupz", "block-stderr");
    assert.equal((await ask("Chat sechs")).text, "ACCOUNT=jungherz");
    assert.equal(getAccount("loupz")!.status, "blocked");
  });

  it("a real expired login still says 'login invalid'", async () => {
    setMode("loupz", "auth");
    assert.equal((await ask("Chat sieben")).text, "ACCOUNT=jungherz");
    assert.equal(getAccount("loupz")!.status, "auth_failed");
  });
});

describe("account states", () => {
  it("a block never overrides a limit or a failed login", () => {
    const a = getAccount("loupz")!;
    markLimited(a, Date.now() + 3600_000, "test");
    markBlocked(a, CLOUDFLARE_TEXT);
    assert.equal(a.status, "limited");
    markAuthFailed(a, "expired");
    markBlocked(a, CLOUDFLARE_TEXT);
    assert.equal(a.status, "auth_failed");
  });

  it("a request that gets through ends a block", () => {
    const a = getAccount("loupz")!;
    markBlocked(a, CLOUDFLARE_TEXT);
    observeRateLimit(a, { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.3 } } });
    assert.equal(a.status, "ok");
  });

  it("/usage during an outage marks blocked, not auth_failed", async () => {
    setMode("loupz", "block");
    await refreshAccount(getAccount("loupz")!);
    assert.equal(getAccount("loupz")!.status, "blocked");
  });
});

describe("re-check of failed logins (every minute)", () => {
  it("brings an account back once /usage works again", async () => {
    const a = getAccount("loupz")!;
    markAuthFailed(a, "Failed to authenticate");
    await recheckFailedLogins();
    assert.equal(a.status, "ok", "outage over: /usage answered with numbers");
    assert.equal(a.utilization, 0.3);
  });

  it("keeps a really expired login marked", async () => {
    setMode("loupz", "auth");
    const a = getAccount("loupz")!;
    markAuthFailed(a, "expired");
    await recheckFailedLogins();
    assert.equal(a.status, "auth_failed");
  });

  it("re-checks a blocked account only after its cool-down", async () => {
    const a = getAccount("loupz")!;
    markBlocked(a, CLOUDFLARE_TEXT);
    setMode("loupz", "block");
    await recheckFailedLogins(); // cool-down running: not polled
    assert.equal(a.status, "blocked");
    setMode("loupz", null);
    await later(61_000, () => recheckFailedLogins());
    assert.equal(a.status, "ok");
  });
});
