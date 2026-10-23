/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
  isThinkingDelta,
} from "../types/claude-cli.js";
import type { ClaudeModel, CliImage, ClaudeEffort } from "../adapter/openai-to-cli.js";
import { isOpenClawMappingEnabled } from "../adapter/system-prompt.js";
import os from "os";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  /** Resume an existing persisted session (sessionId) instead of creating a new one */
  resume?: boolean;
  cwd?: string;
  timeout?: number;
  /** Reasoning effort passed through to the CLI via --effort */
  effort?: ClaudeEffort;
  /** Disable all built-in CLI tools (when the client provides its own tool list) */
  disableBuiltinTools?: boolean;
  /** Images sent inline to the CLI as image content blocks (stream-json input) */
  images?: CliImage[];
  /** MCP config file exposing client tools (native tool mode, see tool-runs.ts) */
  mcpConfigPath?: string;
  /** Client system prompt (SYSTEM_PROMPT_MODE=append|replace), passed via a temp file */
  systemPrompt?: string;
  /** append: added to Claude Code's default system prompt; replace: replaces it */
  systemPromptMode?: "append" | "replace";
}

/** Max size per image (decoded), 20 MB - generous but bounded */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Image ready to be sent inline (Anthropic image content block) */
export interface InlineImage {
  mediaType: string;
  data: string; // base64
}

/**
 * Detect the real image type from magic bytes. The API rejects a media_type
 * that does not match the data, and clients' declared MIME types are not
 * always right - so never trust the header alone.
 * Returns null for formats the API cannot read (e.g. HEIC, BMP, SVG).
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Download a remote image with timeout and a streaming size limit */
async function downloadImage(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok || !res.body) return null;
  if (Number(res.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) return null;
  // Abort as soon as the body exceeds the limit instead of buffering it all
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of res.body) {
    received += (chunk as Buffer).length;
    if (received > MAX_IMAGE_BYTES) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Turn request images into inline image blocks. Remote URLs are downloaded;
 * unsupported, oversized or unreachable images are skipped and counted.
 */
export async function prepareInlineImages(
  images: CliImage[]
): Promise<{ images: InlineImage[]; skipped: number }> {
  const ready: InlineImage[] = [];
  let skipped = 0;
  for (const img of images) {
    try {
      const buf = img.sourceUrl ? await downloadImage(img.sourceUrl) : Buffer.from(img.data, "base64");
      const mediaType = buf && buf.length > 0 && buf.length <= MAX_IMAGE_BYTES ? sniffImageType(buf) : null;
      if (!buf || !mediaType) {
        skipped++;
        continue;
      }
      ready.push({ mediaType, data: img.sourceUrl ? buf.toString("base64") : img.data });
    } catch {
      skipped++;
    }
  }
  return { images: ready, skipped };
}

/** One stream-json user message: image blocks first, then the prompt text */
export function buildStreamJsonUserMessage(prompt: string, images: InlineImage[]): string {
  return (
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          ...images.map((i) => ({
            type: "image",
            source: { type: "base64", media_type: i.mediaType, data: i.data },
          })),
          { type: "text", text: prompt },
        ],
      },
    }) + "\n"
  );
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes

/**
 * THINKING_DISPLAY controls how the CLI returns thinking text:
 *   summarized (default) - streamed prose summaries of Claude's reasoning
 *   omitted              - no thinking text (CLI default on subscription auth)
 *   off / none / ""      - don't pass the flag at all
 */
export function resolveThinkingDisplay(): string | undefined {
  const raw = (process.env.THINKING_DISPLAY ?? "summarized").trim().toLowerCase();
  if (raw !== "summarized" && raw !== "omitted") return undefined;
  // An unknown flag would make every request fail - only pass it when the
  // installed CLI supports it (checked once, cached)
  return cliSupportsThinkingDisplay() ? raw : undefined;
}

let thinkingDisplaySupport: boolean | null = null;

function cliSupportsThinkingDisplay(): boolean {
  if (thinkingDisplaySupport !== null) return thinkingDisplaySupport;
  try {
    // The flag is hidden from --help. Probe it without an API call: --print
    // with empty stdin fails fast either way, but an unknown option fails
    // with "unknown option" before input is even read.
    const { bin, shell } = resolveClaudeBin();
    const probe = spawnSync(
      bin,
      ["--print", "--thinking-display", "summarized", "--no-session-persistence"],
      { encoding: "utf8", timeout: 15_000, shell, input: "" }
    );
    const output = `${probe.stdout || ""}${probe.stderr || ""}`;
    thinkingDisplaySupport = !probe.error && !/unknown option/i.test(output);
  } catch {
    thinkingDisplaySupport = false;
  }
  if (!thinkingDisplaySupport) {
    console.error("[Subprocess] Claude CLI has no --thinking-display flag - thinking summaries disabled");
  }
  return thinkingDisplaySupport;
}

/**
 * Detect authentication/authorization failures from CLI stderr or exit codes.
 * The CLI surfaces expired OAuth tokens as 401/authentication_error text on
 * stderr (there is no structured error type in stream-json), so we match the
 * known signatures.
 */
export function isAuthError(stderr: string, exitCode: number | null): boolean {
  if (exitCode === 401) return true;
  const text = stderr.toLowerCase();
  return (
    text.includes("authentication_error") ||
    text.includes("authentication failed") ||
    text.includes("failed to authenticate") ||
    text.includes("oauth session expired") ||
    text.includes("could not be refreshed") ||
    (text.includes("401") && text.includes("unauthorized")) ||
    text.includes("oauth token has expired") ||
    text.includes("token expired") ||
    text.includes("invalid oauth token") ||
    (text.includes("not logged in") && text.includes("claude")) ||
    text.includes("please run /login") ||
    text.includes("please run claude auth login")
  );
}

/**
 * System prompt appended to Claude CLI to map OpenClaw tool names to Claude Code equivalents.
 * OpenClaw's system prompt references tools like `exec`, `read`, `web_search` etc. that
 * don't exist in Claude Code. This mapping tells the model what to use instead.
 */
const OPENCLAW_TOOL_MAPPING_PROMPT = [
  "## Tool Name Mapping",
  "You are running inside Claude Code CLI, not OpenClaw. The system prompt may reference OpenClaw tool names — map them to your actual tools:",
  "",
  "### Direct tool replacements",
  "- `exec` or `process` → use `Bash` (run shell commands)",
  "- `read` → use `Read` (read file contents)",
  "- `write` → use `Write` (write files)",
  "- `edit` → use `Edit` (edit files)",
  "- `grep` → use `Grep` (search file contents)",
  "- `find` or `ls` → use `Glob` or `Bash(ls ...)`",
  "- `web_search` → use `WebSearch`",
  "- `web_fetch` → use `WebFetch`",
  "- `image` → use `Read` (Claude Code can read images)",
  "",
  "### OpenClaw CLI tools (use via Bash)",
  "These OpenClaw tools are available through the `openclaw` CLI. Use `Bash` to run them:",
  '- `memory_search` → `Bash(openclaw memory search "<query>")` — semantic search across memory files',
  "- `memory_get` → `Read` on the memory file directly, OR `Bash(openclaw memory search \"<query>\")` for discovery",
  '- `message` → `Bash(openclaw message send --to <target> "<text>")` — send messages to channels (Telegram, Discord, etc.)',
  "  - Also: `openclaw message read`, `openclaw message broadcast`, `openclaw message react`, `openclaw message poll`",
  "- `cron` → `Bash(openclaw cron list)`, `Bash(openclaw cron add ...)`, `Bash(openclaw cron status)` — manage scheduled jobs",
  "  - Also: `openclaw cron rm`, `openclaw cron enable`, `openclaw cron disable`, `openclaw cron runs`, `openclaw cron run`, `openclaw cron edit`",
  '- `sessions_list` → `Bash(openclaw agent --local --message "list sessions")` or check session files directly',
  '- `sessions_history` → `Bash(openclaw agent --local --message "show history for session <key>")` or check session files',
  "- `nodes` → `Bash(openclaw nodes status)`, `Bash(openclaw nodes describe <node>)`, `Bash(openclaw nodes invoke --node <id> --command <cmd>)`",
  '  - Also: `openclaw nodes run --node <id> "<shell command>"` for running commands on paired nodes',
  "",
  "### Not available via CLI",
  "- `browser` — requires OpenClaw's dedicated browser server (no CLI equivalent)",
  "- `canvas` — requires paired node with canvas capability; use `openclaw nodes invoke` if a node is available",
  "",
  "### Skills",
  "When a skill says to run a bash/python command, use the `Bash` tool directly.",
  "Skills are located in the `skills/` directory relative to your working directory.",
  "To use a skill: `Read` its SKILL.md file first, then follow the instructions using `Bash`.",
  "Run `openclaw skills list --eligible --json` to see all available skills.",
].join("\n");

/**
 * Resolve the real Claude CLI binary to spawn.
 *
 * On Windows, the global `claude` command is an npm shim (`claude.cmd`) that
 * just execs a bundled `claude.exe`. Running the shim requires `shell: true`,
 * which routes our argv through cmd.exe — and cmd.exe treats characters our
 * appended system prompt legitimately contains (`<`, `>`, `(`, `)`, `&`) as
 * redirection/grouping/chaining operators, corrupting the argument list that
 * follows (notably `--session-id`/`--resume`, which silently stop working).
 * Resolving straight to the `.exe` lets us spawn with `shell: false` and
 * skip cmd.exe entirely. Falls back to the shim (with shell:true) if the
 * `.exe` can't be located.
 */
let resolvedClaudeBin: { bin: string; shell: boolean } | null = null;

function resolveClaudeBin(): { bin: string; shell: boolean } {
  if (process.env.CLAUDE_BIN) {
    // Environment overrides are intentionally not cached. This lets callers
    // temporarily select a binary without contaminating later resolutions.
    return { bin: process.env.CLAUDE_BIN, shell: false };
  }

  if (resolvedClaudeBin) return resolvedClaudeBin;

  if (process.platform === "win32") {
    try {
      const where = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
      const shimPath = (where.stdout || "")
        .split(/\r?\n/)
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().endsWith(".cmd"));

      if (shimPath) {
        const shimDir = path.dirname(shimPath);
        const shimContent = readFileSync(shimPath, "utf8");
        const match = shimContent.match(/"%dp0%\\(.+?\.exe)"/i);
        if (match) {
          const exePath = path.join(shimDir, match[1]);
          resolvedClaudeBin = { bin: exePath, shell: false };
          return resolvedClaudeBin;
        }
      }
    } catch {
      // Fall through to shim fallback below
    }

    resolvedClaudeBin = { bin: "claude", shell: true };
    return resolvedClaudeBin;
  }

  resolvedClaudeBin = { bin: "claude", shell: false };
  return resolvedClaudeBin;
}

/**
 * Kill a process and its full descendant tree.
 *
 * `ChildProcess.kill()` only signals the direct child. On Windows this is
 * insufficient because the Claude CLI spawns its own subprocesses (e.g. for
 * Bash tool calls) that aren't part of a job object — killing just the
 * parent leaves them running in the background even after a client
 * disconnect or timeout. `taskkill /T` walks the whole tree instead.
 */
function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): boolean {
  const pid = child.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return true;
    }

    // If taskkill could not be started or rejected the request, still make a
    // best-effort attempt to stop the managed root process. This must not be
    // reported as a successful tree termination: descendants may still be
    // running, and callers must remain able to retry.
    try {
      child.kill(signal);
    } catch {}
    return false;
  }

  try {
    return child.kill(signal);
  } catch {
    // Process may have already exited
    return false;
  }
}

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private stderrBuffer: string = "";
  private exitCode: number | null = null;
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private systemPromptDir: string | null = null;
  private systemPromptFile: string | null = null;

  /**
   * Write the client system prompt to a private temp file. A file instead of
   * an argv string: system prompts (OpenWebUI + RAG context) can exceed the
   * per-argument limit (E2BIG) and must not show up in process listings.
   */
  private async writeSystemPromptFile(text: string): Promise<string> {
    this.systemPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmap-sp-"));
    const file = path.join(this.systemPromptDir, "system-prompt.md");
    await fs.writeFile(file, text, { encoding: "utf8", mode: 0o600 });
    this.systemPromptFile = file;
    return file;
  }

  private cleanupSystemPromptFile(): void {
    const dir = this.systemPromptDir;
    this.systemPromptDir = null;
    this.systemPromptFile = null;
    if (dir) {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    // Images go inline as content blocks (stream-json input) - no temp files,
    // no Read tool needed, so they also work when built-in tools are disabled
    let inlineImages: InlineImage[] = [];
    if (options.images && options.images.length > 0) {
      const prepared = await prepareInlineImages(options.images);
      inlineImages = prepared.images;
      if (prepared.skipped > 0) {
        console.error(
          `[Subprocess] ${prepared.skipped} image(s) skipped (unsupported format, too large or unreachable)`
        );
        prompt =
          `[Note: ${prepared.skipped} attached image(s) could not be passed on ` +
          `(unsupported format, too large or unreachable). Tell the user.]\n\n` +
          prompt;
      }
    }
    const stdinPayload =
      inlineImages.length > 0 ? buildStreamJsonUserMessage(prompt, inlineImages) : prompt;
    inlineImages = []; // don't hold base64 longer than needed

    if (options.systemPrompt && options.systemPromptMode) {
      await this.writeSystemPromptFile(options.systemPrompt);
    }

    const args = this.buildArgs(options, stdinPayload !== prompt);
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    if (process.env.DEBUG_SUBPROCESS) {
      console.error(`[Subprocess] args: ${JSON.stringify(args)}`);
      console.error(`[Subprocess] prompt: ${prompt.slice(0, 200)}`);
    }

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        const { bin, shell } = resolveClaudeBin();
        this.process = spawn(bin, args, {
          cwd: options.cwd || process.cwd(),
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
          shell,
        });

        this.armTimeout(timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          this.cleanupSystemPromptFile();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large inputs
        this.process.stdin?.write(stdinPayload);
        this.process.stdin?.end();

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging and auth-error detection
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Keep a bounded tail (4 KB) - enough for error signatures
            this.stderrBuffer = (this.stderrBuffer + errorText + "\n").slice(-4096);
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          this.exitCode = code;
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          this.cleanupSystemPromptFile();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        this.cleanupSystemPromptFile();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(options: SubprocessOptions, streamJsonInput = false): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--dangerously-skip-permissions", // Skip permission prompts
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      // Prompt is passed via stdin (avoids E2BIG on large inputs)
    ];

    // Client system prompt (SYSTEM_PROMPT_MODE=append|replace). replace swaps
    // out Claude Code's default system prompt; append adds to it.
    if (this.systemPromptFile && options.systemPromptMode === "replace") {
      args.push("--system-prompt-file", this.systemPromptFile);
    } else if (this.systemPromptFile) {
      args.push("--append-system-prompt-file", this.systemPromptFile);
    }

    // The OpenClaw mapping points tool names at Bash/Read/... - meaningless
    // (and misleading) when the client brings its own tools instead.
    // OPENCLAW_TOOL_MAPPING=off drops it for non-OpenClaw clients (OpenWebUI).
    if (!options.disableBuiltinTools && isOpenClawMappingEnabled()) {
      args.push("--append-system-prompt", OPENCLAW_TOOL_MAPPING_PROMPT);
    }

    if (options.effort) {
      args.push("--effort", options.effort);
    }

    // Thinking text is omitted by default on subscription auth - request
    // summaries so clients (OpenWebUI) can show what Claude is reasoning about
    const thinkingDisplay = resolveThinkingDisplay();
    if (thinkingDisplay) {
      args.push("--thinking-display", thinkingDisplay);
    }

    // Inline images: stdin carries one stream-json user message instead of text
    if (streamJsonInput) {
      args.push("--input-format", "stream-json");
    }

    // Client-provided tools (OpenAI function calling): the CLI must NOT execute
    // anything itself - no Bash, no Read, nothing. Execution happens client-side.
    if (options.disableBuiltinTools) {
      args.push("--tools", "");
    }

    if (options.sessionId && options.resume) {
      // Continue a previously persisted session — avoids replaying full history
      args.push("--resume", options.sessionId);
    } else if (options.sessionId) {
      // First turn for this session key — create it under a known ID so we
      // can --resume it on subsequent turns
      args.push("--session-id", options.sessionId);
    } else {
      // No stable session key (e.g. request.user missing) — don't leave
      // orphaned session files behind
      args.push("--no-session-persistence");
    }

    // Client tools via MCP: only our bridge, no user/project MCP servers.
    // Kept last - --mcp-config is variadic.
    if (options.mcpConfigPath) {
      args.push("--strict-mcp-config", "--mcp-config", options.mcpConfigPath);
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isThinkingDelta(message)) {
          // Extended thinking stream (visible when effort > default)
          this.emit("thinking_delta", message as unknown as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.clearTimeout();
      this.isKilled = killProcessTree(this.process, signal);
    }
  }

  /**
   * True if the subprocess failed due to an authentication problem
   * (expired OAuth token, logged out). Check after "close"/"error".
   */
  hasAuthError(): boolean {
    return isAuthError(this.stderrBuffer, this.exitCode);
  }

  /**
   * Arm the request timeout. Kept narrow so tests can deterministically re-arm
   * the production timeout behavior after their fixture process tree is ready.
   */
  private armTimeout(timeout: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        if (this.process) {
          this.isKilled = killProcessTree(this.process, "SIGTERM");
        }
        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
      }
    }, timeout);
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const { bin, shell } = resolveClaudeBin();
    const proc = spawn(bin, ["--version"], { stdio: "pipe", shell });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
