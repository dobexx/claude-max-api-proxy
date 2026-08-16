# ---- Build stage ----
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim

# Claude Code CLI - the proxy wraps it as a subprocess.
# The CLI reads its OAuth credentials from $CLAUDE_CONFIG_DIR (default ~/.claude),
# so mount a persistent volume there.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Non-root user for the proxy process
RUN useradd --create-home --shell /bin/bash proxy \
  && mkdir -p /data/.claude \
  && chown -R proxy:proxy /data /app
USER proxy

# Claude CLI config/credentials live here - mount a volume on /data
ENV HOME=/home/proxy \
    CLAUDE_CONFIG_DIR=/data/.claude \
    HOST=0.0.0.0 \
    PORT=3456

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3456)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/standalone.js"]
