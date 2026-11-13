/**
 * Subscription utilization per account via "claude --print /usage" (answered
 * by the CLI itself, costs no model tokens). Complements the rate_limit_event
 * the CLI emits with every request: polling keeps idle accounts up to date,
 * so new chats are placed on fresh numbers.
 */

import { execFile } from "child_process";
import {
  getAccounts,
  hasCredentials,
  setUtilization,
  markAuthFailed,
  markBlocked,
  markHealthy,
  setRecoveryHandler,
  authRecheckMs,
  type AccountState,
} from "./pool.js";
import { buildCliEnv, isUpstreamBlock } from "../subprocess/manager.js";

export interface UsageWindow {
  percent_used: number;
  resets?: string;
}

/**
 * Parse the plain-text output of "claude --print /usage". Lines (CLI 2.1.x):
 *   Current session: 3% used · resets Aug 16, 5:50pm (UTC)
 *   Current week (all models): 7% used · resets Aug 19, 9am (UTC)
 *   Current week (Fable): 0% used · resets Nov 11, 9am (UTC)
 */
export function parseUsage(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = { raw: text.trim() };
  const lineRe =
    /^(Current session|Current week(?: \(([^)]+)\))?)\s*:\s*(\d+)% used(?:\s*·\s*resets (.+))?$/i;

  for (const line of text.split("\n")) {
    const m = line.trim().match(lineRe);
    if (!m) continue;
    const scope = m[2] ? m[2].toLowerCase().replace(/\s+/g, "_") : null;
    const key = m[1].toLowerCase().startsWith("current session")
      ? "session"
      : scope
        ? `week_${scope}`
        : "week_all_models";
    const w: UsageWindow = { percent_used: Number(m[3]) };
    if (m[4]) w.resets = m[4].trim();
    result[key] = w;
  }
  return result;
}

/**
 * The binding limit: highest percentage of the session window (if the plan
 * has one) and the all-models week. Model-specific weeks (e.g. Fable) only
 * restrict that one model and are ignored.
 */
export function bindingPercent(data: Record<string, unknown>): number | null {
  let max: number | null = null;
  for (const key of ["session", "week_all_models"]) {
    const w = data[key] as UsageWindow | undefined;
    if (w && typeof w.percent_used === "number" && (max === null || w.percent_used > max)) {
      max = w.percent_used;
    }
  }
  return max;
}

const AUTH_TEXT_RE = /not logged in|please run \/login|auth(?:entication)? (?:failed|error)|could not be refreshed|expired/i;

/** Query one account. Resolves with the parsed data or rejects with the CLI's message. */
export function queryUsage(a: AccountState, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.CLAUDE_BIN || "claude",
      ["--print", "/usage"],
      { timeout: timeoutMs, maxBuffer: 64 * 1024, env: buildCliEnv(a.configDir) },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (err) {
          reject(new Error(out || err.message));
          return;
        }
        resolve(parseUsage(stdout.toString()));
      }
    );
  });
}

/** Poll one account and update its state. Never throws. */
export async function refreshAccount(a: AccountState): Promise<void> {
  if (!hasCredentials(a)) return;
  try {
    const data = await queryUsage(a);
    const p = bindingPercent(data);
    if (p !== null) {
      setUtilization(a, p / 100);
      // The usage numbers came from Anthropic: login works, no outage block
      if (a.status === "auth_failed" || a.status === "blocked") markHealthy(a);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isUpstreamBlock(msg)) markBlocked(a, msg);
    else if (AUTH_TEXT_RE.test(msg)) markAuthFailed(a, msg);
    // other failures (timeout, network): keep the last known numbers
  }
}

export async function refreshAll(): Promise<void> {
  await Promise.all(getAccounts().map((a) => refreshAccount(a)));
}

let pollTimer: NodeJS.Timeout | null = null;
let recheckTimer: NodeJS.Timeout | null = null;

/**
 * Accounts marked "login invalid" are checked again every minute: a short
 * outage at Anthropic may look like a login failure, and the account should
 * come back on its own once it works again (a real expired login stays
 * auth_failed until the relogin). Costs no tokens (/usage).
 */
export async function recheckFailedLogins(): Promise<void> {
  const now = Date.now();
  const due = getAccounts().filter(
    (a) =>
      hasCredentials(a) &&
      (a.status === "auth_failed" || (a.status === "blocked" && (a.limitedUntil ?? 0) <= now))
  );
  await Promise.all(due.map((a) => refreshAccount(a)));
}

/** Start periodic polling (ACCOUNT_POLL_MINUTES, default 10, 0 = off) */
export function startUsagePolling(): void {
  if (pollTimer || recheckTimer || getAccounts().length === 0) return;
  setRecoveryHandler((a) => void refreshAccount(a));
  const minutes = parseFloat(process.env.ACCOUNT_POLL_MINUTES ?? "10");
  void refreshAll();
  const recheck = authRecheckMs();
  if (recheck > 0) {
    recheckTimer = setInterval(() => void recheckFailedLogins(), Math.max(10_000, recheck));
    recheckTimer.unref();
  }
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  pollTimer = setInterval(() => void refreshAll(), Math.max(1, minutes) * 60_000);
  pollTimer.unref();
}

export function stopUsagePolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (recheckTimer) clearInterval(recheckTimer);
  pollTimer = null;
  recheckTimer = null;
}
