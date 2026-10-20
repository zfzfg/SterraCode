# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM ${NODE_IMAGE} AS app
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/zfzfg/SterraCode"
ENV NODE_ENV=production STERRACODE_MODE=docker STERRACODE_DATA_DIR=/data STERRACODE_WORKSPACE_DIR=/workspaces
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sterracode && useradd --uid 10001 --gid 10001 --no-create-home sterracode
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY runner/tracer ./runner/tracer
COPY runner/grading ./runner/grading
COPY public ./public
COPY shared ./shared
COPY docker ./docker
USER 10001:10001
EXPOSE 3000
CMD ["node", "server/index.js"]
