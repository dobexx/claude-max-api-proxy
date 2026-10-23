/**
 * Tests for SYSTEM_PROMPT_MODE (wrap | append | replace) and
 * OPENCLAW_TOOL_MAPPING. Uses a fake Claude CLI (CLAUDE_BIN) that records its
 * argv and the content of the system prompt file - no subscription tokens.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { openaiToCli, openaiToCliDelta, extractSystemPrompt } from "./openai-to-cli.js";
import { getSystemPromptMode, isOpenClawMappingEnabled } from "./system-prompt.js";
import {
  ClaudeSubprocess,
  cleanupLiveSystemPromptFiles,
  sweepStaleSystemPromptFiles,
} from "../subprocess/manager.js";
import type { OpenAIChatRequest } from "../types/openai.js";

const savedEnv = { ...process.env };
afterEach(() => {
  delete process.env.SYSTEM_PROMPT_MODE;
  delete process.env.OPENCLAW_TOOL_MAPPING;
});

const req = (extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest => ({
  model: "claude-sonnet-5-5",
  messages: [
    { role: "system", content: "Antworte immer auf Deutsch." },
    { role: "user", content: "Hallo" },
  ],
  ...extra,
});

describe("SYSTEM_PROMPT_MODE parsing", () => {
  it("defaults to append", () => {
    assert.equal(getSystemPromptMode(), "append");
  });
  it("accepts wrap/append/replace case-insensitively", () => {
    for (const m of ["wrap", "APPEND", " Replace "]) {
      process.env.SYSTEM_PROMPT_MODE = m;
      assert.equal(getSystemPromptMode(), m.trim().toLowerCase());
    }
  });
  it("falls back to append on unknown values", () => {
    process.env.SYSTEM_PROMPT_MODE = "override";
    assert.equal(getSystemPromptMode(), "append");
  });
  it("OPENCLAW_TOOL_MAPPING defaults to on, off/0/false disable it", () => {
    assert.equal(isOpenClawMappingEnabled(), true);
    for (const v of ["off", "0", "false", "NO"]) {
      process.env.OPENCLAW_TOOL_MAPPING = v;
      assert.equal(isOpenClawMappingEnabled(), false);
    }
    process.env.OPENCLAW_TOOL_MAPPING = "on";
    assert.equal(isOpenClawMappingEnabled(), true);
  });
});

describe("openaiToCli system prompt handling", () => {
  it("append (default): system prompt leaves the user prompt", () => {
    const c = openaiToCli(req());
    assert.equal(c.systemPrompt, "Antworte immer auf Deutsch.");
    assert.equal(c.systemPromptMode, "append");
    assert.equal(c.prompt, "Hallo");
    assert.ok(!c.prompt.includes("<system>"));
  });

  it("replace: same extraction, replace mode", () => {
    process.env.SYSTEM_PROMPT_MODE = "replace";
    const c = openaiToCli(req());
    assert.equal(c.systemPromptMode, "replace");
    assert.equal(c.systemPrompt, "Antworte immer auf Deutsch.");
    assert.equal(c.prompt, "Hallo");
  });

  it("wrap: legacy <system> block inside the prompt, no systemPrompt", () => {
    process.env.SYSTEM_PROMPT_MODE = "wrap";
    const c = openaiToCli(req());
    assert.equal(c.systemPrompt, undefined);
    assert.equal(c.systemPromptMode, undefined);
    assert.match(c.prompt, /^<system>\nAntworte immer auf Deutsch\.\n<\/system>/);
    assert.ok(c.prompt.endsWith("Hallo"));
  });

  it("no system message: nothing to pass", () => {
    const c = openaiToCli(req({ messages: [{ role: "user", content: "Hi" }] }));
    assert.equal(c.systemPrompt, undefined);
    assert.equal(c.systemPromptMode, undefined);
    assert.equal(c.prompt, "Hi");
  });

  it("joins multiple system messages and accepts content blocks", () => {
    const c = openaiToCli(req({
      messages: [
        { role: "system", content: "Regel 1" },
        { role: "user", content: "Frage" },
        { role: "system", content: [{ type: "text", text: "Regel 2" }] },
      ],
    }));
    assert.equal(c.systemPrompt, "Regel 1\n\nRegel 2");
    assert.equal(c.prompt, "Frage");
  });

  it("only system messages: falls back to inlining (never an empty prompt)", () => {
    const c = openaiToCli(req({ messages: [{ role: "system", content: "Nur System" }] }));
    assert.equal(c.systemPrompt, undefined);
    assert.match(c.prompt, /<system>\nNur System\n<\/system>/);
  });

  it("strips OpenClaw tooling sections from the extracted system prompt", () => {
    const sp = extractSystemPrompt([
      { role: "system", content: "Intro\n## Tooling\nexec, read\n## Persona\nfreundlich" },
    ]);
    assert.ok(!sp.includes("exec, read"));
    assert.ok(sp.includes("## Persona\nfreundlich"));
  });

  it("resumed turns still carry the full current system prompt", () => {
    const body = req({
      messages: [
        { role: "system", content: "Sei knapp." },
        { role: "user", content: "Eins" },
        { role: "assistant", content: "Antwort" },
        { role: "user", content: "Zwei" },
      ],
    });
    const c = openaiToCliDelta(body, 3);
    assert.equal(c.prompt, "Zwei");
    assert.equal(c.systemPrompt, "Sei knapp.");
    assert.equal(c.systemPromptMode, "append");
  });
});

// ─── CLI argument wiring with a fake CLI ───────────────────────────────

const FAKE_CLI = String.raw`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (!stdin.trim()) { process.stderr.write("Error: Input must be provided\n"); process.exit(1); }
  const fileFlag = ["--system-prompt-file", "--append-system-prompt-file"].find((f) => args.includes(f));
  const file = fileFlag ? args[args.indexOf(fileFlag) + 1] : null;
  const record = {
    args,
    stdin,
    file,
    fileContent: file ? fs.readFileSync(file, "utf8") : null,
    fileMode: file ? (fs.statSync(file).mode & 0o777) : null,
  };
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(record));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    result: "ok", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" }) + "\n");
});
`;

let tmpDir: string;
let recordFile: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-sp-test-"));
  const bin = path.join(tmpDir, "claude");
  fs.writeFileSync(bin, FAKE_CLI, { mode: 0o755 });
  recordFile = path.join(tmpDir, "record.json");
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_RECORD = recordFile;
  process.env.THINKING_DISPLAY = "off";
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env = savedEnv;
});

async function runCli(body: OpenAIChatRequest, disableBuiltinTools = false) {
  const cli = openaiToCli(body);
  const sp = new ClaudeSubprocess();
  const closed = new Promise<void>((resolve) => sp.on("close", () => resolve()));
  await sp.start(cli.prompt, {
    model: cli.model,
    disableBuiltinTools,
    systemPrompt: cli.systemPrompt,
    systemPromptMode: cli.systemPromptMode,
  });
  await closed;
  await new Promise((r) => setTimeout(r, 50)); // async temp-file cleanup
  return JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
    args: string[]; stdin: string; file: string | null; fileContent: string | null; fileMode: number | null;
  };
}

describe("CLI wiring", { timeout: 20_000 }, () => {
  it("append: --append-system-prompt-file with the client prompt, file removed afterwards", async () => {
    const r = await runCli(req());
    assert.ok(r.args.includes("--append-system-prompt-file"));
    assert.ok(!r.args.includes("--system-prompt-file"));
    assert.equal(r.fileContent, "Antworte immer auf Deutsch.");
    assert.equal(r.fileMode, 0o600);
    assert.equal(r.stdin, "Hallo");
    assert.equal(fs.existsSync(r.file!), false, "temp file must be cleaned up");
    assert.equal(fs.existsSync(path.dirname(r.file!)), false, "temp dir must be cleaned up");
    // OpenClaw mapping still on by default (no client tools)
    assert.ok(r.args.includes("--append-system-prompt"));
  });

  it("replace: --system-prompt-file instead", async () => {
    process.env.SYSTEM_PROMPT_MODE = "replace";
    const r = await runCli(req());
    assert.ok(r.args.includes("--system-prompt-file"));
    assert.ok(!r.args.includes("--append-system-prompt-file"));
    assert.equal(r.fileContent, "Antworte immer auf Deutsch.");
    assert.equal(fs.existsSync(r.file!), false);
  });

  it("wrap: no system prompt file, <system> block on stdin", async () => {
    process.env.SYSTEM_PROMPT_MODE = "wrap";
    const r = await runCli(req());
    assert.equal(r.file, null);
    assert.match(r.stdin, /<system>/);
  });

  it("OPENCLAW_TOOL_MAPPING=off drops the mapping prompt", async () => {
    process.env.OPENCLAW_TOOL_MAPPING = "off";
    const r = await runCli(req());
    assert.ok(!r.args.includes("--append-system-prompt"));
    assert.ok(r.args.includes("--append-system-prompt-file"));
  });

  it("client tools: no mapping prompt, client system prompt still applied", async () => {
    const r = await runCli(req(), true);
    assert.ok(!r.args.includes("--append-system-prompt"));
    assert.ok(r.args.includes("--append-system-prompt-file"));
  });

  it("no system message: no system prompt flags", async () => {
    const r = await runCli(req({ messages: [{ role: "user", content: "Hi" }] }));
    assert.equal(r.file, null);
  });
});

describe("system prompt temp file hygiene", () => {
  it("temp dir name carries the proxy PID", async () => {
    const r = await runCli(req());
    assert.match(path.basename(path.dirname(r.file!)), new RegExp(`^cmap-sp-${process.pid}-`));
  });

  it("startup sweep removes dirs of dead proxies and stale own-PID dirs only", () => {
    const tmp = os.tmpdir();
    const dead = fs.mkdtempSync(path.join(tmp, "cmap-sp-999999-"));
    // Same PID but not a live run (container restart: proxy is PID 1 again)
    const staleOwn = fs.mkdtempSync(path.join(tmp, `cmap-sp-${process.pid}-`));
    const unrelated = fs.mkdtempSync(path.join(tmp, "cmap-spx-"));
    fs.writeFileSync(path.join(dead, "system-prompt.md"), "alt");
    try {
      const removed = sweepStaleSystemPromptFiles();
      assert.ok(removed >= 2);
      assert.equal(fs.existsSync(dead), false, "dead proxy's dir removed");
      assert.equal(fs.existsSync(staleOwn), false, "stale own-PID dir removed");
      assert.equal(fs.existsSync(unrelated), true, "unrelated dir kept");
    } finally {
      for (const d of [dead, staleOwn, unrelated]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("startup sweep keeps files of live runs", async () => {
    const hang = path.join(tmpDir, "claude-hang2");
    fs.writeFileSync(hang, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    const prevBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = hang;
    const sp = new ClaudeSubprocess();
    const closed = new Promise<void>((resolve) => sp.on("close", () => resolve()));
    try {
      await sp.start("x", { model: "haiku", systemPrompt: "live", systemPromptMode: "append" });
      const live = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`cmap-sp-${process.pid}-`));
      assert.equal(live.length, 1);
      sweepStaleSystemPromptFiles();
      assert.equal(fs.existsSync(path.join(os.tmpdir(), live[0])), true, "live run's file kept");
      sp.kill("SIGKILL");
      await closed;
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(fs.existsSync(path.join(os.tmpdir(), live[0])), false, "removed after kill");
    } finally {
      process.env.CLAUDE_BIN = prevBin;
    }
  });

  it("exit cleanup removes files of CLI processes that are still running", async () => {
    // Fake CLI that hangs: the close handler never runs before cleanup
    const hang = path.join(tmpDir, "claude-hang");
    fs.writeFileSync(hang, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    const prevBin = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = hang;
    const sp = new ClaudeSubprocess();
    try {
      await sp.start("x", { model: "haiku", systemPrompt: "geheim", systemPromptMode: "append" });
      const live = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`cmap-sp-${process.pid}-`));
      assert.equal(live.length, 1);
      cleanupLiveSystemPromptFiles();
      assert.equal(fs.existsSync(path.join(os.tmpdir(), live[0])), false);
    } finally {
      sp.kill("SIGKILL");
      process.env.CLAUDE_BIN = prevBin;
    }
  });
});
