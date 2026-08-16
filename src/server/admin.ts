/**
 * Admin endpoints: in-container re-authentication of the Claude CLI.
 *
 * Flow (no container/SSH access needed):
 *   1. POST /admin/relogin/start   → spawns `claude auth login --no-browser`
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

import { Router } from "express";
import { spawn, ChildProcess } from "child_process";

type ReloginState = "idle" | "awaiting_code" | "success" | "failed";

interface ReloginSession {
  state: ReloginState;
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
 * Try to extract the OAuth authorize URL from CLI output.
 * The CLI prints something like "Open this URL: https://claude.ai/oauth/authorize?..."
 */
function extractUrl(text: string): string | null {
  const m = text.match(/https:\/\/[^\s"']*(?:oauth|authorize|login)[^\s"']*/i);
  return m ? m[0] : null;
}

/**
 * Detect whether the CLI is waiting for the authorization code on stdin.
 */
function awaitsCode(text: string): boolean {
  return /code|paste|enter/i.test(text);
}

export function createAdminRouter(): Router {
  const router = Router();

  /**
   * POST /admin/relogin/start
   * Starts `claude auth login --no-browser` in the container and returns
   * the URL the admin must open in a browser.
   */
  router.post("/relogin/start", (_req, res) => {
    if (session && !isExpired(session) && session.state === "awaiting_code") {
      // A flow is already waiting - return its URL again (idempotent for retries)
      res.json({ state: session.state, url: session.url, note: "Flow already in progress" });
      return;
    }
    resetSession();

    let proc: ChildProcess;
    try {
      proc = spawn("claude", ["auth", "login", "--no-browser"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      res.status(500).json({
        error: { message: `Failed to spawn claude CLI: ${String(err)}`, type: "server_error", code: null },
      });
      return;
    }

    session = {
      state: "awaiting_code",
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
          console.log("[Admin] Relogin URL ready");
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
      console.log(`[Admin] Relogin completed: ${current.state}`);
      if (!res.headersSent) {
        res.status(exitCode === 0 ? 200 : 502).json({ state: current.state, detail: current.detail });
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

  return router;
}
