FROM debian:trixie-slim

# Install system dependencies needed at build and runtime
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

# Copy the vellum meta package manifest and install all dependencies
COPY node_modules/vellum/package.json ./package.json
RUN bun install

# Copy the pre-built @vellumai packages into node_modules, replacing
# the versions installed from the npm registry
COPY node_modules/@vellumai/assistant ./node_modules/@vellumai/assistant
COPY node_modules/@vellumai/cli ./node_modules/@vellumai/cli
COPY node_modules/@vellumai/vellum-gateway ./node_modules/@vellumai/vellum-gateway

# Create the vellum CLI launcher backed by the bundled CLI package
RUN printf '#!/usr/bin/env sh\nexec bun run /app/node_modules/@vellumai/cli/src/index.ts "$@"\n' > /usr/local/bin/vellum && \
    chmod +x /usr/local/bin/vellum

CMD ["vellum", "hatch"]
