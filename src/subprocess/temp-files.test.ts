/**
 * Temp file hygiene for system prompt files and MCP bridge configs, plus the
 * CLAUDE_MEMORY switch. No subscription tokens are used.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  MCP_CONFIG_PREFIX,
  SYSTEM_PROMPT_PREFIX,
  tempPath,
  trackTemp,
  releaseTemp,
  isTrackedTemp,
  sweepStaleTempFiles,
} from "./temp-files.js";
import { buildCliEnv, isClaudeMemoryEnabled } from "./manager.js";

const created: string[] = [];
afterEach(() => {
  for (const p of created.splice(0)) fs.rmSync(p, { recursive: true, force: true });
  delete process.env.CLAUDE_MEMORY;
});

function make(name: string, dir = false): string {
  const p = path.join(os.tmpdir(), name);
  if (dir) fs.mkdirSync(p, { recursive: true });
  else fs.writeFileSync(p, "x", { mode: 0o600 });
  created.push(p);
  return p;
}

describe("temp file naming and tracking", () => {
  it("names carry the proxy PID", () => {
    const p = tempPath(MCP_CONFIG_PREFIX, "abc.json");
    assert.equal(path.basename(p), `cmap-mcp-${process.pid}-abc.json`);
  });

  it("release removes the file and stops tracking", async () => {
    const p = make(`cmap-mcp-${process.pid}-rel.json`);
    trackTemp(p);
    assert.ok(isTrackedTemp(p));
    releaseTemp(p);
    assert.equal(isTrackedTemp(p), false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(p), false);
  });
});

describe("startup sweep", () => {
  it("removes MCP configs and prompt dirs of dead proxies and the legacy format", () => {
    const deadMcp = make("cmap-mcp-999998-aaaa.json");
    const deadSp = make("cmap-sp-999998-bbbb", true);
    const legacyMcp = make("cmap-mcp-0366367a1a741d634b20fe83.json"); // pre-PID format
    const staleOwn = make(`cmap-mcp-${process.pid}-stale.json`);
    const unrelated = make("cmap-mcpx-keep.json");
    // Shares a prefix but matches neither the PID nor a legacy format
    const lookalikeDir = make("cmap-sp-test-AbCdEf", true);
    const lookalikeFile = make("cmap-mcp-notes.json");
    sweepStaleTempFiles();
    assert.equal(fs.existsSync(deadMcp), false, "dead proxy MCP config");
    assert.equal(fs.existsSync(deadSp), false, "dead proxy prompt dir");
    assert.equal(fs.existsSync(legacyMcp), false, "legacy MCP config");
    assert.equal(fs.existsSync(staleOwn), false, "stale own-PID entry");
    assert.equal(fs.existsSync(unrelated), true, "unrelated file kept");
    assert.equal(fs.existsSync(lookalikeDir), true, "look-alike dir kept");
    assert.equal(fs.existsSync(lookalikeFile), true, "look-alike file kept");
  });

  it("removes the legacy prompt dir format (cmap-sp-XXXXXX)", () => {
    const legacySp = make("cmap-sp-ENs9Un", true);
    sweepStaleTempFiles();
    assert.equal(fs.existsSync(legacySp), false);
  });

  it("keeps tracked (live) entries and entries of live foreign processes", () => {
    const live = make(`cmap-mcp-${process.pid}-live.json`);
    trackTemp(live);
    // PID 1 always exists (init / container PID 1)
    const foreign = make(`${SYSTEM_PROMPT_PREFIX}1-foreign`, true);
    try {
      sweepStaleTempFiles();
      assert.equal(fs.existsSync(live), true);
      assert.equal(fs.existsSync(foreign), true);
    } finally {
      releaseTemp(live);
    }
  });
});

describe("exit cleanup", () => {
  it("removes tracked MCP configs and prompt dirs when the process exits", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mod = path.join(here, "temp-files.js");
    const script = `
      import { tempPath, trackTemp, MCP_CONFIG_PREFIX, SYSTEM_PROMPT_PREFIX } from ${JSON.stringify(mod)};
      import fs from "fs";
      const a = tempPath(MCP_CONFIG_PREFIX, "exit.json");
      const b = tempPath(SYSTEM_PROMPT_PREFIX, "exit");
      fs.writeFileSync(a, "token");
      fs.mkdirSync(b); fs.writeFileSync(b + "/system-prompt.md", "geheim");
      trackTemp(a); trackTemp(b);
      console.log(JSON.stringify([a, b]));
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {}, 5000);
    `;
    // Mirror standalone.ts: SIGTERM handler that exits -> "exit" handlers run
    const wrapper = `process.on("SIGTERM", () => process.exit(0));\n` + script;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", wrapper], { encoding: "utf8", timeout: 10_000 });
    const [a, b] = JSON.parse(r.stdout.trim().split("\n")[0]);
    assert.equal(fs.existsSync(a), false, "MCP config removed on exit");
    assert.equal(fs.existsSync(b), false, "prompt dir removed on exit");
  });
});

describe("CLAUDE_MEMORY", () => {
  it("is off by default and disables auto-memory for the CLI", () => {
    assert.equal(isClaudeMemoryEnabled(), false);
    assert.equal(buildCliEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, "proxy env untouched");
  });

  it("CLAUDE_MEMORY=on leaves auto-memory enabled", () => {
    process.env.CLAUDE_MEMORY = "on";
    assert.equal(isClaudeMemoryEnabled(), true);
    assert.equal(buildCliEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  });
});
