FROM oven/bun:1.2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./tsconfig.json

EXPOSE 7831

CMD ["bun", "run", "src/index.ts"]
