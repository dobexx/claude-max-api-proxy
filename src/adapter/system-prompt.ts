/**
 * How OpenAI `system` messages reach the Claude CLI.
 *
 * SYSTEM_PROMPT_MODE:
 *   append  (default) - client system prompt is appended to Claude Code's
 *                       default system prompt (--append-system-prompt-file).
 *                       Real system-level weight, Claude Code behavior kept.
 *   replace           - client system prompt replaces Claude Code's default
 *                       system prompt entirely (--system-prompt-file).
 *                       Built-in tools stay available, their usage guidance
 *                       from the default prompt is gone.
 *   wrap              - legacy: system messages are inlined into the user
 *                       prompt as <system>...</system> blocks.
 *
 * OPENCLAW_TOOL_MAPPING (on|off, default on): the OpenClaw tool-name mapping
 * that is appended to the system prompt when the client sends no tools. Only
 * useful for OpenClaw clients - set to off for OpenWebUI and other clients.
 */

export type SystemPromptMode = "wrap" | "append" | "replace";

const MODES: SystemPromptMode[] = ["wrap", "append", "replace"];
let warnedInvalidMode = false;

export function getSystemPromptMode(): SystemPromptMode {
  const raw = (process.env.SYSTEM_PROMPT_MODE ?? "").trim().toLowerCase();
  if (!raw) return "append";
  if ((MODES as string[]).includes(raw)) return raw as SystemPromptMode;
  if (!warnedInvalidMode) {
    warnedInvalidMode = true;
    console.error(
      `[Prompt] Unknown SYSTEM_PROMPT_MODE "${process.env.SYSTEM_PROMPT_MODE}" - using "append" (valid: ${MODES.join(", ")})`
    );
  }
  return "append";
}

const OFF_VALUES = ["off", "0", "false", "no", "none"];

export function isOpenClawMappingEnabled(): boolean {
  const raw = (process.env.OPENCLAW_TOOL_MAPPING ?? "on").trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}
