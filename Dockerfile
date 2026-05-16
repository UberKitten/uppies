FROM node:22-alpine AS build

WORKDIR /app

# Native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

COPY scripts ./scripts
COPY frontend ./frontend
COPY src ./src
COPY bin ./bin

# Bundle the frontend (esbuild + Uppy)
RUN node scripts/build-frontend.js

# Drop devDependencies for the runtime image
RUN npm prune --omit=dev

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Runtime libs for the prebuilt better-sqlite3 native binding
RUN apk add --no-cache libstdc++ libc6-compat tini
# Reuse the `node` user that ships in node:alpine (uid/gid 1000).

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# Expose the CLI on PATH inside the container
RUN ln -s /app/bin/uppies.js /usr/local/bin/uppies && chmod +x /app/bin/uppies.js

ENV UPPIES_STORAGE_DIR=/data \
    UPPIES_PORT=3000 \
    UPPIES_HOST=0.0.0.0 \
    NODE_ENV=production

USER node
EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
