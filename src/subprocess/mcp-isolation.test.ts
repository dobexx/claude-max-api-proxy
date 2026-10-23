/**
 * External MCP isolation: by default the CLI must not load MCP servers beyond
 * the proxy's own bridge (no claude.ai connectors such as Microsoft 365).
 * Fake CLI (CLAUDE_BIN) records argv + relevant env - no subscription tokens.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { ClaudeSubprocess, buildCliEnv, isExternalMcpAllowed } from "./manager.js";

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (!stdin.trim()) { process.stderr.write("Error: Input must be provided\n"); process.exit(1); }
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args: process.argv.slice(2),
    claudeAiMcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
  }));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    result: "ok", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" }) + "\n");
});
`;

const savedEnv = { ...process.env };
let tmpDir: string;
let recordFile: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-mcp-test-"));
  const bin = path.join(tmpDir, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  recordFile = path.join(tmpDir, "record.json");
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_RECORD = recordFile;
  process.env.THINKING_DISPLAY = "off";
  delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
});

afterEach(() => {
  delete process.env.ALLOW_EXTERNAL_MCP;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = savedEnv;
});

async function run(opts: { mcpConfigPath?: string } = {}) {
  const sp = new ClaudeSubprocess();
  const closed = new Promise<void>((resolve) => sp.on("close", () => resolve()));
  await sp.start("Hallo", { model: "haiku", ...opts });
  await closed;
  return JSON.parse(fs.readFileSync(recordFile, "utf8")) as { args: string[]; claudeAiMcp: string | null };
}

describe("external MCP isolation", { timeout: 20_000 }, () => {
  it("is off by default", () => {
    assert.equal(isExternalMcpAllowed(), false);
    assert.equal(buildCliEnv().ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  });

  it("plain chat: --strict-mcp-config and claude.ai connectors disabled", async () => {
    const r = await run();
    assert.ok(r.args.includes("--strict-mcp-config"));
    assert.ok(!r.args.includes("--mcp-config"));
    assert.equal(r.claudeAiMcp, "false");
  });

  it("tool run: only the bridge config, connectors disabled", async () => {
    const r = await run({ mcpConfigPath: "/tmp/bridge.json" });
    assert.equal(r.args.filter((a) => a === "--strict-mcp-config").length, 1);
    const i = r.args.indexOf("--mcp-config");
    assert.equal(r.args[i + 1], "/tmp/bridge.json");
    assert.equal(i, r.args.length - 2, "--mcp-config (variadic) must stay last");
    assert.equal(r.claudeAiMcp, "false");
  });

  it("ALLOW_EXTERNAL_MCP=on restores the old behavior for plain chats", async () => {
    process.env.ALLOW_EXTERNAL_MCP = "on";
    const r = await run();
    assert.ok(!r.args.includes("--strict-mcp-config"));
    assert.equal(r.claudeAiMcp, null);
  });

  it("ALLOW_EXTERNAL_MCP=on keeps tool runs strict", async () => {
    process.env.ALLOW_EXTERNAL_MCP = "on";
    const r = await run({ mcpConfigPath: "/tmp/bridge.json" });
    assert.ok(r.args.includes("--strict-mcp-config"));
  });

  it("does not leak the flag into the proxy's own environment", () => {
    buildCliEnv();
    assert.equal(process.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  });
});
