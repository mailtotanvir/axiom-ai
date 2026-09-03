# Shared multi-stage build for the TypeScript Axiom AI services.
#
# Build from the repository ROOT so the workspace lockfile resolves
# @tanvir1971/core from source:
#
#   docker build -f deploy/docker/service.Dockerfile \
#     --build-arg SERVICE_WORKSPACE=@axiom-ai/gateway \
#     --build-arg SERVICE_DIR=gateway \
#     --build-arg SERVICE_ENTRY=services/gateway/dist/index.js .

ARG NODE_VERSION=24-alpine
FROM node:${NODE_VERSION} AS build
ARG SERVICE_WORKSPACE
ARG SERVICE_DIR
WORKDIR /repo
RUN apk upgrade --no-cache

# Manifests first for layer-cached dependency installs.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core-shared/package.json packages/core-shared/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/agent-runtime/package.json services/agent-runtime/package.json
COPY services/ops-observability/package.json services/ops-observability/package.json
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/core-shared packages/core-shared
COPY services/${SERVICE_DIR} services/${SERVICE_DIR}
# Prisma client types are imported by tsc; generate before building.
# Only services shipping a prisma schema need this step.
RUN if [ -f services/${SERVICE_DIR}/prisma/schema.prisma ]; then npx prisma generate --schema services/${SERVICE_DIR}/prisma/schema.prisma; fi
RUN npm run build -w @tanvir1971/core -w "${SERVICE_WORKSPACE}"
# Drop devDependencies (typescript, vitest, prisma CLI, ...) so the runtime
# stage ships production modules only.
RUN npm prune --omit=dev

FROM node:${NODE_VERSION} AS runtime
ARG SERVICE_WORKSPACE
ARG SERVICE_DIR
ARG SERVICE_ENTRY
WORKDIR /repo
# Patch OS CVEs and remove the npm toolchain: the runtime executes
# `node` directly and never needs npm/npx, so shipping them only widens
# the vulnerability surface (and trips image scanners).
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
LABEL org.opencontainers.image.source=https://github.com/axiom-ai/axiom
LABEL org.opencontainers.image.licenses=Apache-2.0
LABEL ai.axiom.service=${SERVICE_WORKSPACE}

COPY --from=build /repo ./
ENV SERVICE_ENTRY=${SERVICE_ENTRY}
USER node
CMD ["sh", "-c", "exec node \"${SERVICE_ENTRY}\""]
