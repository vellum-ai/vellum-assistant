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
│   ├── schedule/             # Reminders and recurrence scheduling (cron + RRULE)
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

## Channel Approval Flow

When the assistant needs tool-use confirmation during a channel session (e.g., Telegram), the approval flow intercepts the run and surfaces an interactive prompt to the user. This is gated behind the `CHANNEL_APPROVALS_ENABLED=true` environment variable.

### How it works

1. **Detection** — When a channel inbound message triggers an agent loop, the runtime polls the run status. If the run transitions to `needs_confirmation`, the runtime sends an approval prompt to the gateway with inline keyboard metadata.
2. **Interception** — Subsequent inbound messages on the same conversation are intercepted before normal processing. The handler checks for a pending approval and attempts to extract a decision from either callback data (button clicks) or plain text.
3. **Decision** — The user's decision is mapped to the permission system (`allow` or `deny`) and applied to the pending run. For `approve_always`, a trust rule is persisted so future invocations of the same tool are auto-approved.
4. **Reminder** — If the user sends a non-decision message while an approval is pending, a reminder prompt is re-sent with the approval buttons.

### Key modules

| File | Purpose |
|------|---------|
| `src/runtime/channel-approvals.ts` | Orchestration: `getChannelApprovalPrompt`, `buildApprovalUIMetadata`, `handleChannelDecision`, `buildReminderPrompt` |
| `src/runtime/channel-approval-parser.ts` | Plain-text decision parser — matches phrases like `yes`, `approve`, `always`, `no`, `reject`, `deny`, `cancel` (case-insensitive) |
| `src/runtime/channel-approval-types.ts` | Shared types: `ApprovalAction`, `ChannelApprovalPrompt`, `ApprovalUIMetadata`, `ApprovalDecisionResult` |
| `src/runtime/routes/channel-routes.ts` | Integration point: `handleApprovalInterception` and `processChannelMessageWithApprovals` in the channel inbound handler |
| `src/runtime/gateway-client.ts` | `deliverApprovalPrompt()` — sends the approval payload (text + UI metadata) to the gateway for rendering |
| `src/memory/runs-store.ts` | `getPendingConfirmationsByConversation` — queries runs in `needs_confirmation` state |

### Enabling

Set the environment variable before starting the daemon:

```bash
CHANNEL_APPROVALS_ENABLED=true
```

When disabled (the default), channel messages follow the standard fire-and-forget processing path without approval interception.

### Guardian-Specific Behavior

When `CHANNEL_APPROVALS_ENABLED=true`, the channel guardian system adds a trust layer:

| Flag / Behavior | Description |
|-----------------|-------------|
| `CHANNEL_APPROVALS_ENABLED=true` | Enables the approval flow and guardian role resolution on channel inbound messages |
| `forceStrictSideEffects` | Automatically set on runs triggered by non-guardian or unverified-channel senders so all side-effect tools require approval |
| **Fail-closed no-binding** | When no guardian binding exists for a channel, the sender is classified as `unverified_channel`. Any sensitive action is auto-denied with a notice that no guardian has been configured. This prevents unverified senders from self-approving actions. |
| **Guardian-only approval** | Non-guardian senders cannot approve their own pending actions. Only the verified guardian can approve or deny. |
| **Expired approval auto-deny** | If a guardian approval request expires (30-minute TTL) without a decision, the action is auto-denied when the non-guardian sender next interacts. |

### Gateway-Origin Ingress Contract

The `/channels/inbound` endpoint requires a valid `X-Gateway-Origin` header that matches the configured bearer token. This ensures channel messages can only be submitted via the gateway (which performs webhook-level verification) and not via direct HTTP calls that bypass signature checks.

- **With bearer token configured:** Requests must include `X-Gateway-Origin` with the shared secret. Missing or invalid values return `403 GATEWAY_ORIGIN_REQUIRED`.
- **Without bearer token:** Gateway-origin validation is skipped (local dev without auth).
- **Auth layer order:** Bearer token authentication (`Authorization` header) is checked first. Gateway-origin validation runs inside the handler.

## Twilio Setup Primitive

Twilio is the shared telephony provider for both voice calls and SMS messaging. Configuration is managed through the `twilio_config` IPC contract and the `twilio-setup` skill.

### `twilio_config` IPC Contract

The daemon handles `twilio_config` messages with the following actions:

| Action | Description |
|--------|-------------|
| `get` | Returns current state: `hasCredentials` (boolean) and `phoneNumber` (if assigned) |
| `set_credentials` | Validates and stores Account SID and Auth Token in secure storage (Keychain / encrypted file). Credentials are retrieved from the credential store internally. |
| `clear_credentials` | Removes stored Account SID and Auth Token from secure storage. Does not affect the phone number assignment. |
| `provision_number` | Purchases a new phone number via the Twilio API. Accepts optional `areaCode` and `country` (ISO 3166-1 alpha-2, default `US`). Returns the purchased number but does not assign it — call `assign_number` separately to persist it. |
| `assign_number` | Assigns an existing Twilio phone number (E.164 format) to the assistant |
| `list_numbers` | Lists all incoming phone numbers on the Twilio account with their capabilities (voice, SMS) |

Response type: `twilio_config_response` with `success`, `hasCredentials`, optional `phoneNumber`, optional `numbers` array, and optional `error`.

### Single-Number-Per-Assistant Model

Each assistant is assigned a single Twilio phone number that is shared between voice calls and SMS. The number is stored in the assistant's config at `sms.phoneNumber` and used as the `From` for outbound SMS via the gateway's `/deliver/sms` endpoint. The same credentials (Account SID, Auth Token) are used for both voice and SMS operations.

### Channel-Aware Guardian Challenges

The channel guardian service generates verification challenge instructions with channel-appropriate wording. The `channelLabel()` function maps `sourceChannel` values to human-readable labels (e.g., `"telegram"` -> `"Telegram"`, `"sms"` -> `"SMS"`), so challenge prompts reference the correct channel name.

## Database

SQLite via Drizzle ORM, stored at `~/.vellum/workspace/data/db/assistant.db`. Key tables include conversations, messages, tool invocations, attachments, memory segments (with FTS5), memory items, entities, reminders, and recurrence schedules (cron + RRULE).

> **Compatibility note:** The recurrence schedule system supports both cron expressions and iCalendar RRULE syntax. The legacy field names `cron_expression` and `cronExpression` remain supported in API inputs. New code should use the `expression` field with an explicit `syntax` discriminator. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for details.

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

## Troubleshooting

### Invalid RRULE set expressions

If `schedule_create` rejects an RRULE expression, check the following:

- **Missing DTSTART** — Every RRULE expression must include a `DTSTART` line (e.g., `DTSTART:20250101T090000Z`).
- **No inclusion rule** — At least one `RRULE:` or `RDATE` line is required. An expression with only `EXDATE` or `EXRULE` lines and no inclusion has no occurrences to schedule.
- **Unsupported lines** — Only `DTSTART`, `RRULE:`, `RDATE`, `EXDATE`, and `EXRULE` prefixes are recognized. Any other line (e.g., `VTIMEZONE`, `VEVENT`) will be rejected.
- **Newline encoding** — When passing multi-line RRULE expressions through JSON, use literal `\n` between lines. The engine normalizes escaped newlines automatically.

## Development

```bash
cd assistant
bun install
bun run typecheck   # TypeScript type check (tsc --noEmit)
bun run lint        # ESLint
bun run test        # Run test suite
```
