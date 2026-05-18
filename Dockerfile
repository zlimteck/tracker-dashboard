FROM node:22.15.0-bookworm-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci && npm install --no-save playwright@1.60.0 top-user-agents@2.1.111
COPY src/ ./src/
RUN npm run build

# ── Image finale (sans devDependencies ni sources TS) ──────────────────────
FROM node:22.15.0-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm install --omit=dev --no-save playwright@1.60.0 top-user-agents@2.1.111
RUN npx playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY config/trackers/ ./default-trackers/

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "dist/index.js"]
