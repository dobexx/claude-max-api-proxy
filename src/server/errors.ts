/**
 * CLI errors as real OpenAI-style errors.
 *
 * When the Claude CLI fails before the model has produced any output
 * ("Prompt is too long", usage limit, unknown model, API errors, expired
 * login) it still ends with an ordinary `result` event: is_error: true, the
 * message in `result`. Forwarding that text as assistant content hides the
 * failure - clients store it as a normal reply, and OpenWebUI's context
 * compaction even keeps it as the chat summary. Instead the proxy answers
 * with an error:
 *   - non-streaming: HTTP status (400 / 401 / 404 / 429 / 5xx) + { error }
 *   - streaming:     `data: {"error": {...}}` followed by `data: [DONE]`
 *                    (the 200 header is already out; OpenWebUI stores this
 *                    as the message's error and shows it in red)
 */

import type { Response } from "express";
import { AUTH_EXPIRED_MESSAGE, UPSTREAM_BLOCKED_MESSAGE } from "./messages.js";
import { isLimitText } from "../accounts/pool.js";
import { isUpstreamBlock } from "../subprocess/manager.js";

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string | null };
}

export interface CliErrorInfo {
  status: number;
  body: OpenAIErrorBody;
}

interface CliErrorResult {
  is_error?: boolean;
  result?: string;
  subtype?: string;
  /** HTTP status of the failed API call, when the CLI reports one */
  api_error_status?: number | null;
}

const TOO_LONG_RE = /prompt is too long|input is too long|context (?:window|length) (?:exceeded|limit)/i;
const OVERLOADED_RE = /\boverloaded\b/i;
const MODEL_RE = /issue with the selected model/i;

export function errorBody(message: string, type: string, code: string | null): OpenAIErrorBody {
  return { error: { message, type, code } };
}

/** Anthropic/Cloudflare rejected the request (outage) - the login is fine */
export const UPSTREAM_ERROR: CliErrorInfo = {
  status: 503,
  body: errorBody(UPSTREAM_BLOCKED_MESSAGE, "api_error", "upstream_blocked"),
};

/** Expired / missing login: relogin guidance as the error message */
export const AUTH_ERROR: CliErrorInfo = {
  status: 401,
  body: errorBody(AUTH_EXPIRED_MESSAGE, "authentication_error", "auth_expired"),
};

/**
 * Map a failed CLI result to an HTTP status and an OpenAI error body.
 * Returns null for successful results.
 */
export function cliErrorInfo(result: CliErrorResult | null | undefined): CliErrorInfo | null {
  if (!result?.is_error) return null;
  const message =
    (result.result || "").trim() || `Claude CLI reported an error (${result.subtype || "unknown"})`;
  const api = typeof result.api_error_status === "number" ? result.api_error_status : null;

  // Outage page from Anthropic/Cloudflare: transient, the login is fine
  if (isUpstreamBlock(message)) {
    return {
      status: 503,
      body: errorBody(`${UPSTREAM_BLOCKED_MESSAGE} (CLI: ${message.slice(0, 160)})`, "api_error", "upstream_blocked"),
    };
  }
  if (TOO_LONG_RE.test(message)) {
    return { status: 400, body: errorBody(message, "invalid_request_error", "context_length_exceeded") };
  }
  if (api === 429 || isLimitText(message)) {
    return { status: 429, body: errorBody(message, "rate_limit_error", "rate_limit_exceeded") };
  }
  if (api === 529 || OVERLOADED_RE.test(message)) {
    return { status: 503, body: errorBody(message, "overloaded_error", "overloaded") };
  }
  if (api === 404 || MODEL_RE.test(message)) {
    return { status: 404, body: errorBody(message, "invalid_request_error", "model_not_found") };
  }
  if (api !== null && api >= 400 && api < 500) {
    return { status: api, body: errorBody(message, "invalid_request_error", null) };
  }
  if (api !== null && api >= 500) {
    return { status: 502, body: errorBody(message, "api_error", null) };
  }
  return { status: 500, body: errorBody(message, "server_error", null) };
}

/** Streaming form: one SSE error event plus the terminating [DONE] */
export function sseError(info: CliErrorInfo): string {
  return `data: ${JSON.stringify(info.body)}\n\ndata: [DONE]\n\n`;
}

/** One log line per error answer (the CLI's own message, shortened) */
export function logCliError(where: string, info: CliErrorInfo): void {
  const msg = info.body.error.message.replace(/\s+/g, " ").slice(0, 200);
  console.error(`[${where}] Error ${info.status} (${info.body.error.code ?? info.body.error.type}): ${msg}`);
}

/**
 * Send an error answer. Streaming: SSE error event + [DONE] (headers are set
 * here if they are not out yet). Non-streaming: HTTP status + JSON body.
 */
export function sendError(res: Response, info: CliErrorInfo, stream: boolean): void {
  if (stream) {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
    }
    if (!res.writableEnded) {
      res.write(sseError(info));
      res.end();
    }
    return;
  }
  if (!res.headersSent) res.status(info.status).json(info.body);
}
