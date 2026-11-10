/**
 * Admin endpoints: in-container re-authentication of the Claude CLI.
 *
 * Flow (no container/SSH access needed):
 *   1. POST /admin/relogin/start   → spawns `claude auth login`
 *      inside the container, parses the OAuth URL from its output and
 *      returns it. The admin opens the URL in any browser and authorizes.
 *   2. POST /admin/relogin/complete { code } → pastes the authorization
 *      code back into the waiting CLI process via stdin.
 *   3. GET  /admin/relogin/status  → poll the current state.
 *
 * The CLI writes fresh credentials to $CLAUDE_CONFIG_DIR (~/.claude),
 * which lives on the persistent /data volume - so the new tokens survive
 * container restarts and redeploys.
 *
 * All routes are protected by adminAuth (PROXY_ADMIN_KEY, falling back to
 * PROXY_API_KEY).
 */

import { Router, type Request } from "express";
import { spawn, ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { buildCliEnv } from "../subprocess/manager.js";
import {
  accountsEnabled,
  getAccounts,
  getAccount,
  defaultAccount,
  hasCredentials,
  activeChatCount,
  switchThreshold,
  markHealthy,
  type AccountState,
} from "../accounts/pool.js";
import { queryUsage, refreshAccount, parseUsage as parseUsageText } from "../accounts/usage.js";

type ReloginState = "idle" | "awaiting_code" | "success" | "failed";

interface ReloginSession {
  state: ReloginState;
  /** Account being logged in (multi-account mode) */
  account: string | null;
  url: string | null;
  detail: string | null;
  startedAt: number;
  proc: ChildProcess | null;
  buffer: string;
}

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min to complete the flow

let session: ReloginSession | null = null;

function resetSession(): void {
  if (session?.proc) {
    session.proc.kill("SIGTERM");
  }
  session = null;
}

function isExpired(s: ReloginSession): boolean {
  return Date.now() - s.startedAt > SESSION_TIMEOUT_MS;
}

/**
 * Account addressed by ?account=<name> or {"account": "<name>"}. Without
 * ACCOUNTS: null (classic single login). With ACCOUNTS: defaults to the first
 * account; an unknown name is an error (returned as string).
 */
function resolveAccount(req: Request): AccountState | null | string {
  if (!accountsEnabled()) return null;
  const name = String((req.query.account as string) || req.body?.account || "").trim();
  if (!name) return defaultAccount() ?? null;
  return getAccount(name) ?? `Unknown account "${name}" (configured: ${getAccounts().map((a) => a.name).join(", ")})`;
}

function unknownAccount(res: import("express").Response, message: string): void {
  res.status(404).json({ error: { message, type: "invalid_request_error", code: "unknown_account" } });
}

/**
 * Try to extract the OAuth authorize URL from CLI output.
 * The CLI prints something like "Open this URL: https://claude.ai/oauth/authorize?..."
 */
function extractUrl(text: string): string | null {
  const m = text.match(/https:\/\/[^\s"']*(?:oauth|authorize|login)[^\s"']*/i);
  return m ? m[0] : null;
}

export function createAdminRouter(): Router {
  const router = Router();

  /**
   * POST /admin/relogin/start
   * Starts `claude auth login` in the container and returns
   * the URL the admin must open in a browser.
   */
  router.post("/relogin/start", (req, res) => {
    const account = resolveAccount(req);
    if (typeof account === "string") {
      unknownAccount(res, account);
      return;
    }
    if (
      session &&
      !isExpired(session) &&
      session.state === "awaiting_code" &&
      session.account !== (account?.name ?? null)
    ) {
      res.status(409).json({
        error: {
          message: `A login for account "${session.account}" is in progress - complete or cancel it first.`,
          type: "invalid_request_error",
          code: "flow_in_progress",
        },
      });
      return;
    }
    if (session && !isExpired(session) && session.state === "awaiting_code") {
      // A flow is already waiting - return its URL again (idempotent for retries)
      res.json({ state: session.state, url: session.url, note: "Flow already in progress" });
      return;
    }
    resetSession();

    let proc: ChildProcess;
    try {
      if (account) mkdirSync(account.configDir, { recursive: true, mode: 0o700 });
      proc = spawn(process.env.CLAUDE_BIN || "claude", ["auth", "login"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildCliEnv(account?.configDir),
      });
    } catch (err) {
      res.status(500).json({
        error: { message: `Failed to spawn claude CLI: ${String(err)}`, type: "server_error", code: null },
      });
      return;
    }

    session = {
      state: "awaiting_code",
      account: account?.name ?? null,
      url: null,
      detail: null,
      startedAt: Date.now(),
      proc,
      buffer: "",
    };

    const onData = (chunk: Buffer) => {
      if (!session) return;
      session.buffer += chunk.toString();
      if (!session.url) {
        session.url = extractUrl(session.buffer);
        if (session.url) {
          console.log(`[Admin] Relogin URL ready${session.account ? ` (account ${session.account})` : ""}`);
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("close", (code) => {
      if (!session) return;
      if (session.state === "success") return; // already completed via /complete
      session.state = code === 0 ? "success" : "failed";
      session.detail = `claude auth login exited with code ${code}`;
      session.proc = null;
      console.log(`[Admin] Relogin process closed: ${session.state}`);
    });

    // Give the CLI a moment to print the URL before responding
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      if (!session) {
        clearInterval(poll);
        return;
      }
      if (session.url || Date.now() > deadline) {
        clearInterval(poll);
        if (session.url) {
          res.json({
            state: session.state,
            ...(session.account ? { account: session.account } : {}),
            url: session.url,
            instructions:
              "Open the URL in a browser, authorize, then POST the returned code to /admin/relogin/complete",
          });
        } else {
          res.status(202).json({
            state: session.state,
            url: null,
            note: "CLI started but has not printed a URL yet - poll GET /admin/relogin/status",
          });
        }
      }
    }, 250);
  });

  /**
   * POST /admin/relogin/complete { code: "..." }
   * Feeds the authorization code into the waiting CLI process.
   */
  router.post("/relogin/complete", (req, res) => {
    if (!session || session.state !== "awaiting_code" || !session.proc) {
      res.status(409).json({
        error: {
          message: "No login flow in progress. Call POST /admin/relogin/start first.",
          type: "invalid_request_error",
          code: "no_flow",
        },
      });
      return;
    }
    if (isExpired(session)) {
      resetSession();
      res.status(410).json({
        error: {
          message: "Login flow timed out (10 min). Start again with POST /admin/relogin/start.",
          type: "invalid_request_error",
          code: "flow_expired",
        },
      });
      return;
    }

    const code = (req.body?.code || "").toString().trim();
    if (!code) {
      res.status(400).json({
        error: { message: "Missing 'code' in request body.", type: "invalid_request_error", code: "missing_code" },
      });
      return;
    }

    const proc = session.proc;
    const current = session;

    const timeout = setTimeout(() => {
      if (session === current && current.state === "awaiting_code") {
        res.status(202).json({ state: current.state, note: "Code submitted, waiting for CLI to finish - poll /admin/relogin/status" });
      }
    }, 15000);

    const onClose = (exitCode: number | null) => {
      clearTimeout(timeout);
      current.state = exitCode === 0 ? "success" : "failed";
      current.detail = exitCode === 0
        ? "Login successful - credentials written to the persistent volume."
        : `Login failed (exit code ${exitCode}). Output: ${current.buffer.slice(-500)}`;
      current.proc = null;
      console.log(`[Admin] Relogin completed: ${current.state}${current.account ? ` (account ${current.account})` : ""}`);
      const acc = getAccount(current.account ?? undefined);
      if (acc && exitCode === 0) {
        markHealthy(acc);
        void refreshAccount(acc);
      }
      if (!res.headersSent) {
        res.status(exitCode === 0 ? 200 : 502).json({
          state: current.state,
          ...(current.account ? { account: current.account } : {}),
          detail: current.detail,
        });
      }
      // Clean up the session after responding - on success the CLI output may
      // contain account details we don't want to keep in memory
      if (session === current) {
        session = null;
      }
    };

    proc.once("close", onClose);
    proc.stdin?.write(code + "\n");
    proc.stdin?.end();
  });

  /**
   * GET /admin/relogin/status
   */
  router.get("/relogin/status", (_req, res) => {
    if (!session) {
      res.json({ state: "idle" });
      return;
    }
    res.json({
      state: session.state,
      ...(session.account ? { account: session.account } : {}),
      url: session.url,
      detail: session.detail,
      expiresIn: Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - session.startedAt)),
    });
  });

  /**
   * POST /admin/relogin/cancel
   */
  router.post("/relogin/cancel", (_req, res) => {
    resetSession();
    res.json({ state: "idle" });
  });

  /**
   * GET /admin/usage[?account=<name>]
   * Subscription usage as reported by the CLI itself ("claude --print /usage").
   * Answers directly from the CLI, costs no API tokens. Cached for 60s.
   */
  router.get("/usage", (req, res) => {
    const account = resolveAccount(req);
    if (typeof account === "string") {
      unknownAccount(res, account);
      return;
    }
    const key = account?.name ?? "";
    const now = Date.now();
    const cached = usageCache.get(key);
    if (cached && now - cached.at < 60_000) {
      res.json({ ...cached.data, cached: true });
      return;
    }
    const target: AccountState =
      account ?? ({ name: "", configDir: process.env.CLAUDE_CONFIG_DIR || "" } as AccountState);
    queryUsage(target)
      .then((data) => {
        const out = account ? { account: account.name, ...data } : data;
        usageCache.set(key, { at: Date.now(), data: out });
        res.json({ ...out, cached: false });
      })
      .catch((err: Error) => {
        res.status(502).json({
          error: { message: `Usage query failed: ${err.message}`, type: "server_error", code: null },
        });
      });
  });

  /**
   * GET /admin/accounts
   * All configured accounts with status, utilization and active chats.
   * POST /admin/accounts/refresh re-polls the utilization of all accounts.
   */
  router.get("/accounts", (_req, res) => {
    if (!accountsEnabled()) {
      res.json({ enabled: false, note: "Single-account mode - set ACCOUNTS to enable distribution" });
      return;
    }
    res.json({
      enabled: true,
      switch_at_percent: Math.round(switchThreshold() * 100),
      accounts: getAccounts().map((a) => ({
        name: a.name,
        config_dir: a.configDir,
        logged_in: hasCredentials(a),
        status: a.status,
        percent_used: a.utilization === null ? null : Math.round(a.utilization * 100),
        resets_at: a.resetsAt ? new Date(a.resetsAt).toISOString() : null,
        limited_until: a.limitedUntil ? new Date(a.limitedUntil).toISOString() : null,
        active_chats: activeChatCount(a.name),
        updated_at: a.updatedAt ? new Date(a.updatedAt).toISOString() : null,
        ...(a.detail ? { detail: a.detail } : {}),
      })),
    });
  });

  router.post("/accounts/refresh", async (_req, res) => {
    await Promise.all(getAccounts().map((a) => refreshAccount(a)));
    usageCache.clear();
    res.redirect(303, "/admin/accounts");
  });

  return router;
}

const usageCache = new Map<string, { at: number; data: Record<string, unknown> }>();

/** Kept for compatibility - the parser lives in accounts/usage.ts */
export const parseUsage = parseUsageText;
