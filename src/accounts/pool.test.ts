/**
 * Unit tests for the account pool: placement, cache affinity, threshold,
 * limits, fingerprint. No CLI, no tokens.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  _resetAccountsForTests,
  getAccounts,
  getAccount,
  pickAccount,
  bindChat,
  setUtilization,
  observeRateLimit,
  markLimited,
  markAuthFailed,
  chatFingerprint,
  isLimitText,
  saveBindings,
  boundAccount,
} from "./pool.js";
import { parseUsage, bindingPercent } from "./usage.js";

let tmp = "";
const saved = { ...process.env };

function setup(names = ["loupz", "jungherz"], loggedIn = names): void {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmap-acc-"));
  for (const n of names) {
    fs.mkdirSync(path.join(tmp, n), { recursive: true });
    if (loggedIn.includes(n)) fs.writeFileSync(path.join(tmp, n, ".credentials.json"), "{}");
  }
  process.env.ACCOUNTS_DIR = tmp;
  process.env.ACCOUNTS = names.join(",");
  delete process.env.ACCOUNT_SWITCH_AT;
  delete process.env.ACCOUNT_STICKY_MINUTES;
  _resetAccountsForTests();
}

const acc = (n: string) => getAccount(n)!;

afterEach(() => {
  _resetAccountsForTests();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  process.env = { ...saved };
});

describe("account config", () => {
  beforeEach(() => setup());

  it("parses names and default directories", () => {
    assert.deepEqual(getAccounts().map((a) => a.name), ["loupz", "jungherz"]);
    assert.equal(acc("jungherz").configDir, path.join(tmp, "jungherz"));
  });

  it("accepts explicit directories and ignores invalid entries", () => {
    process.env.ACCOUNTS = "loupz=/data/.claude, bad name ,jungherz,loupz";
    _resetAccountsForTests();
    assert.deepEqual(getAccounts().map((a) => a.name), ["loupz", "jungherz"]);
    assert.equal(acc("loupz").configDir, "/data/.claude");
  });
});

describe("placement", () => {
  beforeEach(() => setup());

  it("puts a new chat on the least used account", () => {
    setUtilization(acc("loupz"), 0.6);
    setUtilization(acc("jungherz"), 0.3);
    const p = pickAccount("chat-a")!;
    assert.equal(p.account.name, "jungherz");
    assert.equal(p.reason, "new chat");
  });

  it("keeps a warm chat on its account even if the other is emptier", () => {
    setUtilization(acc("loupz"), 0.6);
    setUtilization(acc("jungherz"), 0.1);
    bindChat("chat-a", acc("loupz"));
    const p = pickAccount("chat-a")!;
    assert.equal(p.account.name, "loupz");
    assert.equal(p.changed, false);
  });

  it("moves a warm chat once its account reaches the threshold (85 %)", () => {
    setUtilization(acc("loupz"), 0.86);
    setUtilization(acc("jungherz"), 0.5);
    bindChat("chat-a", acc("loupz"));
    const p = pickAccount("chat-a")!;
    assert.equal(p.account.name, "jungherz");
    assert.equal(p.changed, true);
    assert.match(p.reason, /86 % >= 85 %/);
  });

  it("respects ACCOUNT_SWITCH_AT", () => {
    process.env.ACCOUNT_SWITCH_AT = "95";
    setUtilization(acc("loupz"), 0.9);
    setUtilization(acc("jungherz"), 0.1);
    bindChat("chat-a", acc("loupz"));
    assert.equal(pickAccount("chat-a")!.account.name, "loupz");
  });

  it("stays put when all accounts are above the threshold", () => {
    setUtilization(acc("loupz"), 0.9);
    setUtilization(acc("jungherz"), 0.88);
    bindChat("chat-a", acc("loupz"));
    assert.equal(pickAccount("chat-a")!.account.name, "loupz");
  });

  it("rebalances a chat whose cache has gone cold", () => {
    process.env.ACCOUNT_STICKY_MINUTES = "1";
    setUtilization(acc("loupz"), 0.7);
    setUtilization(acc("jungherz"), 0.2);
    bindChat("chat-a", acc("loupz"));
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60_000;
    try {
      const p = pickAccount("chat-a")!;
      assert.equal(p.account.name, "jungherz");
      assert.match(p.reason, /idle/);
    } finally {
      Date.now = realNow;
    }
  });

  it("breaks ties by number of active chats", () => {
    setUtilization(acc("loupz"), 0.4);
    setUtilization(acc("jungherz"), 0.41);
    bindChat("x1", acc("loupz"));
    bindChat("x2", acc("loupz"));
    assert.equal(pickAccount("new")!.account.name, "jungherz");
  });

  it("skips accounts without login", () => {
    _resetAccountsForTests();
    fs.rmSync(path.join(tmp, "jungherz", ".credentials.json"));
    setUtilization(acc("loupz"), 0.8);
    assert.equal(pickAccount("chat-a")!.account.name, "loupz");
  });

  it("excludes accounts already tried for this request", () => {
    assert.equal(pickAccount("c", new Set(["loupz"]))!.account.name, "jungherz");
    assert.equal(pickAccount("c", new Set(["loupz", "jungherz"])), null);
  });
});

describe("limits and login failures", () => {
  beforeEach(() => setup());

  it("reads utilization from rate_limit_event and stays allowed below the limit", () => {
    const blocked = observeRateLimit(acc("loupz"), {
      status: "allowed",
      resetsAt: 1794387600,
      isUsingOverage: false,
      unifiedWindows: { seven_day: { utilization: 0.71, resetsAt: 1794387600, status: "allowed" } },
    });
    assert.equal(blocked, false);
    assert.equal(acc("loupz").utilization, 0.71);
    assert.equal(acc("loupz").resetsAt, 1794387600 * 1000);
  });

  it("treats a rejected status or paid overage as limited", () => {
    assert.equal(observeRateLimit(acc("loupz"), { status: "rejected", resetsAt: Date.now() / 1000 + 3600 }), true);
    assert.equal(acc("loupz").status, "limited");
    assert.equal(observeRateLimit(acc("jungherz"), { status: "allowed", isUsingOverage: true }), true);
    assert.equal(acc("jungherz").status, "limited");
  });

  it("moves chats away from a limited account and returns after the reset", () => {
    bindChat("chat-a", acc("loupz"));
    markLimited(acc("loupz"), Date.now() + 1000, "test");
    assert.equal(pickAccount("chat-a")!.account.name, "jungherz");
    const realNow = Date.now;
    Date.now = () => realNow() + 5000;
    try {
      assert.equal(acc("loupz").status, "limited");
      pickAccount("other"); // evaluation clears the expired limit
      assert.equal(acc("loupz").status, "ok");
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back to the account that resets first when all are limited", () => {
    markLimited(acc("loupz"), Date.now() + 7200_000, "test");
    markLimited(acc("jungherz"), Date.now() + 3600_000, "test");
    const p = pickAccount("chat-a")!;
    assert.equal(p.account.name, "jungherz");
    assert.equal(p.fallback, true);
  });

  it("never uses an account with a broken login", () => {
    markAuthFailed(acc("loupz"), "expired");
    markLimited(acc("jungherz"), Date.now() + 3600_000, "test");
    const p = pickAccount("chat-a")!;
    assert.equal(p.account.name, "jungherz");
    assert.equal(p.fallback, true);
    markAuthFailed(acc("jungherz"), "expired");
    assert.equal(pickAccount("chat-a"), null);
  });

  it("recognizes CLI limit messages", () => {
    assert.equal(isLimitText("You've hit your weekly limit · resets Nov 11"), true);
    assert.equal(isLimitText("Usage limit reached for Opus"), true);
    assert.equal(isLimitText("You're out of extra usage"), true);
    assert.equal(isLimitText("Here is the weekly limit chart you asked for"), false);
  });
});

describe("chat fingerprint", () => {
  it("is stable across turns of an OpenWebUI chat with RAG wrapping", () => {
    const turn1 = [
      { role: "system" as const, content: "sys" },
      {
        role: "user" as const,
        content:
          "<attached_files>\n<file id=\"x\"/>\n</attached_files>\n\n### Task:\nRespond...\n<context>\n<source id=\"1\">Buch</source>\n</context>\nWie geht es weiter?",
      },
    ];
    const turn2 = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "<attached_files>\n<file id=\"x\"/>\n</attached_files>\n\nWie geht es weiter?" },
      { role: "assistant" as const, content: "So." },
      { role: "user" as const, content: "### Task: ... <context>...</context>\nUnd dann?" },
    ];
    assert.ok(chatFingerprint(turn1));
    assert.equal(chatFingerprint(turn1), chatFingerprint(turn2));
  });

  it("differs between chats and prefers a client user id", () => {
    const a = chatFingerprint([{ role: "user", content: "Hallo A" }]);
    const b = chatFingerprint([{ role: "user", content: "Hallo B" }]);
    assert.notEqual(a, b);
    assert.match(chatFingerprint([{ role: "user", content: "x" }], "conv-42")!, /^u:/);
    assert.equal(chatFingerprint([{ role: "system", content: "nur system" }]), undefined);
  });
});

describe("persistence", () => {
  beforeEach(() => setup());

  it("stores chat assignments (hashes only) and restores them", () => {
    bindChat("abc123", acc("jungherz"));
    saveBindings();
    const raw = fs.readFileSync(path.join(tmp, "affinity.json"), "utf8");
    assert.match(raw, /"abc123"/);
    _resetAccountsForTests();
    getAccounts();
    assert.equal(boundAccount("abc123"), "jungherz");
  });
});

describe("usage parsing", () => {
  it("takes the all-models week (and session, if any), not model-specific weeks", () => {
    const d = parseUsage(
      "You are currently using your subscription\n\nCurrent week (all models): 72% used · resets Nov 11, 9am (UTC)\nCurrent week (Fable): 90% used · resets Nov 11, 9am (UTC)\n"
    );
    assert.equal(bindingPercent(d), 72);
    const s = parseUsage("Current session: 95% used · resets 5pm (UTC)\nCurrent week (all models): 40% used");
    assert.equal(bindingPercent(s), 95);
    assert.equal(bindingPercent(parseUsage("nothing")), null);
  });
});
