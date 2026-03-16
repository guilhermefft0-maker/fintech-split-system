FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
COPY database/ ./database/

RUN npm run build

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/database ./database

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Worker has no HTTP port — it polls SQS in a loop
CMD ["node", "dist/worker/payment.worker.js"]
