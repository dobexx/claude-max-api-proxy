/**
 * MCP bridge: exposes client-provided OpenAI tools to the Claude CLI as a
 * Streamable-HTTP MCP server.
 *
 * Why: in --print mode Claude Code has no protocol for client-executed tools.
 * MCP gives us one - the CLI sees the client's tools as regular structured
 * tools, and every `tools/call` lands here. We hold the call open until the
 * OpenAI client delivers the result in its follow-up request.
 *
 * Security: the bridge listens on its own loopback-only server (random port),
 * separate from the public API. Every run gets its own endpoint
 * (/mcp/<runId>) protected by a random bearer token that only the spawned
 * CLI process knows (written to a 0600 temp config file).
 *
 * Long holds: tools/call is answered as Server-Sent Events. Headers go out
 * immediately and a comment heartbeat keeps the connection alive, so HTTP
 * client timeouts (headers/body) never fire while the client runs a tool.
 */

import http, { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import type { AddressInfo } from "net";

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpToolCall {
  /** Claude's tool_use id (from params._meta["claudecode/toolUseId"]) */
  toolUseId?: string;
  name: string;
  arguments: unknown;
  /** Deliver the result to the CLI. Safe to call more than once (no-op). */
  respond: (result: McpToolResult) => void;
  /** Register a callback for when the CLI drops the request before a result */
  onAbort: (cb: () => void) => void;
}

export interface McpRunEndpoint {
  token: string;
  tools: McpToolSpec[];
  onToolCall: (call: McpToolCall) => void;
}

const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const endpoints = new Map<string, McpRunEndpoint>();
let serverPromise: Promise<{ server: http.Server; baseUrl: string }> | null = null;

export function registerEndpoint(runId: string, endpoint: McpRunEndpoint): void {
  endpoints.set(runId, endpoint);
}

export function unregisterEndpoint(runId: string): void {
  endpoints.delete(runId);
}

/** Start the bridge lazily (first tool request) and return its base URL */
export async function getBridgeBaseUrl(): Promise<string> {
  if (!serverPromise) {
    serverPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          console.error("[MCP bridge] Error:", err instanceof Error ? err.message : err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.on("error", (err) => {
        serverPromise = null;
        reject(err);
      });
      server.listen(0, "127.0.0.1", () => {
        server.unref(); // never keep the process alive on its own
        const { port } = server.address() as AddressInfo;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  }
  return (await serverPromise).baseUrl;
}

export async function stopBridge(): Promise<void> {
  if (!serverPromise) return;
  const { server } = await serverPromise.catch(() => ({ server: null as http.Server | null }));
  serverPromise = null;
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("MCP request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = (req.url || "").match(/^\/mcp\/([A-Za-z0-9_-]+)$/);
  if (!match) return sendJson(res, 404, { error: "not found" });

  const runId = match[1];
  const endpoint = endpoints.get(runId);
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  // Unknown run and bad token look identical - no run-id probing
  if (!endpoint || !token || !safeEqual(token, endpoint.token)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET") {
    // No server-initiated SSE stream (spec allows 405 here)
    res.writeHead(405, { Allow: "POST, DELETE" });
    return void res.end();
  }
  if (req.method === "DELETE") {
    res.writeHead(200);
    return void res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST, DELETE" });
    return void res.end();
  }

  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  if (Array.isArray(msg)) {
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests are not supported" },
    });
  }

  // Notifications and responses carry no id - acknowledge without a body
  if (!msg.method || msg.id === undefined || msg.id === null) {
    res.writeHead(202);
    return void res.end();
  }

  const id = msg.id;
  const params = msg.params || {};

  switch (msg.method) {
    case "initialize":
      return sendJson(
        res,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "claude-max-api-proxy", version: "1.0.0" },
          },
        },
        { "Mcp-Session-Id": runId }
      );
    case "ping":
      return sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: endpoint.tools } });
    case "tools/call":
      return handleToolCall(res, endpoint, id, params);
    default:
      return sendJson(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
}

function handleToolCall(
  res: ServerResponse,
  endpoint: McpRunEndpoint,
  id: string | number,
  params: Record<string, unknown>
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  // First body byte right away: HTTP clients with a first-byte budget must
  // not time out while the OpenAI client is still running the tool
  res.write(": open\n\n");

  let settled = false;
  const abortCallbacks: Array<() => void> = [];
  const heartbeat = setInterval(() => {
    if (!settled) res.write(": keepalive\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  res.on("close", () => {
    clearInterval(heartbeat);
    if (!settled) {
      settled = true;
      for (const cb of abortCallbacks) cb();
    }
  });

  const meta = (params._meta || {}) as Record<string, unknown>;
  const toolUseId = typeof meta["claudecode/toolUseId"] === "string"
    ? (meta["claudecode/toolUseId"] as string)
    : undefined;

  endpoint.onToolCall({
    toolUseId,
    name: String(params.name || ""),
    arguments: params.arguments ?? {},
    onAbort: (cb) => abortCallbacks.push(cb),
    respond: (result) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      const payload = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: result.text }],
          isError: !!result.isError,
        },
      };
      res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    },
  });
}
