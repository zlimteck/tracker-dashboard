FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install && npm install --no-save playwright@1.60.0 top-user-agents@2.1.111
COPY src/ ./src/
RUN npm run build

# ── Image finale (sans devDependencies ni sources TS) ──────────────────────
FROM node:22-bookworm-slim

WORKDIR /app
ARG APP_IMAGE_SOURCE=local
ARG APP_IMAGE_VERSION=dev
ARG APP_IMAGE_REVISION=unknown
ARG APP_IMAGE_REF=local
ENV APP_IMAGE_SOURCE=$APP_IMAGE_SOURCE \
    APP_IMAGE_VERSION=$APP_IMAGE_VERSION \
    APP_IMAGE_REVISION=$APP_IMAGE_REVISION \
    APP_IMAGE_REF=$APP_IMAGE_REF
COPY package*.json ./
RUN npm install --omit=dev && npm install --omit=dev --no-save playwright@1.60.0 top-user-agents@2.1.111
RUN npx playwright install --with-deps chromium
RUN apt-get update \
  && apt-get install --only-upgrade -y --no-install-recommends libgnutls30 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY config/trackers/ ./default-trackers/

EXPOSE 3000
CMD ["node", "--experimental-sqlite", "dist/index.js"]
