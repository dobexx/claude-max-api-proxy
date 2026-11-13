/**
 * RoutedSubprocess: a ClaudeSubprocess that runs on one of several accounts
 * and transparently fails over before the model has produced any output.
 *
 * Drop-in for ClaudeSubprocess (same events and methods). In multi-account
 * mode it picks the account (pool.pickAccount), passes its config dir to the
 * CLI and watches the first events of the run:
 *   - rate_limit_event rejected, or only paid extra usage left
 *   - an error result / exit that reports an exhausted limit
 *   - an authentication failure (expired / revoked login)
 * If that happens before the first model event (message_start), the run is
 * restarted on the next usable account with the same prompt and options -
 * the client sees nothing of it. Once the model answers, the run is
 * "committed": the chat is bound to the account and events pass through.
 *
 * Without ACCOUNTS configured it behaves exactly like ClaudeSubprocess.
 */

import { EventEmitter } from "events";
import { ClaudeSubprocess, isAuthError, isUpstreamBlock, type SubprocessOptions } from "../subprocess/manager.js";
import {
  accountsEnabled,
  pickAccount,
  bindChat,
  observeRateLimit,
  markLimited,
  markAuthFailed,
  markBlocked,
  isLimitText,
  utilizationSummary,
  type AccountState,
} from "./pool.js";

const FORWARDED_EVENTS = [
  "message",
  "text_block_start",
  "tool_use_start",
  "input_json_delta",
  "content_block_stop",
  "content_delta",
  "thinking_delta",
  "assistant",
  "result",
  "raw",
] as const;

export class NoAccountAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAccountAvailableError";
  }
}

export class RoutedSubprocess extends EventEmitter {
  private inner: ClaudeSubprocess | null = null;
  private account: AccountState | null = null;
  private readonly tried = new Set<string>();
  private committed = false;
  private killed = false;
  private prompt = "";
  private options: SubprocessOptions | null = null;
  private pickReason = "";
  private pickChanged = false;
  private failover = "";

  constructor(private readonly chatKey?: string) {
    super();
  }

  /** Account serving this run (multi-account mode only) */
  get accountName(): string | undefined {
    return this.account?.name;
  }

  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    if (!accountsEnabled()) {
      this.committed = true;
      return this.spawn(prompt, options);
    }
    this.prompt = prompt;
    this.options = options;
    const pick = pickAccount(this.chatKey, this.tried);
    if (!pick) {
      throw new NoAccountAvailableError(
        `No Claude account available (${utilizationSummary() || "none configured"})`
      );
    }
    this.account = pick.account;
    this.pickReason = pick.reason;
    this.pickChanged = pick.changed;
    return this.spawn(prompt, { ...options, configDir: pick.account.configDir });
  }

  private async spawn(prompt: string, options: SubprocessOptions): Promise<void> {
    const sub = new ClaudeSubprocess();
    this.inner = sub;
    if (this.account) this.tried.add(this.account.name);

    for (const ev of FORWARDED_EVENTS) {
      sub.on(ev, (payload: unknown) => {
        if (this.inner !== sub) return; // superseded by a failover
        if (ev === "message" && this.onMessage(payload)) return;
        if (ev === "result" && !this.committed && this.onEarlyResult(payload)) return;
        this.emit(ev, payload);
      });
    }
    sub.on("error", (err: Error) => {
      if (this.inner !== sub) return;
      if (!this.committed && this.retryAfterFailure(sub, err.message)) return;
      this.emit("error", err);
    });
    sub.on("close", (code: number | null) => {
      if (this.inner !== sub) return;
      if (!this.committed && code !== 0 && this.retryAfterFailure(sub, `exit ${code}`)) return;
      this.release();
      this.emit("close", code);
    });

    await sub.start(prompt, options);
  }

  /** Returns true if the message was consumed (failover started) */
  private onMessage(payload: unknown): boolean {
    const msg = payload as { type?: string; rate_limit_info?: unknown; event?: { type?: string } };
    const a = this.account;
    if (a && msg?.type === "rate_limit_event") {
      const blocked = observeRateLimit(a, msg.rate_limit_info);
      if (this.committed) {
        if (this.chatKey) bindChat(this.chatKey, a); // keep long tool loops "warm"
        return false;
      }
      if (blocked && this.failoverTo("limit reached")) return true;
      return false;
    }
    if (!this.committed && msg?.type === "stream_event" && msg.event?.type === "message_start") {
      this.commit();
    } else if (this.committed && a && this.chatKey && msg?.type === "stream_event" && msg.event?.type === "message_start") {
      // Every model call of a long tool loop refreshes the chat's cache window
      bindChat(this.chatKey, a);
    }
    return false;
  }

  /** Error result before any model output: limit or login problem? */
  private onEarlyResult(payload: unknown): boolean {
    const r = payload as { is_error?: boolean; result?: string; subtype?: string };
    const text = String(r?.result || "");
    if (!r?.is_error && !isLimitText(text)) {
      this.commit();
      return false;
    }
    const a = this.account;
    // Outage page (Cloudflare 403): the CLI calls it "Failed to authenticate",
    // but the login is fine - skip the account briefly instead
    if (a && r.is_error && isUpstreamBlock(text)) {
      markBlocked(a, text);
      return this.failoverTo("rejected by Anthropic/Cloudflare");
    }
    if (a && isAuthError(text, null)) {
      markAuthFailed(a, text);
      return this.failoverTo("login invalid");
    }
    if (a && isLimitText(text)) {
      markLimited(a, null, text.slice(0, 120));
      return this.failoverTo("limit reached");
    }
    return false;
  }

  private retryAfterFailure(sub: ClaudeSubprocess, detail: string): boolean {
    const a = this.account;
    if (!a) return false;
    if (sub.hasUpstreamBlock()) {
      markBlocked(a, detail);
      return this.failoverTo("rejected by Anthropic/Cloudflare");
    }
    if (!sub.hasAuthError()) return false;
    markAuthFailed(a, detail);
    return this.failoverTo("login invalid");
  }

  /** Restart the run on the next usable account. False if none is left. */
  private failoverTo(why: string): boolean {
    if (this.killed || !this.options) return false;
    // A --resume'd CLI session only exists in this account's config dir
    if (this.options.resume) return false;
    const pick = pickAccount(this.chatKey, this.tried);
    if (!pick || pick.fallback) return false;
    const from = this.account?.name;
    const old = this.inner;
    this.inner = null; // detach before killing: its events are ignored from now on
    old?.kill();
    this.account = pick.account;
    this.failover = `${from} ${why}`;
    console.error(`[Accounts] ${from}: ${why} - retrying on ${pick.account.name}`);
    this.spawn(this.prompt, { ...this.options, configDir: pick.account.configDir }).catch((err) =>
      this.emit("error", err instanceof Error ? err : new Error(String(err)))
    );
    return true;
  }

  private commit(): void {
    if (this.committed) return;
    this.committed = true;
    const a = this.account;
    if (a && this.chatKey) bindChat(this.chatKey, a);
    // Requests without a chat key (OpenWebUI background tasks) are only
    // logged when they had to fail over - a placement is no news for them
    if (a && ((this.chatKey && this.pickChanged) || this.failover)) {
      const chat = this.chatKey ? `chat ${this.chatKey.slice(0, 8)}` : "request";
      const reason = this.failover ? `failover: ${this.failover}` : this.pickReason;
      console.log(`[Accounts] ${chat} -> ${a.name} (${reason}) | ${utilizationSummary()}`);
    }
    this.release();
  }

  /** Drop the retained prompt/images once no failover can happen anymore */
  private release(): void {
    this.prompt = "";
    this.options = null;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed = true;
    this.inner?.kill(signal);
  }

  hasAuthError(): boolean {
    return this.inner?.hasAuthError() ?? false;
  }

  hasUpstreamBlock(): boolean {
    return this.inner?.hasUpstreamBlock() ?? false;
  }

  isRunning(): boolean {
    return this.inner?.isRunning() ?? false;
  }
}
