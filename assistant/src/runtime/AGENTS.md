# Runtime — Agent Instructions

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:

- **Queue if busy**: When the session is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP).

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision, selectedPattern?, selectedScope? }`. Valid decisions: `"allow"`, `"allow_10m"`, `"allow_thread"`, `"deny"`, `"always_allow"`, `"always_deny"`, `"always_allow_high_risk"`. For persistent decisions (`always_allow`, `always_deny`, `always_allow_high_risk`), `selectedPattern` and `selectedScope` are validated against the server-provided allowlist/scope options from the original confirmation request before trust rules are persisted.
  - `POST /v1/secret` — `{ requestId, value, delivery }`
  - `POST /v1/trust-rules` — `{ requestId, pattern, scope, decision, allowHighRisk? }`. Validates pattern/scope against server-provided options. Does not resolve the confirmation itself.
- **Tracking**: The `pending-interactions` tracker (`assistant/src/runtime/pending-interactions.ts`) maps `requestId → session`. Use `register()` to track, `resolve()` to consume, `getByConversation()` to query.

Do NOT couple approval handling to message sending. Do NOT add run/status tracking to the send path.

### Host bash (desktop proxy execution)

Host bash allows the assistant to execute shell commands on the desktop host machine via the client, rather than in the daemon's own sandbox.

- **Discovery**: Clients discover pending host bash requests via SSE events (`host_bash_request`) which include a `requestId`.
- **Resolution**: Clients execute the command on the host and respond via:
  - `POST /v1/host-bash-result` — `{ requestId, stdout, stderr, exitCode, timedOut }`
- **Tracking**: Uses the same `pending-interactions` tracker as approvals, with `kind: "host_bash"`. The endpoint validates the interaction kind before resolving.

### Host file (desktop proxy file operations)

Host file allows the assistant to perform file operations (read, write, edit) on the desktop host machine via the client, rather than in the daemon's own sandbox.

- **Discovery**: Clients discover pending host file requests via SSE events (`host_file_request`) which include a `requestId`.
- **Resolution**: Clients execute the file operation on the host and respond via:
  - `POST /v1/host-file-result` — `{ requestId, content, isError }`
- **Tracking**: Uses the same `pending-interactions` tracker as approvals and host bash, with `kind: "host_file"`. The endpoint validates the interaction kind before resolving.

### Channel approvals (Telegram, Slack)

Channel approval flows use `requestId` (not `runId`) as the primary identifier:

- Telegram callback buttons encode `apr:<requestId>:<action>` in `callback_data`.
- Guardian approval records in `channelGuardianApprovalRequests` link via `requestId`.
- The conversational approval engine classifies user intent and resolves via `session.handleConfirmationResponse(requestId, decision)`.

## HTTP-Only Transport

HTTP is the sole transport for client-daemon communication. The runtime HTTP server (`assistant/src/runtime/http-server.ts`) is the canonical API surface. Clients connect via HTTP for request/response operations and SSE (`GET /v1/events`) for streaming server-to-client events.

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (JWT-authenticated via `Authorization: Bearer <jwt>`). The assistant already knows how to use `curl`.
