/**
 * Native client-tool runs (TOOL_MODE=mcp, default).
 *
 * The client's OpenAI tools are exposed to the Claude CLI through the MCP
 * bridge (src/mcp/bridge.ts). One OpenAI conversation turn that involves
 * tools can span several HTTP requests, but only ONE CLI process:
 *
 *   request 1  ->  CLI streams text + tool_use blocks  ->  we stream text and
 *                  OpenAI tool_calls chunks live, finish with
 *                  finish_reason "tool_calls" and PARK the run. The CLI is
 *                  now blocked inside an MCP tools/call that we hold open.
 *   request 2  ->  carries role="tool" results. We find the parked run via
 *                  tool_call_id, answer the held MCP calls and attach the new
 *                  HTTP response. The CLI continues in the same process and
 *                  streams into request 2.
 *
 * Fallback: if no follow-up arrives within TOOL_RESULT_TIMEOUT_MS, the run is
 * killed. A late follow-up then starts a fresh run that replays the full
 * history (including the tool calls and results) as text.
 */

import type { Response } from "express";
import { randomBytes, createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ClaudeSubprocess, isAuthError } from "../subprocess/manager.js";
import { extractText, type CliInput } from "../adapter/openai-to-cli.js";
import { normalizeModelName } from "../adapter/cli-to-openai.js";
import {
  getBridgeBaseUrl,
  registerEndpoint,
  unregisterEndpoint,
  type McpToolCall,
  type McpToolResult,
  type McpToolSpec,
} from "../mcp/bridge.js";
import { setSession, clearSession } from "../subprocess/session-store.js";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIToolDefinition,
} from "../types/openai.js";
import type { ClaudeCliMessage, ClaudeCliResult } from "../types/claude-cli.js";
import { AUTH_EXPIRED_MESSAGE } from "./messages.js";

export type ToolMode = "mcp" | "prompt";

/** TOOL_MODE=prompt restores the legacy <tool_call> text-envelope mode */
export function getToolMode(): ToolMode {
  return (process.env.TOOL_MODE || "mcp").trim().toLowerCase() === "prompt" ? "prompt" : "mcp";
}

const MCP_SERVER_NAME = "client";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** Claude tool names are limited to 64 chars - the CLI adds MCP_PREFIX */
const MAX_TOOL_NAME = 64 - MCP_PREFIX.length;

function envMs(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
/** How long a parked run waits for the client's tool results */
const toolResultTimeoutMs = () => envMs("TOOL_RESULT_TIMEOUT_MS", 10 * 60 * 1000);
/** Hard limit for one CLI process across all its tool round trips */
const toolRunMaxMs = () => envMs("TOOL_RUN_MAX_MS", 60 * 60 * 1000);

// ─── Response sinks ─────────────────────────────────────────────────

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type FinishReason = "stop" | "tool_calls" | "length";

/** One HTTP response that a run streams into (one per OpenAI request) */
interface TurnSink {
  readonly finished: boolean;
  readonly emittedText: boolean;
  readonly emittedToolCalls: boolean;
  readonly done: Promise<void>;
  text(t: string): void;
  reasoning(t: string): void;
  toolCallStart(index: number, id: string, name: string): void;
  toolCallArgs(index: number, partial: string): void;
  finish(reason: FinishReason, usage?: Usage): void;
  fail(message: string): void;
  authExpired(): void;
  /** Called when the client disconnects before the sink finished */
  onClientGone(cb: () => void): void;
}

class StreamingSink implements TurnSink {
  finished = false;
  emittedText = false;
  emittedToolCalls = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private roleSent = false;
  private goneCb: (() => void) | null = null;

  constructor(
    private res: Response,
    private requestId: string,
    private model: () => string
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Request-Id", requestId);
    res.flushHeaders();
    res.write(":ok\n\n");
    res.on("close", () => {
      if (!this.finished) {
        this.finished = true;
        this.goneCb?.();
      }
      this.resolveDone();
    });
  }

  onClientGone(cb: () => void): void {
    this.goneCb = cb;
  }

  private write(delta: Record<string, unknown>, finishReason: FinishReason | null = null, usage?: Usage): void {
    if (this.finished || this.res.writableEnded) return;
    if (!this.roleSent) {
      delta = { role: "assistant", ...delta };
      this.roleSent = true;
    }
    const chunk: Record<string, unknown> = {
      id: `chatcmpl-${this.requestId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model(),
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  private end(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.res.writableEnded) {
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
    this.resolveDone();
  }

  text(t: string): void {
    if (!t) return;
    this.write({ content: t });
    this.emittedText = true;
  }

  reasoning(t: string): void {
    if (t) this.write({ reasoning: t });
  }

  toolCallStart(index: number, id: string, name: string): void {
    this.write({
      tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
    });
    this.emittedToolCalls = true;
  }

  toolCallArgs(index: number, partial: string): void {
    if (partial) this.write({ tool_calls: [{ index, function: { arguments: partial } }] });
  }

  finish(reason: FinishReason, usage?: Usage): void {
    this.write({}, reason, usage);
    this.end();
  }

  fail(message: string): void {
    if (!this.finished && !this.res.writableEnded) {
      this.res.write(
        `data: ${JSON.stringify({ error: { message, type: "server_error", code: null } })}\n\n`
      );
    }
    this.end();
  }

  authExpired(): void {
    this.text(AUTH_EXPIRED_MESSAGE);
    this.finish("stop");
  }
}

class NonStreamingSink implements TurnSink {
  finished = false;
  emittedText = false;
  emittedToolCalls = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private content = "";
  private toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  private goneCb: (() => void) | null = null;

  constructor(
    private res: Response,
    private requestId: string,
    private model: () => string
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
    res.on("close", () => {
      if (!this.finished) {
        this.finished = true;
        this.goneCb?.();
      }
      this.resolveDone();
    });
  }

  onClientGone(cb: () => void): void {
    this.goneCb = cb;
  }

  text(t: string): void {
    if (!t) return;
    this.content += t;
    this.emittedText = true;
  }

  reasoning(): void {
    // Non-streaming responses carry no reasoning field
  }

  toolCallStart(index: number, id: string, name: string): void {
    this.toolCalls[index] = { id, type: "function", function: { name, arguments: "" } };
    this.emittedToolCalls = true;
  }

  toolCallArgs(index: number, partial: string): void {
    const tc = this.toolCalls[index];
    if (tc) tc.function.arguments += partial;
  }

  finish(reason: FinishReason, usage?: Usage): void {
    if (this.finished) return;
    this.finished = true;
    const calls = this.toolCalls.filter(Boolean);
    if (!this.res.headersSent) {
      this.res.json({
        id: `chatcmpl-${this.requestId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: this.model(),
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: this.content || (calls.length > 0 ? null : ""),
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          },
          finish_reason: reason,
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    this.resolveDone();
  }

  fail(message: string): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.res.headersSent) {
      this.res.status(500).json({ error: { message, type: "server_error", code: null } });
    }
    this.resolveDone();
  }

  authExpired(): void {
    this.content = AUTH_EXPIRED_MESSAGE;
    this.toolCalls = [];
    this.finish("stop");
  }
}

// ─── Run registry ───────────────────────────────────────────────────

const runs = new Set<ToolRun>();
/** OpenAI tool_call_id -> run that is waiting for its result */
const runsByCallId = new Map<string, ToolRun>();

function toCallId(toolUseId: string): string {
  return `call_${toolUseId.replace(/^toolu_/, "")}`;
}

function toUsage(u?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): Usage | undefined {
  if (!u) return undefined;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(u.cache_read_input_tokens ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens
      ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
      : {}),
  };
}

/** Loose view of a stream_event - the typed union doesn't cover message_delta */
interface RawStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { model?: string; usage?: Record<string, number> };
  usage?: Record<string, number>;
}

/**
 * Map client tool names to MCP-safe names (<= MAX_TOOL_NAME, [A-Za-z0-9_-]).
 * Returns the MCP tool specs plus a reverse lookup MCP name -> client name.
 */
function buildToolSpecs(tools: OpenAIToolDefinition[]): {
  specs: McpToolSpec[];
  reverse: Map<string, string>;
} {
  const specs: McpToolSpec[] = [];
  const reverse = new Map<string, string>();
  for (const t of tools) {
    if (t.type !== "function" || !t.function?.name) continue;
    const clientName = t.function.name;
    let name = clientName.replace(/[^A-Za-z0-9_-]/g, "_");
    if (name.length > MAX_TOOL_NAME || reverse.has(name)) {
      const hash = createHash("sha1").update(clientName).digest("hex").slice(0, 8);
      name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
    }
    const params = (t.function.parameters || {}) as Record<string, unknown>;
    specs.push({
      name,
      description: t.function.description,
      inputSchema: { ...params, type: "object" },
    });
    reverse.set(name, clientName);
  }
  return { specs, reverse };
}

interface ToolRunOptions {
  cliInput: CliInput;
  tools: OpenAIToolDefinition[];
  sessionKey: string | undefined;
  resume: boolean;
  messageCount: number;
}

class ToolRun {
  readonly runId = randomBytes(12).toString("hex");
  readonly sessionKey: string | undefined;
  private readonly token = randomBytes(32).toString("hex");
  private readonly subprocess = new ClaudeSubprocess();
  private state: "active" | "parked" | "done" = "active";
  private sink: TurnSink | null = null;
  private configPath = "";
  private model = "claude-sonnet-4";
  private messageCount: number;
  private parkTimer: NodeJS.Timeout | null = null;
  private cleanedUp = false;

  private readonly specs: McpToolSpec[];
  private readonly reverseNames: Map<string, string>;

  // Per assistant message: stream block index -> OpenAI tool_calls index
  private blockToCall = new Map<number, number>();
  // Per HTTP response: tool calls announced to the client
  private turnCalls: Array<{ callId: string; toolUseId: string }> = [];
  private turnUsage: Usage | undefined;
  // Tool plumbing (keyed by Claude's tool_use id)
  private awaitingResults = new Map<string, string>(); // toolUseId -> callId
  private pendingCalls = new Map<string, McpToolCall>();
  private deliveredResults = new Map<string, McpToolResult>();

  constructor(private opts: ToolRunOptions) {
    this.sessionKey = opts.sessionKey;
    this.messageCount = opts.messageCount;
    const { specs, reverse } = buildToolSpecs(opts.tools);
    this.specs = specs;
    this.reverseNames = reverse;
  }

  get isParked(): boolean {
    return this.state === "parked";
  }

  /** Model name for response chunks (known once the CLI starts streaming) */
  get currentModel(): string {
    return this.model;
  }

  async start(sink: TurnSink): Promise<void> {
    runs.add(this);
    this.attach(sink);
    try {
      const baseUrl = await getBridgeBaseUrl();
      registerEndpoint(this.runId, {
        token: this.token,
        tools: this.specs,
        onToolCall: (call) => this.onToolCall(call),
      });
      this.configPath = path.join(os.tmpdir(), `cmap-mcp-${this.runId}.json`);
      const config = {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "http",
            url: `${baseUrl}/mcp/${this.runId}`,
            headers: { Authorization: `Bearer ${this.token}` },
            // Tools must be present in the first prompt, never deferred
            alwaysLoad: true,
            // CLI-side hard limit per tool call: above our own park timeout,
            // so the proxy decides when a run is abandoned
            timeout: toolResultTimeoutMs() + 60_000,
          },
        },
      };
      // 0600: the file carries the run's bearer token
      await fs.writeFile(this.configPath, JSON.stringify(config), { mode: 0o600 });

      this.subprocess.on("message", (msg: ClaudeCliMessage) => this.onMessage(msg));
      this.subprocess.on("result", (result: ClaudeCliResult) => this.onResult(result));
      this.subprocess.on("error", (err: Error) => this.terminate(err.message));
      this.subprocess.on("close", (code: number | null) => this.onClose(code));

      const { cliInput } = this.opts;
      await this.subprocess.start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
        resume: this.opts.resume,
        effort: cliInput.effort,
        disableBuiltinTools: true,
        mcpConfigPath: this.configPath,
        timeout: toolRunMaxMs(),
        images: cliInput.images,
      });
      delete cliInput.images; // don't hold base64 for the run's lifetime
    } catch (err) {
      this.terminate(err instanceof Error ? err.message : String(err));
    }
    return sink.done;
  }

  /** Attach the HTTP response the next CLI output should stream into */
  private attach(sink: TurnSink): void {
    this.sink = sink;
    this.turnCalls = [];
    this.turnUsage = undefined;
    sink.onClientGone(() => {
      if (this.sink === sink) this.terminate("Client disconnected");
    });
  }

  // ─── CLI output ────────────────────────────────────────────────

  private onMessage(msg: ClaudeCliMessage): void {
    // The model is known from the first event (system init)
    const init = msg as { type?: string; subtype?: string; model?: string };
    if (init.type === "system" && init.subtype === "init" && init.model) {
      this.model = normalizeModelName(init.model);
      return;
    }
    if (msg.type !== "stream_event") return;
    const ev = (msg as unknown as { event: RawStreamEvent }).event;
    const sink = this.sink;
    if (!sink || sink.finished) return;

    switch (ev.type) {
      case "message_start":
        this.blockToCall.clear();
        if (ev.message?.model) this.model = normalizeModelName(ev.message.model);
        this.turnUsage = toUsage(ev.message?.usage);
        break;

      case "content_block_start": {
        const block = ev.content_block;
        if (block?.type === "text" && sink.emittedText) {
          // Keep separate text blocks from running together
          sink.text("\n\n");
        } else if (block?.type === "tool_use" && block.id && block.name) {
          const clientName = this.clientToolName(block.name);
          if (!clientName) break; // not one of the client's tools
          const index = this.turnCalls.length;
          const callId = toCallId(block.id);
          this.turnCalls.push({ callId, toolUseId: block.id });
          if (ev.index !== undefined) this.blockToCall.set(ev.index, index);
          this.awaitingResults.set(block.id, callId);
          runsByCallId.set(callId, this);
          sink.toolCallStart(index, callId, clientName);
        }
        break;
      }

      case "content_block_delta": {
        const d = ev.delta;
        if (d?.type === "text_delta") sink.text(d.text || "");
        else if (d?.type === "thinking_delta") sink.reasoning(d.thinking || "");
        else if (d?.type === "input_json_delta" && ev.index !== undefined) {
          const index = this.blockToCall.get(ev.index);
          if (index !== undefined) sink.toolCallArgs(index, d.partial_json || "");
        }
        break;
      }

      case "message_delta": {
        if (ev.usage && this.turnUsage) {
          const out = ev.usage.output_tokens || 0;
          this.turnUsage.completion_tokens = out;
          this.turnUsage.total_tokens = this.turnUsage.prompt_tokens + out;
        }
        if (ev.delta?.stop_reason === "tool_use" && this.turnCalls.length > 0) {
          this.park();
        }
        break;
      }
    }
  }

  private clientToolName(cliName: string): string | undefined {
    if (!cliName.startsWith(MCP_PREFIX)) return undefined;
    return this.reverseNames.get(cliName.slice(MCP_PREFIX.length));
  }

  /** End the current response with tool_calls and wait for the client */
  private park(): void {
    const sink = this.sink;
    this.state = "parked";
    this.sink = null;
    sink?.finish("tool_calls", this.turnUsage);
    this.parkTimer = setTimeout(
      () => this.terminate("Timed out waiting for the client's tool results"),
      toolResultTimeoutMs()
    );
    this.parkTimer.unref();
  }

  private onResult(result: ClaudeCliResult): void {
    if (this.state === "done") return;
    this.state = "done";
    const sink = this.sink;
    const authFailed = isAuthError(result.result || "", null) || this.subprocess.hasAuthError();
    if (sink && !sink.finished) {
      if (authFailed) {
        sink.authExpired();
      } else {
        // Errors/early results may never have been streamed as deltas
        if (!sink.emittedText && !sink.emittedToolCalls && result.result) {
          sink.text(result.result);
        }
        sink.finish("stop", toUsage(result.usage));
      }
    }
    if (this.sessionKey) {
      if (!result.is_error && !authFailed && this.opts.cliInput.sessionId) {
        setSession(this.sessionKey, this.opts.cliInput.sessionId, this.messageCount);
      } else {
        clearSession(this.sessionKey);
      }
    }
  }

  private onClose(code: number | null): void {
    if (this.state !== "done") {
      this.state = "done";
      const sink = this.sink;
      if (sink && !sink.finished) {
        if (this.subprocess.hasAuthError()) sink.authExpired();
        else sink.fail(`Claude CLI exited with code ${code} without a result`);
      }
      if (this.sessionKey) clearSession(this.sessionKey);
    }
    this.cleanup();
  }

  // ─── Tool calls from the CLI (via MCP bridge) ──────────────────

  private onToolCall(call: McpToolCall): void {
    let toolUseId = call.toolUseId;
    if (!toolUseId) {
      // Older CLIs without _meta: match in announcement order
      toolUseId = [...this.awaitingResults.keys()].find((id) => !this.pendingCalls.has(id));
    }
    if (!toolUseId) {
      call.respond({ text: "Unknown tool call", isError: true });
      return;
    }
    const ready = this.deliveredResults.get(toolUseId);
    if (ready) {
      this.deliveredResults.delete(toolUseId);
      call.respond(ready);
      return;
    }
    const id = toolUseId;
    this.pendingCalls.set(id, call);
    call.onAbort(() => {
      this.pendingCalls.delete(id);
      // The CLI gave up on the call - the parked run can no longer continue
      if (this.state === "parked") this.terminate("Claude CLI aborted a pending tool call");
    });
    // The HTTP call can overtake the stdout event that announces the block.
    // If the id is still unknown shortly after, it was never announced to the
    // client (not one of its tools) - fail it instead of holding it forever.
    if (!this.awaitingResults.has(id)) {
      setTimeout(() => {
        if (this.pendingCalls.get(id) === call && !this.awaitingResults.has(id)) {
          this.pendingCalls.delete(id);
          call.respond({ text: `Tool call ${id} is not available`, isError: true });
        }
      }, 250).unref();
    }
  }

  // ─── Continuation (follow-up request with tool results) ───────

  continueWith(sink: TurnSink, toolMessages: OpenAIChatMessage[], messageCount: number): Promise<void> {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
    this.state = "active";
    this.messageCount = messageCount;
    this.attach(sink);

    const byId = new Map<string, OpenAIChatMessage>();
    for (const m of toolMessages) if (m.tool_call_id) byId.set(m.tool_call_id, m);

    for (const [toolUseId, callId] of this.awaitingResults) {
      const msg = byId.get(callId) || byId.get(toolUseId);
      const result: McpToolResult = msg
        ? { text: extractText(msg.content) || "(empty result)" }
        : { text: "The client returned no result for this tool call.", isError: true };
      const pending = this.pendingCalls.get(toolUseId);
      if (pending) {
        this.pendingCalls.delete(toolUseId);
        pending.respond(result);
      } else {
        // The CLI runs tools one after another - it asks for this one later
        this.deliveredResults.set(toolUseId, result);
      }
      runsByCallId.delete(callId);
    }
    this.awaitingResults.clear();
    return sink.done;
  }

  // ─── Teardown ──────────────────────────────────────────────────

  terminate(reason: string): void {
    if (this.state === "done") {
      this.cleanup();
      return;
    }
    console.error(`[ToolRun ${this.runId}] ${reason}`);
    this.state = "done";
    const sink = this.sink;
    if (sink && !sink.finished) sink.fail(reason);
    if (this.sessionKey) clearSession(this.sessionKey);
    this.subprocess.kill();
    this.cleanup();
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = null;
    unregisterEndpoint(this.runId);
    for (const [callId, run] of runsByCallId) {
      if (run === this) runsByCallId.delete(callId);
    }
    runs.delete(this);
    if (this.configPath) fs.rm(this.configPath, { force: true }).catch(() => {});
  }
}

// ─── Public entry points (used by routes.ts) ────────────────────────

export function hasTrailingToolResults(messages: OpenAIChatMessage[]): boolean {
  return messages.length > 0 && messages[messages.length - 1].role === "tool";
}

/** A new request for a conversation supersedes any run still parked for it */
function abandonParkedRuns(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  for (const run of runs) {
    if (run.sessionKey === sessionKey && run.isParked) {
      run.terminate("Superseded by a new request in the same conversation");
    }
  }
}

/**
 * If this request carries results for a parked run, continue that run and
 * return a promise that settles when the response is complete. Otherwise
 * return null so the caller handles the request normally.
 */
export function continueToolRun(
  body: OpenAIChatRequest,
  res: Response,
  requestId: string,
  stream: boolean
): Promise<void> | null {
  const toolMessages: OpenAIChatMessage[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) {
    toolMessages.unshift(body.messages[i]);
  }

  let run: ToolRun | undefined;
  for (const m of toolMessages) {
    const candidate = m.tool_call_id ? runsByCallId.get(m.tool_call_id) : undefined;
    if (candidate?.isParked) {
      run = candidate;
      break;
    }
  }

  if (!run) {
    abandonParkedRuns(body.user);
    return null;
  }

  const model = () => run!.currentModel;
  const sink = stream
    ? new StreamingSink(res, requestId, model)
    : new NonStreamingSink(res, requestId, model);
  return run.continueWith(sink, toolMessages, body.messages.length);
}

export async function startToolRun(opts: {
  res: Response;
  stream: boolean;
  requestId: string;
  cliInput: CliInput;
  tools: OpenAIToolDefinition[];
  sessionKey: string | undefined;
  resume: boolean;
  messageCount: number;
}): Promise<void> {
  const run = new ToolRun(opts);
  const model = () => run.currentModel;
  const sink = opts.stream
    ? new StreamingSink(opts.res, opts.requestId, model)
    : new NonStreamingSink(opts.res, opts.requestId, model);
  return run.start(sink);
}
