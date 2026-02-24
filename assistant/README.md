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
| `RUNTIME_GATEWAY_ORIGIN_SECRET` | No | — | Dedicated secret for the `X-Gateway-Origin` proof header on `/channels/inbound`. When not set, falls back to the bearer token. Both gateway and runtime must share the same value. |
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

When the assistant needs tool-use confirmation during a channel session (e.g., Telegram), the approval flow intercepts the run and surfaces an interactive prompt to the user. This approval-aware path is always enabled whenever orchestrator + callback context are available.

### How it works

1. **Detection** — When a channel inbound message triggers an agent loop, the runtime polls the run status. If the run transitions to `needs_confirmation`, the runtime sends an approval prompt to the gateway with inline keyboard metadata.
2. **Interception** — Subsequent inbound messages on the same conversation are intercepted before normal processing. The handler checks for a pending approval and attempts to extract a decision from either callback data (button clicks) or plain text.
3. **Decision** — The user's decision is mapped to the permission system (`allow` or `deny`) and applied to the pending run. For `approve_always`, a trust rule is persisted so future invocations of the same tool are auto-approved.
4. **Reminder** — If the user sends a non-decision message while an approval is pending, a reminder prompt is re-sent with the approval buttons.

### Delivery Semantics

**Single final output guarantee (deliver-once guard):** Both the main poll (`processChannelMessageWithApprovals`) and the post-decision poll (`schedulePostDecisionDelivery`) race to deliver the final assistant reply when a run reaches terminal state. The `claimRunDelivery()` function in `channel-delivery-store.ts` ensures at-most-one delivery per run using an in-memory `Set<string>`. The first caller to claim the run ID proceeds with delivery; the other silently skips. This guard is sufficient because both racing pollers execute within the same process.

**Stale callback blocking:** When inbound callback data (e.g., a Telegram button press) does not match any pending approval, the runtime returns `stale_ignored` and does not process the payload as a regular message. This prevents stale button presses from old approval prompts from triggering unrelated agent loops.

### Prompt Delivery Failure Policy (Fail-Closed)

All approval prompt delivery paths use a **fail-closed** policy -- if the prompt cannot be delivered, the run is auto-denied rather than left in a silent wait state:

- **Standard (self-approval) prompt:** If `deliverApprovalPrompt()` fails, the run is immediately auto-denied via `handleChannelDecision(reject)`. No silent `needs_confirmation` hang.
- **Guardian-routed prompt:** If the approval prompt cannot be delivered to the guardian's chat, the guardian approval record is marked `denied`, the underlying run is rejected, and the requester is notified that the action was denied because the prompt could not reach the guardian.
- **Unverified channel (no guardian binding):** Sensitive actions are auto-denied immediately without attempting prompt delivery. The requester is notified that no guardian has been configured.

### Plain-Text Fallback for Non-Rich Channels

Channels that do not support rich inline approval UI (e.g., inline keyboards) receive plain-text instructions embedded in the message body. The `channelSupportsRichApprovalUI()` check determines whether to send the structured `promptText` (for rich channels like Telegram) or the `plainTextFallback` string (for all other channels, e.g., SMS). The fallback text includes instructions like "Reply yes/no/always" so the user can respond via text.

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

Channel approvals are always enabled for channel traffic when orchestrator + callback context are available.

### Guardian-Specific Behavior

Guardian actor-role *classification* (determining whether a sender is guardian, non-guardian, or unverified) runs unconditionally. Guardian *enforcement* for non-guardian/unverified actors (`forceStrictSideEffects`, fail-closed denial for unverified channels, and approval prompt routing to guardians) is always active when orchestrator + callback context are available.

| Flag / Behavior | Description |
|-----------------|-------------|
| `forceStrictSideEffects` | Automatically set on runs triggered by non-guardian or unverified-channel senders so all side-effect tools require approval. |
| **Fail-closed no-binding** | When no guardian binding exists for a channel, the sender is classified as `unverified_channel`. Any sensitive action is auto-denied with a notice that no guardian has been configured. |
| **Fail-closed no-identity** | When `senderExternalUserId` is absent, the actor is classified as `unverified_channel` (even if no guardian binding exists yet). |
| **Guardian-only approval** | Non-guardian senders cannot approve their own pending actions. Only the verified guardian can approve or deny. |
| **Expired approval auto-deny** | A proactive sweep runs every 60 seconds to find expired guardian approval requests (30-minute TTL). Expired approvals are auto-denied, and both the requester and guardian are notified. If a non-guardian interacts before the sweep runs, the expiry is also detected reactively. |

### Ingress Boundary Guarantees (Gateway-Only Mode)

The runtime operates in **gateway-only mode**: all public-facing webhook paths are blocked at the runtime level. Direct access to Twilio webhook routes (`/webhooks/twilio/voice`, `/webhooks/twilio/status`, `/webhooks/twilio/connect-action`, `/webhooks/twilio/sms`) and their legacy equivalents (`/v1/calls/twilio/*`) returns `410 GATEWAY_ONLY`. This ensures external webhook traffic (including SMS) can only reach the runtime through the gateway, which performs signature validation before forwarding.

Internal forwarding routes (`/v1/internal/twilio/*`) are unaffected — these accept pre-validated payloads from the gateway over the private network.

### Gateway-Origin Ingress Contract

The `/channels/inbound` endpoint requires a valid `X-Gateway-Origin` header to prove the request originated from the gateway. This ensures channel messages can only arrive via the gateway (which performs webhook-level verification) and not via direct HTTP calls that bypass signature checks.

- **Dedicated secret (`RUNTIME_GATEWAY_ORIGIN_SECRET`):** When set, this is the expected value for the `X-Gateway-Origin` header. Both the gateway and the runtime must share this secret.
- **Bearer token fallback:** When `RUNTIME_GATEWAY_ORIGIN_SECRET` is not set, the runtime falls back to validating against the bearer token for backward compatibility.
- **Without any secret:** When neither a dedicated secret nor a bearer token is configured (local dev), gateway-origin validation is skipped entirely.
- **Auth layer order:** Bearer token authentication (`Authorization` header) is checked first. Gateway-origin validation runs inside the handler.

## Twilio Setup Primitive

Twilio is the shared telephony provider for both voice calls and SMS messaging. Configuration is managed through the `twilio_config` IPC contract and the `twilio-setup` skill. For SMS-specific onboarding (including compliance verification and test sending), the `sms-setup` skill provides a guided conversational flow that layers on top of `twilio-setup`.

### `twilio_config` IPC Contract

The daemon handles `twilio_config` messages with the following actions:

| Action | Description |
|--------|-------------|
| `get` | Returns current state: `hasCredentials` (boolean) and `phoneNumber` (if assigned) |
| `set_credentials` | Validates and stores Account SID and Auth Token in secure storage (Keychain / encrypted file). Credentials are retrieved from the credential store internally. |
| `clear_credentials` | Removes stored Account SID and Auth Token from secure storage. Preserves the phone number in both config (`sms.phoneNumber`) and secure key (`credential:twilio:phone_number`) so that re-entering credentials resumes working without needing to reassign the number. |
| `provision_number` | Purchases a new phone number via the Twilio API. Accepts optional `areaCode` and `country` (ISO 3166-1 alpha-2, default `US`). Auto-assigns the number to the assistant (persists to config and secure storage) and configures Twilio webhooks (voice, status callback, SMS) when a public ingress URL is available. |
| `assign_number` | Assigns an existing Twilio phone number (E.164 format) to the assistant and auto-configures webhooks when ingress is available |
| `list_numbers` | Lists all incoming phone numbers on the Twilio account with their capabilities (voice, SMS) |
| `sms_compliance_status` | Returns the SMS compliance posture for the assigned phone number. Determines number type (toll-free vs local 10DLC) and retrieves toll-free verification status from Twilio. |
| `sms_submit_tollfree_verification` | Submits a new toll-free verification request to Twilio. Validates required fields and enum values. Defaults `businessType` to `SOLE_PROPRIETOR`. |
| `sms_update_tollfree_verification` | Updates an existing toll-free verification by SID. Requires `verificationSid`. |
| `sms_delete_tollfree_verification` | Deletes a toll-free verification by SID. Includes warning about queue priority reset. |
| `release_number` | Releases (deletes) a phone number from the Twilio account. Clears the number from config and secure storage. Includes warning about toll-free verification context loss. |

Response type: `twilio_config_response` with `success`, `hasCredentials`, optional `phoneNumber`, optional `numbers` array, optional `error`, optional `warning` (for non-fatal webhook sync failures), and optional `compliance` object (for compliance status actions, containing `numberType`, `verificationSid`, `verificationStatus`, `rejectionReason`, `rejectionReasons`, `errorCode`, `editAllowed`, `editExpiration`).

### Ingress Webhook Reconciliation

When the public ingress URL is changed via the Settings UI (`ingress_config` set action), the daemon automatically reconciles Twilio webhooks in addition to triggering a Telegram webhook reconcile on the gateway. If all of the following conditions are met, the daemon pushes updated webhook URLs (voice, status callback, SMS) to Twilio:

1. Ingress is being **enabled** (not disabled)
2. Twilio **credentials** are configured (Account SID + Auth Token in secure storage)
3. A phone number is **assigned** (persisted in `sms.phoneNumber` config)

This reconciliation is **best-effort and fire-and-forget** -- failures are logged but do not block the ingress config save or produce an error response. This ensures that changing a tunnel URL (e.g., restarting ngrok) automatically updates Twilio's webhook routing without requiring manual re-assignment of the phone number.

### Single-Number-Per-Assistant Model

Each assistant is assigned a single Twilio phone number that is shared between voice calls and SMS. The number is stored in the assistant's config at `sms.phoneNumber` (legacy global field) and used as the `From` for outbound SMS via the gateway's `/deliver/sms` endpoint. The same credentials (Account SID, Auth Token) are used for both voice and SMS operations.

#### Assistant-Scoped Phone Numbers

When `assistantId` is provided in the `twilio_config` request, the `provision_number` and `assign_number` actions persist the phone number into a per-assistant mapping at `sms.assistantPhoneNumbers` (a `Record<string, string>` keyed by assistant ID). The legacy `sms.phoneNumber` field is always updated for backward compatibility.

The `get` action, when called with `assistantId`, resolves the phone number by checking `sms.assistantPhoneNumbers[assistantId]` first, falling back to `sms.phoneNumber`. This allows multiple assistants to have distinct phone numbers while preserving existing behavior for single-assistant setups.

The per-assistant mapping is propagated to the gateway via the config file watcher, enabling phone-number-based routing at the gateway boundary (see Gateway README).

### Phone Number Resolution Order

At runtime, `getTwilioConfig()` resolves the phone number using this priority chain:

1. **`TWILIO_PHONE_NUMBER` env var** — highest priority, explicit override for dev/CI.
2. **`sms.phoneNumber` in config** — the primary source of truth, written by `provision_number` and `assign_number`.
3. **`credential:twilio:phone_number` secure key** — backward-compatible fallback for setups that predate the config-first model.

If no number is found after all three sources, an error is thrown.

### Assistant-Scoped Guardian State

Guardian bindings, verification challenges, and approval requests are all scoped to an `(assistantId, channel)` pair. The `assistantId` parameter flows through `handleChannelInbound`, `validateAndConsumeChallenge`, `isGuardian`, `getGuardianBinding`, and `createApprovalRequest`. This means each assistant has its own independent guardian binding per channel -- verifying as guardian on one assistant does not grant guardian status on another.

### Channel-Aware Guardian Challenges

The channel guardian service generates verification challenge instructions with channel-appropriate wording. The `channelLabel()` function maps `sourceChannel` values to human-readable labels (e.g., `"telegram"` -> `"Telegram"`, `"sms"` -> `"SMS"`), so challenge prompts reference the correct channel name.

## Channel Readiness

The `channel_readiness` IPC contract provides a unified way to check whether a channel (SMS, Telegram, etc.) is fully configured and operational. It runs local checks (credential presence, phone number assignment, ingress config) synchronously and optional remote checks (API reachability) asynchronously with a 5-minute TTL cache.

### `channel_readiness` IPC Contract

| Action | Description |
|--------|-------------|
| `get` | Returns readiness snapshots for the specified channel (or all channels if omitted). Local checks always run; remote checks run only when `includeRemote=true` and cache is stale. |
| `refresh` | Invalidates the cache for the specified channel (or all channels), then returns fresh snapshots. |

Request fields: `action` (required), `channel` (optional filter), `assistantId` (optional), `includeRemote` (optional boolean).

Response type: `channel_readiness_response` with `success`, optional `snapshots` array (each with `channel`, `ready`, `checkedAt`, `stale`, `reasons`, `localChecks`, optional `remoteChecks`), and optional `error`.

### Built-in Channel Probes

- **SMS**: Checks Twilio credentials, phone number assignment, and public ingress URL.
- **Telegram**: Checks bot token, webhook secret, and public ingress URL.

### Key modules

| File | Purpose |
|------|---------|
| `src/runtime/channel-readiness-types.ts` | Shared types: `ChannelId`, `ReadinessCheckResult`, `ChannelReadinessSnapshot`, `ChannelProbe` |
| `src/runtime/channel-readiness-service.ts` | Service class with probe registration, cached readiness evaluation, and built-in SMS/Telegram probes |
| `src/daemon/handlers/config.ts` | `handleChannelReadiness` — IPC handler for `channel_readiness` messages |

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

### Guardian and gateway-origin issues

| Symptom | Cause | Resolution |
|---------|-------|------------|
| 403 `GATEWAY_ORIGIN_REQUIRED` on `/channels/inbound` | Missing or invalid `X-Gateway-Origin` header | Ensure `RUNTIME_GATEWAY_ORIGIN_SECRET` is set to the same value on both gateway and runtime. If not using a dedicated secret, ensure the bearer token (`RUNTIME_BEARER_TOKEN` or `~/.vellum/http-token`) is shared. |
| Non-guardian actions silently denied | No guardian binding for the channel. The system is fail-closed for unverified channels. | Run the guardian verification flow from the desktop UI to bind a guardian. |
| Guardian approval expired | The 30-minute TTL elapsed. The proactive sweep auto-denied the approval and notified both parties. | The requester must re-trigger the action. |
| `forceStrictSideEffects` unexpectedly active | The sender is classified as `non-guardian` or `unverified_channel` | Verify the sender's `externalUserId` matches the guardian binding, or set up a guardian binding for the channel. |

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
