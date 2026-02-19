# Vellum Assistant Runtime

Bun + TypeScript daemon that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes a Unix domain socket (macOS) and optional TCP listener (iOS) for native clients, plus an HTTP API consumed by the gateway.

## Architecture

```
CLI / macOS app / iOS app
        │
        ▼
   Unix socket (~/.vellum/vellum.sock)
        │
        ▼
   DaemonServer (IPC)
        │
        ├── Session Manager (in-memory pool, stale eviction)
        │       ├── Anthropic Claude (primary)
        │       ├── OpenAI (secondary)
        │       ├── Google Gemini (secondary)
        │       └── Ollama (local models)
        │
        ├── Memory System (FTS5 + Qdrant + Entity Graph)
        ├── Skill Tool System (bundled + managed + workspace)
        ├── Swarm Orchestration (DAG scheduler + worker pool)
        ├── Script Proxy (credential injection + MITM)
        └── Tracing (per-session event emitter)
```

## Setup

```bash
cd assistant
bun install
cp .env.example .env
# Edit .env with your API keys
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | No | — | OpenAI API key |
| `GEMINI_API_KEY` | No | — | Google Gemini API key |
| `OLLAMA_API_KEY` | No | — | API key for authenticated Ollama deployments |
| `OLLAMA_BASE_URL` | No | `http://127.0.0.1:11434/v1` | Ollama base URL |
| `RUNTIME_HTTP_PORT` | No | — | Enable the HTTP server (required for gateway/web) |
| `VELLUM_DAEMON_SOCKET` | No | `~/.vellum/vellum.sock` | Override the daemon socket path |

## Usage

### Start the daemon

```bash
bun run src/index.ts daemon start
```

### Interactive CLI

```bash
bun run src/index.ts
```

### Dev mode (auto-restart on file changes)

```bash
bun run src/index.ts dev
```

### CLI commands

| Command | Description |
|---------|-------------|
| `vellum` | Launch interactive CLI session |
| `vellum daemon start\|stop\|restart\|status` | Manage the daemon process |
| `vellum dev` | Run daemon with auto-restart on file changes |
| `vellum sessions list\|new\|export\|clear` | Manage conversation sessions |
| `vellum config set\|get\|list` | Manage configuration |
| `vellum keys set\|list\|delete` | Manage API keys in secure storage |
| `vellum trust list\|remove\|clear` | Manage trust rules |
| `vellum doctor` | Run diagnostic checks |

## Project Structure

```
assistant/
├── src/
│   ├── index.ts              # CLI entrypoint (commander)
│   ├── cli.ts                # Interactive REPL client
│   ├── daemon/               # Daemon server, IPC protocol, session management
│   ├── agent/                # Agent loop and LLM interaction
│   ├── providers/            # LLM provider integrations (Anthropic, OpenAI, Gemini, Ollama)
│   ├── memory/               # Conversation store, memory indexer, recall (FTS5 + Qdrant)
│   ├── skills/               # Skill catalog, loading, and tool factory
│   ├── tools/                # Built-in tool definitions
│   ├── swarm/                # Swarm orchestration (DAG scheduler, worker pool)
│   ├── permissions/          # Trust rules and permission system
│   ├── security/             # Secure key storage, credential broker
│   ├── config/               # Configuration loader and schema
│   ├── runtime/              # HTTP runtime server
│   ├── messaging/            # Message processing pipeline
│   ├── context/              # Context assembly and compaction
│   ├── playbooks/            # Channel onboarding playbooks
│   ├── home-base/            # Home Base app-link bootstrap
│   ├── hooks/                # Git-style lifecycle hooks
│   ├── media/                # Media processing and attachments
│   ├── schedule/             # Reminders and scheduling
│   ├── tasks/                # Task management
│   ├── workspace/            # Workspace file operations
│   ├── events/               # Domain event bus
│   ├── export/               # Session export (markdown/JSON)
│   ├── util/                 # Shared utilities
│   └── __tests__/            # Test suites
├── drizzle/                  # Database migrations
├── drizzle.config.ts         # Drizzle ORM config (SQLite)
├── docs/                     # Internal documentation
├── scripts/                  # Test runners and IPC codegen
├── Dockerfile                # Production container image
├── Dockerfile.sandbox        # Sandbox container for bash tool
└── package.json
```

## Database

SQLite via Drizzle ORM, stored at `~/.vellum/workspace/data/db/assistant.db`. Key tables include conversations, messages, tool invocations, attachments, memory segments (with FTS5), memory items, entities, and reminders.

Run migrations:

```bash
bun run db:generate   # Generate migration SQL
bun run db:push       # Apply migrations
```

## Docker

```bash
# Build production image
docker build -t vellum-assistant:local assistant

# Run
docker run --rm -p 3001:3001 \
  -e ANTHROPIC_API_KEY=... \
  vellum-assistant:local
```

The image runs as non-root user `assistant` (uid 1001) and exposes port `3001`.

## Development

```bash
cd assistant
bun install
bun run typecheck   # TypeScript type check (tsc --noEmit)
bun run lint        # ESLint
bun run test        # Run test suite
```
