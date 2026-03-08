# Vellum Gateway

Standalone service that serves as the public ingress boundary for all external webhooks and callbacks. It owns Telegram integration end-to-end, routes Twilio voice and SMS webhooks, handles OAuth callbacks, and optionally acts as an authenticated reverse proxy for the assistant runtime.

## Architecture

```
Telegram → gateway/ → Assistant Runtime (/v1/assistants/:id/channels/inbound) → gateway/ → Telegram

Client → gateway/ (Bearer auth) → Assistant Runtime (any path)
```

The web app is **not** in the Telegram request path. When proxy mode is enabled, non-Telegram requests are forwarded to the assistant runtime with optional bearer token authentication.

For ingress and channel architecture details, see [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`docs/sms-twilio-parity-checklist.md`](docs/sms-twilio-parity-checklist.md).

## Setup

```bash
cd gateway
bun install
cp .env.example .env
# Edit .env with your configuration
bun run dev
```

## Configuration

| Variable                               | Required | Default                            | Description                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                   | No       | —                                  | Bot token from @BotFather (Telegram disabled when unset). When not set as an env var, the gateway reads from the assistant's secure credential store: keychain broker first (UDS to the assistant daemon), then the encrypted file store (`~/.vellum/protected/keys.enc`). When the broker is unavailable (daemon not running or non-macOS), the encrypted store is used directly. |
| `TELEGRAM_WEBHOOK_SECRET`              | No       | —                                  | Secret for verifying webhook requests (Telegram disabled when unset). Same credential reader fallback behavior as `TELEGRAM_BOT_TOKEN`.                                                                                                                                                                                                                                            |
| `TELEGRAM_API_BASE_URL`                | No       | `https://api.telegram.org`         | Override Telegram API base URL                                                                                                                                                                                                                                                                                                                                                     |
| `ASSISTANT_RUNTIME_BASE_URL`           | Yes      | —                                  | Base URL of the assistant runtime HTTP server                                                                                                                                                                                                                                                                                                                                      |
| `GATEWAY_ASSISTANT_ROUTING_JSON`       | No       | `{}`                               | JSON mapping of Telegram identities to assistant IDs                                                                                                                                                                                                                                                                                                                               |
| `GATEWAY_DEFAULT_ASSISTANT_ID`         | No       | —                                  | Default assistant ID for unmapped users                                                                                                                                                                                                                                                                                                                                            |
| `GATEWAY_UNMAPPED_POLICY`              | No       | `reject`                           | Policy for unmapped users: `reject` or `default`                                                                                                                                                                                                                                                                                                                                   |
| `GATEWAY_PORT`                         | No       | `7830`                             | Port for the gateway HTTP server                                                                                                                                                                                                                                                                                                                                                   |
| `GATEWAY_INTERNAL_BASE_URL`            | No       | `http://127.0.0.1:${GATEWAY_PORT}` | Base URL for runtime→gateway callbacks (e.g., the `replyCallbackUrl` sent to the assistant runtime for Telegram reply delivery). Defaults to `http://127.0.0.1:${GATEWAY_PORT}`. Override when the gateway and runtime are not co-located (e.g., separate containers, hosts, or behind a service mesh).                                                                            |
| `INGRESS_PUBLIC_BASE_URL`              | No       | —                                  | Public URL where the gateway is reachable (e.g. `https://abc123.ngrok-free.app`). Used by the assistant runtime to construct webhook and OAuth callback URLs. Set this to your tunnel's public URL.                                                                                                                                                                                |
| `GATEWAY_RUNTIME_PROXY_ENABLED`        | No       | `false`                            | Enable runtime proxy for non-Telegram requests                                                                                                                                                                                                                                                                                                                                     |
| `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH`   | No       | `true`                             | Require bearer auth for proxied requests                                                                                                                                                                                                                                                                                                                                           |
| `RUNTIME_BEARER_TOKEN`                 | No       | —                                  | Bearer token (JWT) used by gateway when forwarding requests to assistant runtime internal endpoints (Twilio/OAuth/proxy upstream).                                                                                                                                                                                                                                                 |
| `GATEWAY_SHUTDOWN_DRAIN_MS`            | No       | `5000`                             | Graceful shutdown drain window in milliseconds                                                                                                                                                                                                                                                                                                                                     |
| `GATEWAY_RUNTIME_TIMEOUT_MS`           | No       | `30000`                            | Timeout for runtime HTTP calls (ms)                                                                                                                                                                                                                                                                                                                                                |
| `GATEWAY_RUNTIME_MAX_RETRIES`          | No       | `2`                                | Max retries for runtime forward on 5xx/network errors                                                                                                                                                                                                                                                                                                                              |
| `GATEWAY_RUNTIME_INITIAL_BACKOFF_MS`   | No       | `500`                              | Initial backoff between retries (doubles each attempt)                                                                                                                                                                                                                                                                                                                             |
| `GATEWAY_TELEGRAM_TIMEOUT_MS`          | No       | `15000`                            | Timeout for Telegram API/download calls (ms)                                                                                                                                                                                                                                                                                                                                       |
| `GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES`    | No       | `1048576`                          | Max inbound webhook payload size (rejects with 413)                                                                                                                                                                                                                                                                                                                                |
| `GATEWAY_MAX_ATTACHMENT_BYTES`         | No       | `20971520`                         | Max single attachment size (oversized are skipped)                                                                                                                                                                                                                                                                                                                                 |
| `GATEWAY_MAX_ATTACHMENT_CONCURRENCY`   | No       | `3`                                | Max concurrent attachment download/upload operations                                                                                                                                                                                                                                                                                                                               |
| `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS` | No       | `false`                            | Dev-only: skip bearer auth on `/deliver/telegram` when no token is configured                                                                                                                                                                                                                                                                                                      |
| `TWILIO_ACCOUNT_SID`                   | No       | —                                  | Twilio Account SID for sending outbound SMS via the Messages API                                                                                                                                                                                                                                                                                                                   |
| `TWILIO_AUTH_TOKEN`                    | No       | —                                  | Twilio Auth Token for HMAC-SHA1 webhook signature validation and outbound SMS                                                                                                                                                                                                                                                                                                      |
| `TWILIO_PHONE_NUMBER`                  | No       | —                                  | Twilio phone number (E.164) used as the `From` for outbound SMS                                                                                                                                                                                                                                                                                                                    |
| `GATEWAY_SMS_DELIVER_AUTH_BYPASS`      | No       | `false`                            | Dev-only: skip bearer auth on `/deliver/sms` when no token is configured                                                                                                                                                                                                                                                                                                           |

## Routing

v1 uses deterministic settings-based routing (no database):

1. **phone_number match** (SMS only) — reverse lookup of the inbound `To` number against `assistantPhoneNumbers` (a `Record<string, string>` mapping assistant IDs to E.164 phone numbers, propagated from the assistant config file). This allows each assistant to have its own dedicated phone number, and inbound SMS is routed to the correct assistant based on which number received the message.
2. **conversation_id match** — explicit `conversation:<conversation_id>` entry in routing JSON
3. **actor_id match** — explicit `actor:<actor_id>` entry in routing JSON
4. **Unmapped policy** — `reject` (drop with message) or `default` (forward to `GATEWAY_DEFAULT_ASSISTANT_ID`)

### Routing JSON format

```json
{
  "conversation:12345": "assistant-id-a",
  "actor:67890": "assistant-id-b"
}
```

## Setting up the Telegram webhook

Webhook registration is now handled automatically by the gateway. On startup, the gateway reconciles the Telegram webhook by registering it at `${INGRESS_PUBLIC_BASE_URL}/webhooks/telegram` with the configured secret and allowed updates. This also runs whenever the credential watcher detects changes to the bot token or webhook secret (e.g., secret rotation). If the ingress URL changes (e.g., tunnel restart), the config file watcher detects the change and triggers webhook reconciliation directly — no daemon involvement or gateway restart is needed.

For manual setup (or reference), register the webhook with Telegram using the `setWebhook` API method. Pass:

- `url` — your gateway URL, e.g. `https://your-host/webhooks/telegram`
- The verify value matching your `TELEGRAM_WEBHOOK_SECRET` env var
- `allowed_updates` — `["message", "edited_message", "callback_query"]`

See the [Telegram Bot API docs](https://core.telegram.org/bots/api#setwebhook) for the full API reference.

## Telegram Deliver Endpoint Security

The `/deliver/telegram` endpoint requires bearer auth by default (fail-closed). The security behavior is:

| Condition                                                                | Result                     |
| ------------------------------------------------------------------------ | -------------------------- |
| Bearer token configured + valid `Authorization` header                   | Request allowed            |
| Bearer token configured + missing/invalid `Authorization` header         | 401 Unauthorized           |
| No bearer token configured + `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS=true` | Request allowed (dev-only) |
| No bearer token configured + bypass not set                              | 503 Service Not Configured |

This ensures that misconfiguration cannot expose an unauthenticated public message-send surface. In production, ensure JWT authentication is properly configured. The `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS` flag is intended for local development only.

## Voice Ingress — Inbound Calls (Twilio)

The `/webhooks/twilio/voice` endpoint handles both outbound and inbound voice calls. For **outbound** calls (initiated by the assistant via `call_start`), the voice webhook URL includes a `callSessionId` query parameter that identifies the pre-created session. For **inbound** calls (someone dialing the assistant's Twilio phone number), no `callSessionId` is present — the gateway resolves the target assistant and the runtime creates a session on the fly.

### Inbound voice routing

When the voice webhook is called without a `callSessionId` query parameter, the gateway treats it as an inbound call and resolves the assistant using the same routing chain as SMS:

1. **`resolveAssistantByPhoneNumber(config, To)`** — Reverse lookup of the inbound `To` number against `assistantPhoneNumbers`. If the dialed number matches an assistant's configured phone number, that assistant handles the call.
2. **Fallback to `resolveAssistant(From, From)`** — If no phone number match is found, the standard routing chain is used: `conversation_id` match, `actor_id` match, then the unmapped policy.
3. **TwiML Reject for unmapped** — When the unmapped policy is `reject` (and no route matches), the gateway returns `<Reject reason="rejected"/>` TwiML directly to Twilio. Twilio plays a busy signal and hangs up. The call is never forwarded to the runtime.
4. **Forward with assistantId** — When routing succeeds, the gateway forwards the voice webhook to the runtime at `POST /v1/internal/twilio/voice-webhook` with a JSON body containing `{ params, originalUrl, assistantId }`. The runtime calls `createInboundVoiceSession()` to bootstrap a session keyed by CallSid, then returns TwiML pointing Twilio to the ConversationRelay WebSocket.

### Inbound call lifecycle (gateway perspective)

```
Caller → Twilio → Gateway /webhooks/twilio/voice (no callSessionId)
  → resolveAssistantByPhoneNumber(To) || resolveAssistant(From) || TwiML Reject
  → forward to runtime /v1/internal/twilio/voice-webhook (JSON: { params, originalUrl, assistantId })
  → runtime returns TwiML (ConversationRelay connect)
  → Twilio opens WebSocket → Gateway /webhooks/twilio/relay → Runtime /v1/calls/relay
  → RelayConnection detects inbound (`initiatedFromConversationId == null`), optional guardian verification gate, then receptionist-style LLM greeting
```

## SMS Ingress (Twilio)

The `/webhooks/twilio/sms` endpoint receives inbound SMS messages from Twilio. On each request:

1. **Signature validation** — The `X-Twilio-Signature` header is validated using HMAC-SHA1 with the `TWILIO_AUTH_TOKEN`. When behind a tunnel or reverse proxy, the gateway reconstructs the canonical request URL from the ingress public base URL (read via `ConfigFileCache` from `ingress.publicBaseUrl` in workspace config, falling back to the `INGRESS_PUBLIC_BASE_URL` env var) for validation.
2. **MessageSid dedup** — Each `MessageSid` is tracked in an in-memory dedup cache. Duplicate webhook deliveries (Twilio retries) are silently accepted without re-forwarding.
3. **MMS detection** — The gateway treats a message as MMS when any of the following conditions are met: `NumMedia > 0`, any `MediaUrl<N>` key has a non-empty value, or any `MediaContentType<N>` key has a non-empty value. This catches media attachments even when Twilio omits `NumMedia`. The gateway replies with an unsupported notice ("MMS is not supported yet") and does not forward the payload to the runtime.
4. **`/new` command** — When the message body is exactly `/new` (case-insensitive, trimmed), the gateway resolves routing first. If routing is rejected, the gateway sends a rejection notice SMS to the sender (matching Telegram rejection semantics) and does not forward the message. If routing succeeds, the gateway resets the conversation via the runtime API and sends a confirmation SMS. The message is never forwarded to the runtime.
5. **Normalization** — The form-encoded Twilio payload is normalized into a `GatewayInboundEvent` with `sourceChannel: "sms"`. The sender's phone number (`From`) is used as both `conversationExternalId` and `actorExternalId`.
6. **Routing** — Phone-number-based routing is checked first: the `To` number is looked up in `assistantPhoneNumbers` to find the target assistant. If no match, the standard routing chain (conversation_id -> actor_id -> default/reject) is used.
7. **Forwarding** — The event is forwarded to the runtime via `POST /channels/inbound` with SMS-specific transport hints (`chat-first-medium`, `sms-character-limits`, etc.) and a `replyCallbackUrl` pointing to `/deliver/sms`.

SMS is text-only in v1 — MMS payloads are explicitly rejected with a user-facing notice.

## SMS Deliver Endpoint Security

The `/deliver/sms` endpoint requires the same fail-closed bearer auth as `/deliver/telegram`:

| Condition                                                           | Result                     |
| ------------------------------------------------------------------- | -------------------------- |
| Bearer token configured + valid `Authorization` header              | Request allowed            |
| Bearer token configured + missing/invalid `Authorization` header    | 401 Unauthorized           |
| No bearer token configured + `GATEWAY_SMS_DELIVER_AUTH_BYPASS=true` | Request allowed (dev-only) |
| No bearer token configured + bypass not set                         | 503 Service Not Configured |

The endpoint also requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` to be configured. If any are missing, requests return `503 SMS integration not configured`.

Outbound SMS is sent via the Twilio Messages API using the configured `TWILIO_PHONE_NUMBER` as the `From` number. The request body accepts either `{ to, text }` or `{ chatId, text }` — `chatId` is an alias for `to`, allowing the runtime channel callback (which sends `{ chatId, text }`) to work without translation. When both `to` and `chatId` are provided, `to` takes precedence.

## Callback Query Handling

The gateway normalizes Telegram `callback_query` updates (inline button clicks) into the same `GatewayInboundEvent` format used for regular messages. When a `callback_query` is present in the webhook payload, the normalizer extracts:

- `callbackQueryId` — the Telegram callback query ID
- `callbackData` — the opaque data string attached to the button (e.g., `apr:<requestId>:<action>`)
- `content` — set to the callback data string (so the runtime always has content to process)

These fields are forwarded to the runtime in the `/channels/inbound` payload alongside the standard `conversationExternalId`, `externalMessageId`, and actor metadata. The runtime uses `callbackData` to route the click to the appropriate approval handler.

**Normalization constraints:** Only DM-only (`private` chat type) callback queries are processed. Group and channel callbacks are dropped and acknowledged with `answerCallbackQuery` so the Telegram button spinner clears. Callback queries with no `data` field or no associated `message` are also dropped.

**Stale callback blocking:** When the runtime receives `callbackData` that does not match any pending approval (e.g., a button from an old prompt), it returns `stale_ignored` and does not process the payload as a regular message. This is enforced regardless of whether the callback has non-empty content. The gateway sends a best-effort `answerCallbackQuery` acknowledgment for normalized callback updates (including stale, rejected, and forward-failure paths) so the button spinner clears promptly. Transient forwarding failures may still return `500` so Telegram retries update delivery.

## Approval Buttons and Inline Keyboard

The `/deliver/telegram` endpoint accepts an optional `approval` field in the request body. When present, the gateway renders Telegram inline keyboard buttons below the message text.

**Approval payload shape:**

```json
{
  "chatId": "123456",
  "text": "The assistant wants to use the tool \"bash\". Do you want to allow this?",
  "approval": {
    "requestId": "request-uuid",
    "actions": [
      { "id": "approve_once", "label": "Approve once" },
      { "id": "approve_always", "label": "Approve always" },
      { "id": "reject", "label": "Reject" }
    ],
    "plainTextFallback": "Reply \"yes\" to approve once, \"always\" to approve always, or \"no\" to reject."
  }
}
```

**Inline keyboard format:** Each action is rendered as a single-button row. The callback data uses the compact format `apr:<requestId>:<action>` (e.g., `apr:request-uuid:approve_once`) so the runtime can parse it back when the button is clicked.

**Fallback behavior:** For non-Telegram channels that do not support inline keyboards, the runtime substitutes the `plainTextFallback` string for the structured `promptText` before calling the delivery endpoint. The fallback includes plain-text instructions (e.g., "Reply yes/no/always") so the user can respond via text. The `channelSupportsRichApprovalUI()` function in the runtime determines which format to use; currently only `telegram` is classified as a rich channel.

## Telegram Typing Indicator

The `/deliver/telegram` endpoint also accepts an optional `chatAction` field for ephemeral Telegram chat actions. Current supported value:

- `typing` — triggers Telegram `sendChatAction` with `action: "typing"` for the target `chatId`.

This can be sent as an action-only payload (without `text` or `attachments`) when the runtime wants to show a typing indicator while an assistant response is still in progress.

## Public Ingress Routes

The gateway serves as the single public ingress point for all external callbacks. The following routes are handled directly by the gateway before any proxy forwarding:

| Route                                      | Method          | Description                                                                                                                                                                             |
| ------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/webhooks/telegram`                       | POST            | Telegram bot webhook (validated via `TELEGRAM_WEBHOOK_SECRET`)                                                                                                                          |
| `/deliver/telegram`                        | POST            | Internal endpoint for the assistant runtime to deliver outbound messages/attachments to Telegram chats                                                                                  |
| `/webhooks/twilio/voice`                   | POST            | Twilio voice webhook (validated via HMAC-SHA1 signature)                                                                                                                                |
| `/webhooks/twilio/status`                  | POST            | Twilio status callback (validated via HMAC-SHA1 signature)                                                                                                                              |
| `/webhooks/twilio/connect-action`          | POST            | Twilio connect-action callback (validated via HMAC-SHA1 signature)                                                                                                                      |
| `/webhooks/twilio/relay`                   | WS              | Twilio ConversationRelay WebSocket (bidirectional proxy to runtime, requires `callSessionId` query param)                                                                               |
| `/webhooks/twilio/sms`                     | POST            | Twilio SMS webhook — validates X-Twilio-Signature (HMAC-SHA1), normalizes into `GatewayInboundEvent` with `sourceChannel: "sms"`, deduplicates by `MessageSid`, and forwards to runtime |
| `/deliver/sms`                             | POST            | Internal endpoint for the assistant runtime to deliver outbound SMS messages via the Twilio Messages API                                                                                |
| `/webhooks/oauth/callback`                 | GET             | OAuth2 callback endpoint — receives authorization codes from OAuth providers (Google, Slack, etc.) and forwards them to the assistant runtime                                           |
| `/v1/channel-verification-sessions`        | POST            | Authenticated control-plane proxy for creating verification sessions (inbound challenge or outbound verification)                                                                       |
| `/v1/channel-verification-sessions`        | DELETE          | Authenticated control-plane proxy for cancelling active verification sessions                                                                                                           |
| `/v1/channel-verification-sessions/resend` | POST            | Authenticated control-plane proxy for resending outbound verification code                                                                                                              |
| `/v1/channel-verification-sessions/status` | GET             | Authenticated control-plane proxy for verification binding status                                                                                                                       |
| `/v1/channel-verification-sessions/revoke` | POST            | Authenticated control-plane proxy for revoking verification binding (cancels sessions and removes binding)                                                                              |
| `/v1/integrations/telegram/config`         | GET/POST/DELETE | Authenticated control-plane proxy for Telegram integration config                                                                                                                       |
| `/v1/integrations/telegram/commands`       | POST            | Authenticated control-plane proxy for Telegram command registration                                                                                                                     |
| `/v1/integrations/telegram/setup`          | POST            | Authenticated control-plane proxy for Telegram setup orchestration                                                                                                                      |
| `/v1/contacts`                             | GET/POST        | Authenticated control-plane proxy for listing/searching and creating/updating contacts                                                                                                  |
| `/v1/contacts/:id`                         | GET             | Authenticated control-plane proxy for retrieving a contact by ID                                                                                                                        |
| `/v1/contacts/merge`                       | POST            | Authenticated control-plane proxy for merging two contacts                                                                                                                              |
| `/v1/contact-channels/:contactChannelId`   | PATCH           | Authenticated control-plane proxy for updating a contact channel's status/policy                                                                                                        |
| `/v1/contacts/invites`                     | GET/POST        | Authenticated control-plane proxy for listing/creating contact invites                                                                                                                  |
| `/v1/contacts/invites/:id`                 | DELETE          | Authenticated control-plane proxy for revoking a contact invite                                                                                                                         |
| `/v1/contacts/invites/redeem`              | POST            | Authenticated control-plane proxy for redeeming a contact invite                                                                                                                        |
| `/v1/health`                               | GET             | Authenticated runtime health proxy (`/v1/health` on runtime)                                                                                                                            |
| `/healthz`                                 | GET             | Liveness probe                                                                                                                                                                          |
| `/readyz`                                  | GET             | Readiness probe                                                                                                                                                                         |
| `/schema`                                  | GET             | Returns the OpenAPI 3.1 schema for this gateway                                                                                                                                         |

### Tunnel Setup

To receive external callbacks during local development, point a tunnel service at the local gateway (default `http://127.0.0.1:7830`) and configure the resulting public URL:

#### Test Gateway Source Changes Locally (No Release Needed)

Use this flow when you are changing files under `gateway/` and need to validate immediately without publishing `@vellumai/vellum-gateway`.

```bash
# Terminal 1: restart assistant runtime HTTP server
cd assistant
bun run daemon:restart:http

# Terminal 2: run gateway from local source with runtime proxy enabled
cd gateway
bun run dev:proxy
```

If `7830` is already in use, start the gateway on another port:

```bash
cd gateway
GATEWAY_PORT=7840 bun run dev:proxy
```

Then point your tunnel to that same local target (for example `http://127.0.0.1:7840`).

1. Start your tunnel (e.g. ngrok, Cloudflare Tunnel, or similar) targeting `http://127.0.0.1:7830`
2. Copy the public URL provided by the tunnel service (e.g. `https://abc123.ngrok-free.app`)
3. Set the URL as `ingress.publicBaseUrl` in the Settings UI (Public Ingress section) **or** as the `INGRESS_PUBLIC_BASE_URL` environment variable.
4. Use the Settings UI "Local Gateway Target" value as the source of truth for tunnel destination (it reflects `GATEWAY_PORT`).

In local tunnel setups, updating `ingress.publicBaseUrl` in Settings is typically live for Twilio inbound validation (no manual gateway restart required) because the gateway also validates signatures against forwarded public URL headers.

The assistant runtime uses this URL to construct all webhook and OAuth callback URLs automatically.

## Ingress Boundary Guarantees

The gateway is the **sole public ingress point** for all external webhooks, including SMS. The assistant runtime never directly accepts public webhook traffic — all Twilio and Telegram webhook routes on the runtime return `410 GATEWAY_ONLY` when accessed directly.

### SMS Ingress

Inbound SMS follows the same gateway-only pattern as voice and Telegram:

1. **Twilio → Gateway** (`/webhooks/twilio/sms`) — Gateway validates `X-Twilio-Signature` using HMAC-SHA1 with the configured `TWILIO_AUTH_TOKEN`.
2. **Gateway → Runtime** (`/v1/channels/inbound`) — Gateway forwards the normalized event to the runtime with JWT bearer auth.
3. **Runtime rejects direct SMS webhooks** — Any direct POST to `/webhooks/twilio/sms` or `/v1/calls/twilio/sms` on the runtime returns `410 GATEWAY_ONLY`.

### Signature URL Tightening

When the ingress public base URL is configured (via `ingress.publicBaseUrl` in workspace config or `INGRESS_PUBLIC_BASE_URL` env var, read through `ConfigFileCache`), the gateway prioritizes it as the canonical URL for Twilio signature validation. If the signature only validates against the raw local request URL (fallback), a warning is logged indicating potential drift between the configured ingress URL and the actual webhook registration. The raw URL fallback is preserved for local-dev operability.

## Default Mode: Dedicated Routes Only

By default, the broad runtime proxy is disabled. Dedicated gateway-managed routes (webhooks, delivery endpoints, explicit control-plane proxies such as `/v1/channel-verification-sessions/*`, `/v1/integrations/telegram/*`, `/v1/integrations/slack/*`, and `/v1/contacts/invites/*`, plus the authenticated runtime health route `/v1/health`) remain available, but arbitrary runtime passthrough routes return `404` unless `GATEWAY_RUNTIME_PROXY_ENABLED=true`.

## Runtime Proxy Mode

When `GATEWAY_RUNTIME_PROXY_ENABLED=true`, the gateway forwards all non-Telegram HTTP requests to the assistant runtime at `ASSISTANT_RUNTIME_BASE_URL`. This allows the gateway to serve as a single ingress point for both Telegram and API traffic.

### Auth behavior

By default (`GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=true`), proxied requests must include a valid `Authorization: Bearer <jwt>` header with a JWT signed by the shared signing key. Set `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=false` to disable auth.

`OPTIONS` requests are always allowed without auth (CORS preflight). Telegram webhook requests use their own secret-based verification and are not affected by proxy auth.

### Examples

```bash
# Unauthorized (expect 401 when auth required)
curl -i http://localhost:7830/v1/assistants/test/health

# Authorized with JWT (expect 200)
curl -i \
  -H "Authorization: Bearer <jwt>" \
  http://localhost:7830/v1/assistants/test/health

# Telegram still uses webhook secret flow, not bearer auth
curl -i -X POST http://localhost:7830/webhooks/telegram
```

### Proxy details

- Method, path, query string, headers, and body are forwarded to upstream.
- Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, etc.) are stripped from both request and response.
- The `host` header is not forwarded to upstream.
- Upstream connection failures return `502 Bad Gateway`.

## Outbound Attachments (Telegram)

When the assistant includes attachments in a reply, the gateway downloads each attachment from the runtime API and delivers it to the Telegram chat:

- **Images** (`image/*` MIME types) are sent via `sendPhoto` (multipart form upload).
- **Other files** are sent via `sendDocument` (multipart form upload).
- **Oversized** attachments (exceeding `GATEWAY_MAX_ATTACHMENT_BYTES`, default 20 MB) are skipped and included in the partial-failure notice.
- **Partial failures** are handled gracefully: each attachment is attempted independently. If any fail, a single summary notice is sent to the chat listing the undelivered filenames.
- **Concurrency** is controlled by `GATEWAY_MAX_ATTACHMENT_CONCURRENCY` (default 3).

Text and attachments are sent separately — the text reply goes first via `sendMessage`, then each attachment follows.

## Health & Readiness Probes

| Endpoint     | Method | Behavior                                                                    |
| ------------ | ------ | --------------------------------------------------------------------------- |
| `/v1/health` | GET    | Authenticated proxy to runtime health (`/v1/health`)                        |
| `/healthz`   | GET    | Always returns `200` while the process is alive                             |
| `/readyz`    | GET    | Returns `200` while accepting traffic; `503` during graceful shutdown drain |

On `SIGTERM` the gateway enters drain mode: `/readyz` begins returning `503` so the load balancer stops sending new traffic. After `GATEWAY_SHUTDOWN_DRAIN_MS` (default 5 s) the process exits.

## Docker

```bash
# Build
docker build -t vellum-gateway:local gateway

# Run (pass required env vars)
docker run --rm -p 7830:7830 \
  -e TELEGRAM_BOT_TOKEN=... \
  -e TELEGRAM_WEBHOOK_SECRET=... \
  -e ASSISTANT_RUNTIME_BASE_URL=http://host.docker.internal:7821 \
  vellum-gateway:local
```

The image runs as non-root user `gateway` (uid 1001) and exposes port `7830`.

When the runtime and gateway run in separate containers or hosts, set `GATEWAY_INTERNAL_BASE_URL` so the runtime can reach the gateway for callbacks (e.g., Telegram reply delivery). By default it points to `http://127.0.0.1:${GATEWAY_PORT}`, which only works when both services share the same host.

## Development

```bash
cd gateway
bun install
bun run typecheck   # TypeScript type check (tsc --noEmit)
bun run test        # Run test suite
```

Both checks run in CI on every pull request touching `gateway/`.

## CI/CD

| Workflow               | Trigger                       | What it does                     |
| ---------------------- | ----------------------------- | -------------------------------- |
| `ci-gateway.yml`       | PR (`gateway/**`)             | Typecheck + tests                |
| `ci-gateway-image.yml` | PR (`gateway/**`)             | Build Docker image + smoke check |
| `cd-gateway-image.yml` | Push to `main` (`gateway/**`) | Build + push image to GCR        |

The CD workflow requires these GitHub repository variables:

- `GCP_WORKLOAD_IDENTITY_PROVIDER` — OIDC provider for keyless auth
- `GCP_SERVICE_ACCOUNT` — Service account with push permissions
- `GCP_PROJECT_ID` — GCP project ID
- `GATEWAY_IMAGE_NAME` — Image name (e.g. `vellum-gateway`)
- `GCP_REGISTRY_HOST` — Registry host (e.g. `gcr.io`)

## Load Testing

See [`benchmarking/gateway/README.md`](../benchmarking/gateway/README.md) for load-test scripts and throughput targets.

## Troubleshooting

| Symptom                        | Check                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telegram messages not arriving | Is the webhook registered? `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`                                                                                           |
| 401 on webhook                 | Does `TELEGRAM_WEBHOOK_SECRET` match the `secret_token` in setWebhook?                                                                                                         |
| "No route configured" replies  | Add a routing entry or set `GATEWAY_UNMAPPED_POLICY=default` with a default assistant                                                                                          |
| Runtime errors                 | Is `ASSISTANT_RUNTIME_BASE_URL` reachable? Check runtime logs.                                                                                                                 |
| No reply from assistant        | Is the assistant runtime processing messages? Check for `RUNTIME_HTTP_PORT` env var.                                                                                           |
| 403 on channel inbound         | The runtime rejected the request because JWT authentication failed. Ensure the gateway and runtime share the same signing key (`~/.vellum/protected/actor-token-signing-key`). |

### Guardian-Specific Troubleshooting

| Symptom                                                        | Cause                                                                                                                                              | Resolution                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guardian verification code reply gets no response              | The verification message did not reach the runtime, or the challenge expired                                                                       | Ensure the gateway is running, the bot token is valid, and the Telegram webhook is registered. Challenges expire after 10 minutes -- generate a new one via the desktop UI. |
| Non-guardian actions auto-denied with "no guardian configured" | No guardian binding exists for the channel. The runtime is fail-closed for unverified channels.                                                    | Set up a guardian by running the verification flow from the desktop UI.                                                                                                     |
| Approval prompt not delivered to guardian                      | The `replyCallbackUrl` may be unreachable, or the guardian's chat ID is stale                                                                      | Verify `GATEWAY_INTERNAL_BASE_URL` is set correctly (especially in containerized deployments). Re-verify the guardian if the chat ID has changed.                           |
| Guardian approval expired                                      | The 30-minute TTL elapsed without a decision. A proactive sweep (every 60s) auto-denied the approval and notified both the requester and guardian. | The non-guardian user must re-trigger the action.                                                                                                                           |
| "Only the verified guardian can approve or deny"               | A non-guardian sender attempted to respond to a guardian approval prompt                                                                           | Only the guardian whose `actorExternalId` matches the approval request can approve or deny.                                                                                 |
