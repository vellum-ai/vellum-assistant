FROM oven/bun:1.2

WORKDIR /app

# Copy gateway package first (required by file:../gateway dependency)
COPY gateway/package.json /gateway/package.json
COPY gateway/src /gateway/src

COPY gateway-managed/package.json gateway-managed/bun.lock ./
RUN bun install --frozen-lockfile

COPY gateway-managed/src ./src
COPY gateway-managed/tsconfig.json ./tsconfig.json

EXPOSE 7831

CMD ["bun", "run", "src/index.ts"]
