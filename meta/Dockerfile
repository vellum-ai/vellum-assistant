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

# Install vellum globally (provides the `vellum` CLI on PATH)
RUN bun add -g vellum

USER root

CMD ["vellum", "hatch", "--keep-alive"]
