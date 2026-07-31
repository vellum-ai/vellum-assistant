# syntax=docker/dockerfile:1.20@sha256:26147acbda4f14c5add9946e2fd2ed543fc402884fd75146bd342a7f6271dc1d
# Build stage
FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS builder

WORKDIR /app

# We must include every workspace member's manifest to validate and install the
# workspace lockfile via --frozen-lockfile.
# Note that we don't need source code to resolve cross-workspace dependencies.
COPY package.json bun.lock ./
COPY patches ./patches
COPY clients/docs/package.json ./clients/docs/
COPY clients/macos/package.json ./clients/macos/
COPY clients/web/package.json ./clients/web/
COPY cli/package.json ./cli/
COPY gateway/package.json ./gateway/
COPY credential-executor/package.json ./credential-executor/
COPY assistant/package.json ./assistant/
COPY assistant/src/api/package.json ./assistant/src/api/
COPY --parents packages/*/package.json ./

RUN bun install --frozen-lockfile --ignore-scripts --filter=@vellumai/docs

# Copy source after installing dependencies for better layer caching.
COPY packages/design-library ./packages/design-library
COPY clients/docs ./clients/docs

ENV NEXT_TELEMETRY_DISABLED=1

RUN cd clients/docs && bun run build

# Next standalone output omits public/ and the request-time markdown mirrors
# (generated/md, served by the _md route). The prebuild scripts populate both;
# the mkdir guards the runner COPY against a build that emits neither.
RUN mkdir -p clients/docs/public clients/docs/generated/md

# Runtime stage
FROM node:22.22.2-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 1001 docs && \
    useradd --system --uid 1001 --gid docs docs

# The standalone tree mirrors the monorepo layout (server.js lives under
# clients/docs/ with hoisted node_modules at the root).
COPY --from=builder --chown=docs:docs /app/clients/docs/.next/standalone ./
COPY --from=builder --chown=docs:docs /app/clients/docs/.next/static ./clients/docs/.next/static
COPY --from=builder --chown=docs:docs /app/clients/docs/public ./clients/docs/public
COPY --from=builder --chown=docs:docs /app/clients/docs/generated/md ./clients/docs/generated/md

USER docs

WORKDIR /app/clients/docs

EXPOSE 3000

CMD ["node", "server.js"]
