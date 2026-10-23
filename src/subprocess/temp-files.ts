/**
 * Private temp files handed to the Claude CLI (system prompt files, MCP
 * bridge configs). They carry client data (system prompts) or secrets
 * (per-run bridge tokens) and must never outlive the proxy:
 *
 *  - released (async) when the owning run/subprocess ends,
 *  - removed synchronously on process exit (SIGTERM on redeploy) while a
 *    CLI process may still be running,
 *  - swept on startup if an earlier proxy died hard (SIGKILL, OOM).
 *
 * Names carry the owning proxy's PID: <prefix><pid>-<unique>. The startup
 * sweep only removes entries of dead proxies (or stale entries of our own
 * PID - containers always run the proxy as PID 1), never those of a live
 * second instance sharing /tmp.
 */

import fs from "fs/promises";
import { readdirSync, rmSync } from "fs";
import os from "os";
import path from "path";

export const SYSTEM_PROMPT_PREFIX = "cmap-sp-";
export const MCP_CONFIG_PREFIX = "cmap-mcp-";
const PREFIXES = [SYSTEM_PROMPT_PREFIX, MCP_CONFIG_PREFIX];

/** Temp paths (files or dirs) currently in use by this process */
const live = new Set<string>();

/** Path for a new temp entry: <tmpdir>/<prefix><pid>-<suffix> */
export function tempPath(prefix: string, suffix: string): string {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${suffix}`);
}

/** Track a temp path so exit cleanup can remove it */
export function trackTemp(p: string): void {
  live.add(p);
}

/** Remove a temp path (async, best effort) and stop tracking it */
export function releaseTemp(p: string): void {
  live.delete(p);
  fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

/** True while the path is tracked (tests) */
export function isTrackedTemp(p: string): boolean {
  return live.has(p);
}

/** Synchronously remove every tracked temp path (process exit) */
export function cleanupLiveTempFiles(): void {
  for (const p of live) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  live.clear();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to another user - leave its files alone
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exact names written by versions before PID-tagging - matched precisely so
 * the sweep never touches anything else that merely shares the prefix:
 *   cmap-mcp-<24 hex>.json   (MCP bridge config, runId = 12 random bytes)
 *   cmap-sp-<6 chars>        (system prompt dir, fs.mkdtemp suffix)
 */
const LEGACY_NAMES = [/^cmap-mcp-[0-9a-f]{24}\.json$/, /^cmap-sp-[A-Za-z0-9]{6}$/];

/** <prefix><pid>-<rest> -> pid, or null if the name is not in that format */
function ownerPid(name: string): number | null {
  for (const prefix of PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const m = name.slice(prefix.length).match(/^(\d+)-./);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Remove temp entries left behind by earlier proxy processes: PID-tagged
 * entries of dead proxies (or stale entries of our own PID), plus the exact
 * legacy formats of earlier versions. Anything else is left alone.
 */
export function sweepStaleTempFiles(): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(os.tmpdir());
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = path.join(os.tmpdir(), name);
    if (live.has(full)) continue;
    const pid = ownerPid(name);
    let stale: boolean;
    if (pid !== null) {
      stale = pid === process.pid || !isProcessAlive(pid);
    } else {
      stale = LEGACY_NAMES.some((re) => re.test(name));
    }
    if (!stale) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

process.on("exit", cleanupLiveTempFiles);
