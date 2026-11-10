/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIToolCall } from "../types/openai.js";

/** Token counts as the CLI reports them (Anthropic API usage block) */
export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Convert an Anthropic usage block into OpenAI usage.
 *
 * Anthropic's input_tokens only counts the UNCACHED part of the prompt. Claude
 * Code caches almost everything, so input_tokens is typically a single-digit
 * number while the real prompt is hundreds of thousands of tokens (in
 * cache_read/cache_creation). OpenAI's prompt_tokens means the whole prompt -
 * and clients rely on it: OpenWebUI's context compaction compares
 * prompt_tokens against its threshold. Reporting input_tokens alone made a
 * 1M-token chat look like a 600-token chat, so compaction never triggered.
 */
export function toOpenAIUsage(u?: CliUsage | null): OpenAIUsage | undefined {
  if (!u) return undefined;
  const n = (v?: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheCreation = n(u.cache_creation_input_tokens);
  const prompt = n(u.input_tokens) + cacheRead + cacheCreation;
  const completion = n(u.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}

/**
 * Tracks the usage of the LAST model call of a CLI run.
 *
 * The CLI's final `result.usage` is summed over every model call of the run
 * (one per tool round trip), so with tools it reports e.g. 27M cache-read
 * tokens for a 900k-token context. The context size a client needs is the
 * prompt of the last call plus its output - taken from the last
 * message_start (prompt incl. cache) and message_delta (output) events.
 */
export class LastCallUsage {
  private current: CliUsage | undefined;

  /** Feed every raw CLI message; picks up message_start / message_delta */
  observe(msg: unknown): void {
    const m = msg as { type?: string; event?: { type?: string; message?: { usage?: CliUsage }; usage?: CliUsage } };
    if (m?.type !== "stream_event" || !m.event) return;
    if (m.event.type === "message_start" && m.event.message?.usage) {
      this.current = { ...m.event.message.usage };
    } else if (m.event.type === "message_delta" && m.event.usage && this.current) {
      if (typeof m.event.usage.output_tokens === "number") {
        this.current.output_tokens = m.event.usage.output_tokens;
      }
    }
  }

  reset(): void {
    this.current = undefined;
  }

  /** OpenAI usage of the last call, falling back to the given (summed) usage */
  usage(fallback?: CliUsage | null): OpenAIUsage | undefined {
    return toOpenAIUsage(this.current ?? fallback);
  }
}

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  toolCalls?: OpenAIToolCall[],
  usage?: OpenAIUsage
): OpenAIChatResponse {
  // Get model from modelUsage or default
  const modelName = result.modelUsage
    ? Object.keys(result.modelUsage)[0]
    : "claude-sonnet-4";

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.result,
  };

  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: usage ??
      toOpenAIUsage(result.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Normalize Claude model names to a consistent format, keeping the version
 * but dropping date suffixes:
 *   "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
 *   "claude-opus-5-5"            -> "claude-opus-5-5"
 *   "claude-haiku-4-5-20251001"  -> "claude-haiku-4-5"
 *   "claude-opus-5"              -> "claude-opus-5"
 */
export function normalizeModelName(model: string | undefined): string {
  if (!model) return "claude-sonnet-4";
  // Major + optional single-digit minor; a date suffix (8 digits) is not a minor
  const m = model.match(/claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (m) return m[3] ? `claude-${m[1]}-${m[2]}-${m[3]}` : `claude-${m[1]}-${m[2]}`;
  if (model.includes("opus")) return "claude-opus-4";
  if (model.includes("sonnet")) return "claude-sonnet-4";
  if (model.includes("haiku")) return "claude-haiku-4";
  return model;
}
