# Use debian as base image
FROM debian:trixie@sha256:3615a749858a1cba49b408fb49c37093db813321355a9ab7c1f9f4836341e9db

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    g++ \
    git \
    make \
    python3 \
    sudo \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

WORKDIR /app

# Copy the vellum meta package manifest
COPY node_modules/vellum/package.json ./package.json

# Copy the pre-built @vellumai packages into node_modules
COPY node_modules/@vellumai/assistant ./node_modules/@vellumai/assistant
COPY node_modules/@vellumai/cli ./node_modules/@vellumai/cli
COPY node_modules/@vellumai/vellum-gateway ./node_modules/@vellumai/vellum-gateway

# Install remaining transitive dependencies
RUN bun install

# Create the vellum CLI launcher backed by the bundled CLI package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/node_modules/@vellumai/cli/src/index.ts "$@"\n' > /usr/local/bin/vellum && \
    chmod +x /usr/local/bin/vellum

USER root

CMD ["vellum", "hatch"]
