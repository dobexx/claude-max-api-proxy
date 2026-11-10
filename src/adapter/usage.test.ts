/**
 * Usage reporting: OpenAI prompt_tokens must be the FULL prompt (incl. cached
 * tokens), and for multi-call runs the LAST call's usage, not the run total.
 * OpenWebUI's context compaction compares prompt_tokens against its threshold.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIUsage, LastCallUsage, cliResultToOpenai } from "./cli-to-openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

describe("toOpenAIUsage", () => {
  it("counts cached tokens into prompt_tokens", () => {
    // Real values of the failing OpenWebUI turn (10.11.2026, 08:28)
    const u = toOpenAIUsage({
      input_tokens: 2,
      cache_read_input_tokens: 167682,
      cache_creation_input_tokens: 820036,
      output_tokens: 596,
    })!;
    assert.equal(u.prompt_tokens, 2 + 167682 + 820036);
    assert.equal(u.completion_tokens, 596);
    assert.equal(u.total_tokens, 2 + 167682 + 820036 + 596);
    assert.equal(u.cache_read_input_tokens, 167682);
    assert.equal(u.cache_creation_input_tokens, 820036);
  });

  it("handles missing fields and no usage at all", () => {
    assert.equal(toOpenAIUsage(undefined), undefined);
    assert.equal(toOpenAIUsage(null), undefined);
    assert.deepEqual(toOpenAIUsage({ input_tokens: 5, output_tokens: 2 }), {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
    });
  });
});

describe("LastCallUsage", () => {
  const start = (usage: Record<string, number>) => ({
    type: "stream_event",
    event: { type: "message_start", message: { usage } },
  });
  const delta = (output_tokens: number) => ({
    type: "stream_event",
    event: { type: "message_delta", usage: { output_tokens } },
  });

  it("reports the last model call of a run, not the summed result", () => {
    const t = new LastCallUsage();
    // call 1 (asks for a tool)
    t.observe(start({ input_tokens: 3, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000 }));
    t.observe(delta(40));
    // call 2 (final answer, context grew by the tool result)
    t.observe(start({ input_tokens: 4, cache_read_input_tokens: 105_000, cache_creation_input_tokens: 8_000 }));
    t.observe(delta(300));
    const summed = {
      input_tokens: 7,
      cache_read_input_tokens: 205_000,
      cache_creation_input_tokens: 13_000,
      output_tokens: 340,
    };
    const u = t.usage(summed)!;
    assert.equal(u.prompt_tokens, 4 + 105_000 + 8_000);
    assert.equal(u.completion_tokens, 300);
  });

  it("falls back to the result usage when no stream events were seen", () => {
    const t = new LastCallUsage();
    t.observe({ type: "system", subtype: "init" });
    const u = t.usage({ input_tokens: 1, cache_read_input_tokens: 99, output_tokens: 3 })!;
    assert.equal(u.prompt_tokens, 100);
    assert.equal(u.completion_tokens, 3);
  });
});

describe("cliResultToOpenai usage", () => {
  const result = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 9 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 0, outputTokens: 0, costUSD: 0 } },
  } as unknown as ClaudeCliResult;

  it("includes cached tokens by default", () => {
    assert.equal(cliResultToOpenai(result, "r").usage.prompt_tokens, 1502);
  });

  it("prefers an explicitly passed (last-call) usage", () => {
    const u = { prompt_tokens: 42, completion_tokens: 1, total_tokens: 43 };
    assert.deepEqual(cliResultToOpenai(result, "r", undefined, u).usage, u);
  });
});
