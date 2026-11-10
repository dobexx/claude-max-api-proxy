#!/bin/sh
# Keep the Claude OAuth session(s) alive: a minimal CLI invocation triggers the
# lazy token refresh so the refresh token never ages out. Quiet on success,
# logs a clear line on failure so it shows up in container logs.
#
# Multi-account mode (ACCOUNTS="loupz=/data/.claude,jungherz,..."): every
# account is pinged with its own config dir (default $ACCOUNTS_DIR/<name>).

ping_account() {
  # $1 = label, $2 = config dir (empty = inherited CLAUDE_CONFIG_DIR)
  if [ -n "$2" ]; then
    [ -f "$2/.credentials.json" ] || { echo "$(date -u +%FT%TZ) [keepalive] $1: not logged in ($2)" >&2; return; }
    OUT=$(CLAUDE_CONFIG_DIR="$2" claude --print --model haiku --dangerously-skip-permissions "ping" 2>&1)
  else
    OUT=$(claude --print --model haiku --dangerously-skip-permissions "ping" 2>&1)
  fi
  RC=$?
  if echo "$OUT" | grep -qiE "expired|authenticate|not logged in|could not be refreshed"; then
    echo "$(date -u +%FT%TZ) [keepalive] $1 AUTH FAILURE: $OUT" >&2
  elif [ $RC -ne 0 ]; then
    echo "$(date -u +%FT%TZ) [keepalive] $1 CLI exited $RC: $OUT" >&2
  fi
}

if [ -n "$ACCOUNTS" ]; then
  BASE="${ACCOUNTS_DIR:-/data/accounts}"
  echo "$ACCOUNTS" | tr ',' '\n' | while read -r entry; do
    entry=$(echo "$entry" | tr -d ' ')
    [ -n "$entry" ] || continue
    case "$entry" in
      *=*) name="${entry%%=*}"; dir="${entry#*=}" ;;
      *)   name="$entry"; dir="$BASE/$entry" ;;
    esac
    ping_account "$name" "$dir"
  done
else
  ping_account "default" ""
fi
