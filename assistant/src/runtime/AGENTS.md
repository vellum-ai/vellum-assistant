# Runtime — Agent Instructions

## HTTP API Patterns

### Sending messages

The single HTTP send endpoint is `POST /v1/messages`. Key behaviors:

- **Queue if busy**: When the session is processing, messages are queued and processed when the current agent turn completes. No 409 rejections.
- **Fire-and-forget**: Returns `202 { accepted: true }` immediately. The client observes progress via SSE (`GET /v1/events`).
- **Hub publishing**: All agent events are published to `assistantEventHub`, making them observable via SSE.

Do NOT add new send endpoints. All message ingress should go through `POST /v1/messages` (HTTP) or `session.processMessage()` (IPC).

### Approvals (confirmations, secrets, trust rules)

Approvals are **orthogonal to message sending**. The assistant asks for approval whenever it needs one — this is a separate concern from how a message enters the system.

- **Discovery**: Clients discover pending approvals via SSE events (`confirmation_request`, `secret_request`) which include a `requestId`.
- **Resolution**: Clients respond via standalone endpoints keyed by `requestId`:
  - `POST /v1/confirm` — `{ requestId, decision: "allow" | "deny" }`
  - `POST /v1/secret` — `{ requestId, value, delivery }`
  - `POST /v1/trust-rules` — `{ requestId, pattern, scope }`
- **Tracking**: The `pending-interactions` tracker (`assistant/src/runtime/pending-interactions.ts`) maps `requestId → session`. Use `register()` to track, `resolve()` to consume, `getByConversation()` to query.

Do NOT couple approval handling to message sending. Do NOT add run/status tracking to the send path.

### Channel approvals (Telegram)

Channel approval flows use `requestId` (not `runId`) as the primary identifier:

- Telegram callback buttons encode `apr:<requestId>:<action>` in `callback_data`.
- Guardian approval records in `channelGuardianApprovalRequests` link via `requestId`.
- The conversational approval engine classifies user intent and resolves via `session.handleConfirmationResponse(requestId, decision)`.

## HTTP-First for New Endpoints

New configuration and control endpoints MUST be exposed over HTTP on the runtime server (`assistant/src/runtime/http-server.ts`), not as IPC-only message types. The runtime HTTP server is the canonical API surface — IPC is a legacy transport being phased out.

Existing IPC-only handlers should be migrated to HTTP when touched. The pattern: extract business logic into a shared function, add an HTTP route handler in `assistant/src/runtime/routes/`, keep the IPC handler as a thin wrapper that calls the same logic.

When writing skills that need to call daemon configuration endpoints, use `curl` with the runtime HTTP API (JWT-authenticated via `Authorization: Bearer <jwt>`) rather than describing IPC socket protocol details. The assistant already knows how to use `curl`.
