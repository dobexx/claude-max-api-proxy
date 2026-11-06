/**
 * Request body limit: large chats (tool results with base64 images) must
 * pass, oversized ones must get a clear 413 instead of an opaque 500.
 * No Claude CLI involved - auth rejects the request after body parsing.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import { startServer, stopServer, getBodyLimit, DEFAULT_BODY_LIMIT } from "./index.js";
import { initApiKey } from "./auth.js";

describe("getBodyLimit", () => {
  const saved = process.env.BODY_LIMIT;
  after(() => {
    if (saved === undefined) delete process.env.BODY_LIMIT;
    else process.env.BODY_LIMIT = saved;
  });

  it("defaults to 64mb", () => {
    delete process.env.BODY_LIMIT;
    assert.equal(getBodyLimit(), DEFAULT_BODY_LIMIT);
    assert.equal(DEFAULT_BODY_LIMIT, "64mb");
  });

  it("accepts size strings and plain byte counts", () => {
    process.env.BODY_LIMIT = "100mb";
    assert.equal(getBodyLimit(), "100mb");
    process.env.BODY_LIMIT = "2048";
    assert.equal(getBodyLimit(), "2048b");
  });
});

describe("request body limit (HTTP)", () => {
  let baseUrl: string;
  const savedLimit = process.env.BODY_LIMIT;
  const savedKey = process.env.PROXY_API_KEY;

  before(async () => {
    process.env.BODY_LIMIT = "1mb";
    process.env.PROXY_API_KEY = "test-key-body-limit";
    initApiKey();
    const server = await startServer({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await stopServer();
    if (savedLimit === undefined) delete process.env.BODY_LIMIT;
    else process.env.BODY_LIMIT = savedLimit;
    if (savedKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = savedKey;
    initApiKey();
  });

  const post = (bytes: number) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "a".repeat(bytes) }] }),
    });

  it("lets a body below the limit through to the next middleware", async () => {
    const r = await post(900 * 1024);
    // Parsed fine, then rejected by auth (wrong key) - proves the body passed
    assert.equal(r.status, 401);
  });

  it("answers an oversized body with 413 and a readable message", async () => {
    const r = await post(2 * 1024 * 1024);
    assert.equal(r.status, 413);
    const j = (await r.json()) as { error: { code: string; message: string } };
    assert.equal(j.error.code, "request_too_large");
    assert.match(j.error.message, /limit 1\.0 MB/);
    assert.match(j.error.message, /BODY_LIMIT/);
  });
});
