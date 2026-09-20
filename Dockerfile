# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# git: useful for agent workflows; cron: OAuth keep-alive (see entrypoint.sh)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git cron \
  && rm -rf /var/lib/apt/lists/*

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled output + keep-alive script
COPY --from=builder /app/dist ./dist
COPY scripts/keepalive.sh ./scripts/keepalive.sh
RUN chmod +x ./scripts/keepalive.sh

# Non-root user for the proxy process. Note: node:*-slim images already
# ship a system user named "proxy", so we use a distinct name.
RUN useradd --create-home --shell /bin/bash proxyapp \
  && mkdir -p /data/.claude \
  && chown -R proxyapp:proxyapp /data /app

# Entrypoint: starts cron (OAuth keep-alive) when KEEPALIVE_CRON is set,
# then drops privileges and execs the given command
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# NOTE: no USER directive here - the entrypoint needs root to install the
# keep-alive cron job, then drops to proxyapp via runuser before exec'ing
# the server. The server process itself still runs unprivileged.
ENV HOME=/home/proxyapp \
    CLAUDE_CONFIG_DIR=/data/.claude \
    HOST=0.0.0.0 \
    PORT=3456

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server/standalone.js"]
