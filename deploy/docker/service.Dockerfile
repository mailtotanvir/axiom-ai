# Shared multi-stage build for the TypeScript Axiom AI services.
#
# Build from the repository ROOT so the workspace lockfile resolves
# @axiom-ai/core from source:
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
RUN npm run build -w @axiom-ai/core -w "${SERVICE_WORKSPACE}"

FROM node:${NODE_VERSION} AS runtime
ARG SERVICE_WORKSPACE
ARG SERVICE_DIR
ARG SERVICE_ENTRY
WORKDIR /repo
ENV NODE_ENV=production
LABEL org.opencontainers.image.source=https://github.com/axiom-ai/axiom
LABEL org.opencontainers.image.licenses=Apache-2.0
LABEL ai.axiom.service=${SERVICE_WORKSPACE}

COPY --from=build /repo ./
RUN npm prune --omit=dev >/dev/null 2>&1 || true
ENV SERVICE_ENTRY=${SERVICE_ENTRY}
USER node
CMD ["sh", "-c", "exec node \"${SERVICE_ENTRY}\""]
