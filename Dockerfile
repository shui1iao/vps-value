FROM node:24-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM dependencies AS build
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build

# Keep the existing CI checks inside Docker; not part of the production build.
FROM dependencies AS verify
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY server.mjs ./
COPY test ./test
RUN npm test && npm run build && npm audit --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    STATIC_DIR=/app/dist \
    STORAGE_DIR=/app/storage/shares
COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src ./src
COPY server.mjs ./
# Docker seeds a fresh named volume with these ownership/permission settings.
RUN mkdir -p /app/storage/shares \
    && chown 1000:1000 /app/storage/shares \
    && chmod 750 /app/storage/shares
USER 1000:1000
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/health', { signal: AbortSignal.timeout(4000) }); if (!r.ok || (await r.json()).ok !== true) process.exit(1)"]
CMD ["node", "server.mjs"]
