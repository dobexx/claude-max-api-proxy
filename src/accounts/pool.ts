/**
 * Multiple Claude subscriptions behind one proxy.
 *
 * Every account has its own CLI config directory (own OAuth login, refreshed
 * by the CLI itself). Per request the proxy picks the directory and passes it
 * to the CLI as CLAUDE_CONFIG_DIR - no copying of credentials, no restarts.
 *
 * Distribution keeps Anthropic's prompt cache warm: the cache belongs to one
 * account and lives ~1 h, so a chat stays on its account while it is active.
 * New chats - and chats idle for longer than the cache lifetime - go to the
 * account with the lowest utilization. A chat only moves while its cache is
 * warm when its account reaches ACCOUNT_SWITCH_AT (and another one is below).
 *
 * Config (env):
 *   ACCOUNTS               "loupz=/data/.claude,jungherz"  (name or name=dir;
 *                          dir defaults to $ACCOUNTS_DIR/<name>). Unset = the
 *                          classic single-account mode via CLAUDE_CONFIG_DIR.
 *   ACCOUNTS_DIR           default /data/accounts (also holds affinity.json)
 *   ACCOUNT_SWITCH_AT      percent, default 85
 *   ACCOUNT_STICKY_MINUTES default 60 (prompt cache lifetime)
 *   ACCOUNT_POLL_MINUTES   default 10, 0 = off (see usage.ts)
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import path from "path";
import type { OpenAIChatMessage } from "../types/openai.js";

export type AccountStatus = "ok" | "limited" | "auth_failed";

export interface AccountState {
  name: string;
  configDir: string;
  /** Highest utilization over all reported windows, 0..1 (null = unknown) */
  utilization: number | null;
  /** Unix ms of the next reset of that window */
  resetsAt: number | null;
  status: AccountStatus;
  /** Unix ms until which a limited account is skipped */
  limitedUntil: number | null;
  detail: string | null;
  /** Unix ms of the last utilization update */
  updatedAt: number | null;
}

interface Binding {
  account: string;
  lastUsed: number;
}

export interface AccountPick {
  account: AccountState;
  reason: string;
  /** true when this request starts or moves a chat (worth logging) */
  changed: boolean;
  /** Every account is limited: best effort on the one that resets first */
  fallback?: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const BINDING_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT_MS = 60 * 60 * 1000;
/** Utilizations closer than this count as equal (then: fewer active chats wins) */
const UTIL_TOLERANCE = 0.02;

let accounts: AccountState[] | null = null;
const bindings = new Map<string, Binding>();
let saveTimer: NodeJS.Timeout | null = null;
let onRecovered: ((a: AccountState) => void) | null = null;

// ─── Config ─────────────────────────────────────────────────────────

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function accountsDir(): string {
  return process.env.ACCOUNTS_DIR || "/data/accounts";
}

/** Switch threshold as a fraction (ACCOUNT_SWITCH_AT is in percent) */
export function switchThreshold(): number {
  return envNumber("ACCOUNT_SWITCH_AT", 85, 1, 100) / 100;
}

export function stickyMs(): number {
  return envNumber("ACCOUNT_STICKY_MINUTES", 60, 1, 24 * 60) * 60_000;
}

function parseAccounts(): AccountState[] {
  const raw = (process.env.ACCOUNTS || "").trim();
  const list: AccountState[] = [];
  if (!raw) return list;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const name = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    const dir = eq >= 0 ? entry.slice(eq + 1).trim() : path.join(accountsDir(), name);
    if (!NAME_RE.test(name) || !dir || list.some((a) => a.name === name)) {
      console.error(`[Accounts] Ignoring invalid or duplicate entry "${entry}"`);
      continue;
    }
    list.push({
      name,
      configDir: dir,
      utilization: null,
      resetsAt: null,
      status: "ok",
      limitedUntil: null,
      detail: null,
      updatedAt: null,
    });
  }
  return list;
}

export function getAccounts(): AccountState[] {
  if (!accounts) {
    accounts = parseAccounts();
    if (accounts.length > 0) loadBindings();
  }
  return accounts;
}

/** Multi-account mode is on as soon as ACCOUNTS lists at least one account */
export function accountsEnabled(): boolean {
  return getAccounts().length > 0;
}

export function getAccount(name: string | undefined): AccountState | undefined {
  return name ? getAccounts().find((a) => a.name === name) : undefined;
}

export function defaultAccount(): AccountState | undefined {
  return getAccounts()[0];
}

export function hasCredentials(a: AccountState): boolean {
  return existsSync(path.join(a.configDir, ".credentials.json"));
}

export function hasAnyCredentials(): boolean {
  return getAccounts().some(hasCredentials);
}

/** Called when a limited account becomes usable again (usage.ts re-polls it) */
export function setRecoveryHandler(cb: (a: AccountState) => void): void {
  onRecovered = cb;
}

/** Test helper: forget all state and re-read the environment */
export function _resetAccountsForTests(): void {
  accounts = null;
  bindings.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

// ─── State updates ──────────────────────────────────────────────────

const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v * 100)} %`);

export function utilizationSummary(): string {
  return getAccounts()
    .map((a) => `${a.name} ${a.status === "ok" ? pct(a.utilization) : a.status}`)
    .join(", ");
}

export function markLimited(a: AccountState, untilMs: number | null, reason: string): void {
  const now = Date.now();
  const until =
    untilMs && untilMs > now
      ? untilMs
      : a.resetsAt && a.resetsAt > now
        ? a.resetsAt
        : now + DEFAULT_LIMIT_MS;
  const wasLimited = a.status === "limited";
  a.status = "limited";
  a.limitedUntil = until;
  a.detail = reason;
  if (!wasLimited) {
    console.error(`[Accounts] ${a.name} limited until ${new Date(until).toISOString()} (${reason})`);
  }
}

export function markAuthFailed(a: AccountState, detail: string): void {
  if (a.status !== "auth_failed") {
    console.error(`[Accounts] ${a.name}: login invalid - relogin via /admin/relogin/start?account=${a.name}`);
  }
  a.status = "auth_failed";
  a.detail = detail.slice(0, 300);
}

export function markHealthy(a: AccountState): void {
  if (a.status !== "ok") console.log(`[Accounts] ${a.name} is available again`);
  a.status = "ok";
  a.limitedUntil = null;
  a.detail = null;
}

/** Update utilization; ignores implausible values */
export function setUtilization(a: AccountState, utilization: number, resetsAtMs?: number | null): void {
  if (!Number.isFinite(utilization) || utilization < 0) return;
  a.utilization = Math.min(utilization, 1.5);
  if (resetsAtMs) a.resetsAt = resetsAtMs;
  a.updatedAt = Date.now();
}

/**
 * Feed a CLI rate_limit_event (sent before the model answers). Returns true
 * if the account cannot serve this request on its subscription: rejected, or
 * only via paid extra usage ("overage").
 */
export function observeRateLimit(a: AccountState, info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const i = info as {
    status?: string;
    resetsAt?: number;
    isUsingOverage?: boolean;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
  };
  let max: number | null = null;
  let resets: number | null = null;
  for (const w of Object.values(i.unifiedWindows || {})) {
    if (typeof w?.utilization === "number" && (max === null || w.utilization > max)) {
      max = w.utilization;
      resets = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : resets;
    }
  }
  if (max !== null) setUtilization(a, max, resets);

  const status = String(i.status || "");
  const rejected = status !== "" && !status.startsWith("allowed");
  if (rejected || i.isUsingOverage === true) {
    const until = typeof i.resetsAt === "number" ? i.resetsAt * 1000 : null;
    markLimited(a, until, rejected ? `rate limit "${status}"` : "only paid extra usage left");
    return true;
  }
  // A request got through: the login works
  if (a.status === "auth_failed") markHealthy(a);
  return false;
}

const LIMIT_TEXT_RE =
  /you(?:'|’)ve (?:hit|reached) your [^.\n]{0,40}limit|usage limit reached|out of (?:extra )?usage/i;

/** CLI error text for an exhausted subscription (only checked before any model output) */
export function isLimitText(text: string): boolean {
  return LIMIT_TEXT_RE.test(text);
}

// ─── Selection ──────────────────────────────────────────────────────

function isUsable(a: AccountState, now: number): boolean {
  if (a.status === "limited" && a.limitedUntil !== null && a.limitedUntil <= now) {
    markHealthy(a);
    a.utilization = null; // unknown after the reset - refreshed by the next event/poll
    onRecovered?.(a);
  }
  return a.status === "ok" && hasCredentials(a);
}

function activeChats(name: string, now: number): number {
  let n = 0;
  const ttl = stickyMs();
  for (const b of bindings.values()) if (b.account === name && now - b.lastUsed < ttl) n++;
  return n;
}

function leastLoaded(list: AccountState[], now: number): AccountState {
  const u = (a: AccountState) => a.utilization ?? 0;
  return list.reduce((best, a) => {
    const diff = u(a) - u(best);
    if (diff < -UTIL_TOLERANCE) return a;
    if (diff > UTIL_TOLERANCE) return best;
    return activeChats(a.name, now) < activeChats(best.name, now) ? a : best;
  });
}

/**
 * Choose the account for a request. `key` identifies the chat (see
 * chatFingerprint), `exclude` lists accounts already tried for this request.
 * Returns null if no usable account is left.
 */
export function pickAccount(key: string | undefined, exclude: ReadonlySet<string> = new Set()): AccountPick | null {
  const list = getAccounts();
  const now = Date.now();
  const candidates = list.filter((a) => !exclude.has(a.name) && isUsable(a, now));
  if (candidates.length === 0) {
    // Every account is limited: behave like single-account mode and let the
    // one that resets first answer (the CLI reports the limit itself) rather
    // than refusing outright. Accounts with a broken login are never used.
    const limited = list
      .filter((a) => !exclude.has(a.name) && a.status === "limited" && hasCredentials(a))
      .sort((x, y) => (x.limitedUntil ?? 0) - (y.limitedUntil ?? 0));
    if (limited.length === 0) return null;
    return { account: limited[0], reason: "all accounts limited", changed: true, fallback: true };
  }

  const threshold = switchThreshold();
  const below = candidates.filter((a) => (a.utilization ?? 0) < threshold);
  const pool = below.length > 0 ? below : candidates;
  const bound = key ? bindings.get(key) : undefined;
  const current = bound ? candidates.find((a) => a.name === bound.account) : undefined;

  if (bound && current) {
    const warm = now - bound.lastUsed < stickyMs();
    if (warm) {
      if ((current.utilization ?? 0) < threshold) return { account: current, reason: "sticky", changed: false };
      if (below.length === 0) {
        return { account: current, reason: "sticky, all accounts above threshold", changed: false };
      }
      const target = leastLoaded(below, now);
      return {
        account: target,
        reason: `${current.name} at ${pct(current.utilization)} >= ${pct(threshold)}`,
        changed: true,
      };
    }
    // Cache is cold anyway - a free chance to rebalance
    const target = leastLoaded(pool, now);
    return {
      account: target,
      reason: `idle > ${Math.round(stickyMs() / 60_000)} min, rebalanced`,
      changed: target.name !== current.name,
    };
  }

  const target = leastLoaded(pool, now);
  if (bound) {
    return { account: target, reason: `${bound.account} unavailable`, changed: true };
  }
  return { account: target, reason: "new chat", changed: true };
}

/** Remember that a chat runs on an account (called once the model starts answering) */
export function bindChat(key: string, a: AccountState): void {
  bindings.set(key, { account: a.name, lastUsed: Date.now() });
  scheduleSave();
}

export function boundAccount(key: string): string | undefined {
  return bindings.get(key)?.account;
}

export function activeChatCount(name: string): number {
  return activeChats(name, Date.now());
}

// ─── Chat fingerprint ───────────────────────────────────────────────

/**
 * Stable identifier for a conversation without any client cooperation: the
 * first user message stays the same for the whole chat. Normalized so the
 * first turn matches later ones: OpenWebUI wraps the LATEST user message in
 * its RAG template (context first, query after it or in <user_query>) and
 * prefixes attachment references (<attached_files>...</attached_files>) - in
 * turn 1 that latest message is the first one.
 * After a context compaction the first message changes - the chat is then
 * treated as new, which is fine: its prompt cache is cold anyway.
 * Clients that send a stable `user` field get that as key instead.
 */
export function chatFingerprint(
  messages: OpenAIChatMessage[] | undefined,
  user?: string
): string | undefined {
  if (user) return `u:${createHash("sha256").update(user).digest("hex").slice(0, 14)}`;
  const first = messages?.find((m) => m.role === "user");
  if (!first) return undefined;
  let text = "";
  const c = first.content as unknown;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .filter((b) => b && (b.type === "text" || b.type === "input_text"))
      .map((b) => String(b.text ?? ""))
      .join("\n");
  }
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (query) {
    text = query[1];
  } else {
    const end = text.lastIndexOf("</context>");
    if (end >= 0) text = text.slice(end + "</context>".length);
  }
  text = text.replace(/<attached_files>[\s\S]*?<\/attached_files>/gi, "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ─── Persistence (survives deploys; hashes only, no chat content) ───

function affinityFile(): string {
  return path.join(accountsDir(), "affinity.json");
}

function loadBindings(): void {
  try {
    const data = JSON.parse(readFileSync(affinityFile(), "utf8")) as Record<string, Binding>;
    const now = Date.now();
    for (const [key, b] of Object.entries(data)) {
      if (b && typeof b.account === "string" && typeof b.lastUsed === "number" && now - b.lastUsed < BINDING_TTL_MS) {
        bindings.set(key, b);
      }
    }
  } catch {
    // no file yet / unreadable - start fresh
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBindings();
  }, 5_000);
  saveTimer.unref();
}

export function saveBindings(): void {
  const now = Date.now();
  for (const [key, b] of bindings) if (now - b.lastUsed > BINDING_TTL_MS) bindings.delete(key);
  try {
    mkdirSync(accountsDir(), { recursive: true, mode: 0o700 });
    const tmp = `${affinityFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(bindings)), { mode: 0o600 });
    renameSync(tmp, affinityFile());
  } catch (err) {
    console.error(`[Accounts] Could not save chat assignments: ${err instanceof Error ? err.message : err}`);
  }
}
