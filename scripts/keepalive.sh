#!/bin/sh
# Keep the Claude OAuth session alive: a minimal CLI invocation triggers the
# lazy token refresh so the refresh token never ages out. Quiet on success,
# logs a clear line on failure so it shows up in container logs.
OUT=$(claude --print --model haiku --dangerously-skip-permissions "ping" 2>&1)
RC=$?
if echo "$OUT" | grep -qiE "expired|authenticate|not logged in|could not be refreshed"; then
  echo "$(date -u +%FT%TZ) [keepalive] AUTH FAILURE: $OUT" >&2
elif [ $RC -ne 0 ]; then
  echo "$(date -u +%FT%TZ) [keepalive] CLI exited $RC: $OUT" >&2
fi
