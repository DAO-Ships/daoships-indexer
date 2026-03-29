# ── Build stage ───────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs indexer

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist/ dist/

# Set ownership
RUN chown -R indexer:nodejs /app

# Switch to non-root user
USER indexer

ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.HEALTH_CHECK_PORT || 8080) + '/live').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

EXPOSE 8080

CMD ["node", "dist/index.js"]
