#!/bin/sh
# Container entrypoint: optional OAuth keep-alive cron, then exec the app.
# KEEPALIVE_CRON is a cron schedule (default: Mondays 06:00 UTC). Set
# KEEPALIVE_CRON="" to disable the keep-alive entirely.
set -e

SCHEDULE="${KEEPALIVE_CRON-0 6 * * 1}"

if [ -n "$SCHEDULE" ]; then
  {
    echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-/data/.claude}"
    echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "$SCHEDULE proxyapp /app/scripts/keepalive.sh >> /proc/1/fd/2 2>&1"
  } > /etc/cron.d/keepalive
  chmod 0644 /etc/cron.d/keepalive
  cron
  echo "[entrypoint] keep-alive cron active: $SCHEDULE"
fi

exec runuser -u proxyapp -- "$@"
