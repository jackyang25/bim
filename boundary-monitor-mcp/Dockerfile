# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./
COPY tsconfig.json ./

# Install ALL dependencies (including devDependencies for tsc)
RUN npm install

# Copy source
COPY src/ ./src/
COPY evaluations/ ./evaluations/

# Compile TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Security: run as non-root user
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp

WORKDIR /app

# Copy only what the server needs to run
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/evaluations ./evaluations

# Create writable data directory owned by non-root user
RUN mkdir -p /data && chown mcp:mcp /data

USER mcp

# ─── Environment defaults ─────────────────────────────────────────────────────
# ANTHROPIC_API_KEY must be injected at runtime — never bake it into the image.
# Override any of these via `docker run -e VAR=value ...`

ENV NODE_ENV=production \
    ANNOTATION_MODEL=claude-haiku-4-5 \
    ANNOTATION_TIMEOUT_MS=30000 \
    ANNOTATION_MAX_RETRIES=1 \
    MAX_USER_INPUT_CHARS=10000 \
    MAX_AGENT_OUTPUT_CHARS=10000 \
    MAX_SESSION_HISTORY_ITEMS=20 \
    MAX_REQUESTS_PER_MINUTE=60 \
    VERDICTS_PATH=/data/verdicts.json \
    AUDIT_LOG_PATH=/data/audit.ndjson

# MCP servers communicate over stdio — no ports to expose.
# The container is started by the MCP host (e.g., Claude Desktop, claude-code)
# which connects stdin/stdout directly.

ENTRYPOINT ["node", "dist/index.js"]
