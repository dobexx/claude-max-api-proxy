#!/bin/sh
# Container entrypoint: optional OAuth keep-alive cron, then exec the app.
# KEEPALIVE_CRON is a cron schedule (default: Mondays 06:00 UTC). Set
# KEEPALIVE_CRON="" to disable the keep-alive entirely.
#
# Privilege model: the container is started by the orchestrator (root or a
# mapped user). If we have write access to /etc/cron.d we install the cron
# job; the cron daemon runs the job AS proxyapp (user field in crontab).
# The server itself runs via setpriv as proxyapp when we are root,
# otherwise directly (already unprivileged).
set -e

SCHEDULE="${KEEPALIVE_CRON-0 6 * * 1}"

if [ -n "$SCHEDULE" ] && [ -w /etc/cron.d ]; then
  {
    echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/data/.claude}"
    echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "$SCHEDULE proxyapp /app/scripts/keepalive.sh >> /proc/1/fd/2 2>&1"
  } > /etc/cron.d/keepalive
  chmod 0644 /etc/cron.d/keepalive
  cron 2>/dev/null || true
  echo "[entrypoint] keep-alive cron active: $SCHEDULE"
else
  echo "[entrypoint] keep-alive cron skipped (no write access to /etc/cron.d or disabled)"
fi

if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=proxyapp --regid=proxyapp --clear-groups "$@"
else
  exec "$@"
fi
