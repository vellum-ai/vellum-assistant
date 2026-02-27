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

For assistant architecture deep dives, see [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/architecture/`](docs/architecture/).

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

## Update Bulletin

When a release includes relevant updates, the daemon materializes release notes from the bundled `src/config/templates/UPDATES.md` into `~/.vellum/workspace/UPDATES.md` on startup. The assistant uses judgment to surface updates to the user when relevant, and deletes the file when done.

**For release maintainers:** Update `assistant/src/config/templates/UPDATES.md` with release notes before each relevant release. Leave the template empty (or comment-only) for releases with no user/assistant-facing changes.

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
| `sms_send_test` | Sends a test SMS to the specified `phoneNumber` with the given `text`, polls Twilio for delivery status (up to 3 retries at 2-second intervals), and returns the result in `testResult`. Stores the last result in memory for use by `sms_doctor`. |
| `sms_doctor` | Runs a comprehensive SMS health diagnostic. Checks channel readiness, compliance/toll-free verification status, and the last `sms_send_test` result. Returns structured diagnostics in `diagnostics` with an overall `status` ("healthy", "degraded", or "unhealthy") and actionable `items`. |

Response type: `twilio_config_response` with `success`, `hasCredentials`, optional `phoneNumber`, optional `numbers` array, optional `error`, optional `warning` (for non-fatal webhook sync failures), optional `compliance` object (for compliance status actions, containing `numberType`, `verificationSid`, `verificationStatus`, `rejectionReason`, `rejectionReasons`, `errorCode`, `editAllowed`, `editExpiration`), optional `testResult` (for `sms_send_test`), and optional `diagnostics` (for `sms_doctor`).

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

### Operator Notes

- **Verification input format:** Channel verification accepts a bare code reply only (6-digit numeric for identity-bound sessions; 64-char hex for unbound inbound/bootstrap compatibility).
- **Rebind requirement:** Creating a new guardian challenge when a binding already exists requires `rebind: true` in the IPC request. Without it, the daemon returns `already_bound`. This prevents accidental guardian replacement.
- **Takeover prevention:** Verification is rejected when an active binding exists for a different external user. Same-user re-verification is allowed.

## Guardian Verification and Ingress ACL

This section documents the end-to-end flow from guardian verification through ingress membership enforcement, showing how the two systems work together to gate channel access.

### Guardian Verification Flow

Guardian verification establishes a cryptographic trust binding between a human identity and an `(assistantId, channel)` pair. The flow is:

1. **Challenge creation** — The owner initiates verification from the desktop UI, which sends a guardian-verification IPC message (`create_challenge` action) to the daemon. The daemon generates a random secret (32-byte hex for unbound inbound/bootstrap sessions, 6-digit numeric for identity-bound sessions), hashes it with SHA-256, stores the hash with a 10-minute TTL, and returns the raw secret to the desktop.
2. **Code sharing** — The desktop displays the code and instructs the owner to reply with that code in the target channel conversation (e.g., Telegram or SMS).
3. **Verification** — When the message arrives at `/channels/inbound`, the handler intercepts valid verification-code replies before normal message processing. It hashes the provided code, looks up a matching pending challenge, validates expiry, and consumes the challenge (preventing replay).
4. **Binding** — On success, any existing active binding for the `(assistantId, channel)` pair is revoked, and a new guardian binding is created with the verifier's `externalUserId` and `chatId`. The verifier receives a confirmation message.

Rate limiting protects against brute-force attempts: 5 invalid attempts within 15 minutes trigger a 30-minute lockout per `(assistantId, channel, actor)` tuple. The same generic failure message is returned for both invalid codes and rate-limited attempts to avoid leaking state.

### Ingress ACL Enforcement

The ingress ACL runs at the top of the channel inbound handler, before guardian role resolution and message processing. When `senderExternalUserId` is present, the handler enforces this decision chain:

1. **Member lookup** — Look up the sender in `assistant_ingress_members` by `(sourceChannel, externalUserId)` or `(sourceChannel, externalChatId)`.
2. **Non-member denial** — If no member record exists, the message is denied with `not_a_member`.
3. **Status check** — If the member exists but is not `active` (e.g., `revoked` or `blocked`), the message is denied.
4. **Policy check** — The member's `policy` field determines routing:
   - `allow` — Message proceeds to normal agent processing.
   - `deny` — Message is rejected with `policy_deny`.
   - `escalate` — Message is held for guardian approval (see Escalation Flow below).

### Escalation Flow

When a member's policy is `escalate`:

1. The handler looks up the guardian binding for the `(assistantId, channel)` pair. If no binding exists, the message is denied with `escalate_no_guardian` (fail-closed).
2. The raw message payload is stored so it can be recovered on approval.
3. A `channel_guardian_approval_request` is created with a 30-minute TTL.
4. The guardian is notified via the canonical notification pipeline (`emitNotificationSignal`), which routes the escalation alert to all configured channels (Telegram/SMS push, desktop notification).
5. On **approve**, the stored payload is replayed through the agent pipeline and the assistant's response is delivered to the external user. On **deny**, a refusal message is sent.

### How the Systems Connect

Guardian verification and ingress membership are complementary but independent systems:

- **Guardian verification** establishes *who controls the assistant* on a given channel. The guardian can approve sensitive actions, approve escalated messages, and is the trust anchor.
- **Ingress membership** controls *who can interact with the assistant* on a given channel. Members are created via invite redemption, not via guardian verification.
- **Dependency**: Escalation requires a guardian binding — if no guardian has been verified for the channel, `escalate` policy messages are denied. This means guardian verification must precede any escalation-based access control.

### Key Modules

| File | Purpose |
|------|---------|
| `src/runtime/channel-guardian-service.ts` | Challenge lifecycle: `createVerificationChallenge`, `validateAndConsumeChallenge`, `getGuardianBinding`, `isGuardian` |
| `src/runtime/guardian-context-resolver.ts` | Actor role classification: guardian / non-guardian / unverified_channel |
| `src/runtime/routes/inbound-message-handler.ts` | Ingress ACL enforcement, verification-code intercept, escalation creation |
| `src/memory/ingress-member-store.ts` | Member CRUD: `findMember`, `upsertMember`, `revokeMember`, `blockMember` |
| `src/memory/ingress-invite-store.ts` | Invite lifecycle: `createInvite`, `redeemInvite` (atomically creates member record) |
| `src/memory/channel-guardian-store.ts` | Persistence for guardian bindings, verification challenges, and approval requests |
| `src/runtime/guardian-outbound-actions.ts` | Shared business logic for outbound verification (start/resend/cancel) |
| `src/runtime/routes/integration-routes.ts` | HTTP route handlers for outbound guardian verification endpoints |

### Chat-Initiated Guardian Verification

Guardian verification can also be initiated through normal desktop chat. When the user asks the assistant to set up guardian verification, the conversational routing layer loads the `guardian-verify-setup` skill, which guides the flow:

1. Confirm which channel to verify (SMS, voice, or Telegram).
2. Collect the destination (phone number or Telegram handle/chat ID).
3. Call the outbound HTTP endpoints to start, resend, or cancel verification.
4. Guide the user through the verification lifecycle conversationally.

**Outbound HTTP Endpoints** (available when the runtime HTTP server is running):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/integrations/guardian/outbound/start` | POST | Start outbound verification. Body: `{ channel, destination?, assistantId?, rebind? }` |
| `/v1/integrations/guardian/outbound/resend` | POST | Resend verification code. Body: `{ channel, assistantId? }` |
| `/v1/integrations/guardian/outbound/cancel` | POST | Cancel active session. Body: `{ channel, assistantId? }` |

These endpoints share the same business logic as the IPC-based verification flow via `guardian-outbound-actions.ts`.

**Security constraint:** Guardian verification control-plane endpoints are restricted to guardian and desktop (trusted) actors only. Non-guardian and unverified-channel actors cannot invoke these endpoints conversationally via tools. Attempts are denied with a message explaining that guardian verification actions are restricted to guardian users.

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

## Ingress Membership + Escalation

Secure cross-user messaging allows external users (non-guardians) to interact with the assistant through channels (Telegram, SMS) under the owner's control. Access is governed by an invite-based membership system with per-member policy enforcement.

### Ingress Membership

External users join through **invite tokens**. There are two invite flows:

1. **IPC-based (legacy)** — The owner creates an invite via IPC, obtains the raw token, and shares it manually. The external user redeems the token by sending it as a channel message.
2. **Guardian-initiated invite links (Telegram)** — The guardian asks the assistant to create an invite link via desktop chat. The assistant creates an invite, builds a channel-specific deep link, and presents it for sharing. The invitee clicks the link and is automatically granted access.

#### Guardian-Initiated Invite Link Flow (Telegram)

1. **Guardian requests invite** — The guardian asks the assistant (via desktop chat) to create a Telegram invite link. The `guardian-invite-intent.ts` module detects the intent and routes the request into the `trusted-contacts` skill.
2. **Invite creation** — The skill creates an invite token via the ingress HTTP API and passes it to the Telegram invite transport adapter, which builds a shareable deep link: `https://t.me/<bot>?start=iv_<token>`.
3. **Guardian shares link** — The guardian copies the deep link and shares it with the invitee through any messaging channel.
4. **Invitee redeems** — The invitee clicks the link, which opens Telegram and sends `/start iv_<token>` to the bot. The inbound message handler extracts the token via the transport adapter, redeems it through the invite redemption service, and auto-creates an active member record.
5. **Access granted** — The invitee receives a welcome message and all subsequent messages pass the ingress ACL.

The `iv_` prefix distinguishes invite tokens from `gv_` (guardian verification) tokens, which use the same Telegram `/start` deep-link mechanism.

#### Invite Redemption Architecture

The invite redemption system uses a three-layer architecture:

- **Core redemption engine** (`invite-redemption-service.ts`) — Channel-agnostic business logic that validates tokens, enforces expiry/use-count/channel-match constraints, handles member reactivation, and returns a discriminated-union `InviteRedemptionOutcome`. Deterministic reply templates (`invite-redemption-templates.ts`) map each outcome to a user-facing message without passing through the LLM.
- **Channel transport adapters** (`channel-invite-transport.ts` + `channel-invite-transports/`) — A registry of per-channel adapters that know how to build shareable deep links (`buildShareableInvite`) and extract inbound tokens (`extractInboundToken`). Currently only the Telegram adapter is implemented.
- **Conversational orchestration** (`guardian-invite-intent.ts`) — Pattern-based intent detection that intercepts guardian invite management requests (create, list, revoke) in the session pipeline and forces immediate entry into the `trusted-contacts` skill, bypassing the normal agent loop.

#### Deferred Channel Support

The transport adapter registry is architecturally extensible to additional channels. The following are not yet implemented:

- **SMS** — Requires a deep-link strategy compatible with SMS (e.g., a short URL that redirects to an SMS reply flow or web-based redemption page). The core redemption engine is channel-agnostic and ready.
- **Slack** — Requires DM-safe ingress (Socket Mode currently handles channel messages but DM-initiated invite flows need additional routing). The adapter would build Slack deep links or slash-command payloads.
- **Voice** — Requires DTMF or speech-based token capture during an inbound call. The adapter would need to integrate with the voice relay state machine for token entry.

Redemption auto-creates a **member** record with an access policy:

- **`allow`** — Messages are processed normally through the agent pipeline.
- **`deny`** — Messages are rejected with a refusal notice.
- **`escalate`** — Messages are held for guardian (owner) approval before processing.

Non-members (senders with no invite redemption) are denied by default. Members can be listed, updated, revoked, or blocked via the `ingress_member` IPC contract.

### Escalation Flow

When a member's policy is `escalate`, inbound messages create a `channel_guardian_approval_request` and the guardian is notified through the canonical notification pipeline (`emitNotificationSignal`). The pipeline routes the escalation alert to all configured channels (Telegram/SMS push, desktop notification).

On **approve**: the original message payload is recovered from the channel delivery store and processed through the agent pipeline. The assistant's reply is delivered back to the external user via the gateway. On **deny**: a refusal message is sent to the external user.

If no guardian binding exists, escalation fails closed — the message is denied rather than left in a silent wait state.

### IPC Contracts

| Message Type | Actions | Description |
|---|---|---|
| `ingress_invite` | create, list, revoke, redeem | Manage invite tokens (SHA-256 hashed, raw token returned once on create) |
| `ingress_member` | list, upsert, revoke, block | Manage member records and access policies |

### Key Modules

| File | Purpose |
|------|---------|
| `src/memory/ingress-invite-store.ts` | CRUD for invite tokens with SHA-256 hashing and expiry |
| `src/memory/ingress-member-store.ts` | CRUD for ingress members with policy enforcement |
| `src/daemon/handlers/config-inbox.ts` | IPC handlers for ingress invite and member contracts |
| `src/daemon/ipc-contract/inbox.ts` | TypeScript type definitions for ingress IPC messages |
| `src/runtime/routes/channel-routes.ts` | ACL enforcement point — member lookup, policy check, escalation creation |
| `src/runtime/invite-redemption-service.ts` | Core redemption engine — token validation, member creation, discriminated-union outcomes |
| `src/runtime/invite-redemption-templates.ts` | Deterministic reply templates for each redemption outcome |
| `src/runtime/channel-invite-transport.ts` | Transport adapter registry — `buildShareableInvite` / `extractInboundToken` per channel |
| `src/runtime/channel-invite-transports/telegram.ts` | Telegram adapter — builds `t.me/<bot>?start=iv_<token>` deep links, extracts `iv_` tokens from `/start` commands |
| `src/daemon/guardian-invite-intent.ts` | Intent detection — routes guardian invite management requests into the `trusted-contacts` skill |
| `src/runtime/ingress-service.ts` | Shared business logic for invite/member operations (HTTP + IPC) |

## Database

SQLite via Drizzle ORM, stored at `~/.vellum/workspace/data/db/assistant.db`. Key tables include conversations, messages, tool invocations, attachments, memory segments (with FTS5), memory items, entities, reminders, and recurrence schedules (cron + RRULE).

> **Compatibility note:** The recurrence schedule system supports both cron expressions and iCalendar RRULE syntax. The legacy field names `cron_expression` and `cronExpression` remain supported in API inputs. New code should use the `expression` field with an explicit `syntax` discriminator. See [`docs/architecture/scheduling.md`](docs/architecture/scheduling.md) for details.

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
