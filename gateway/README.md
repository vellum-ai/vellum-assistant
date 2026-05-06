# Vellum Gateway

Standalone service that serves as the public ingress boundary for all external webhooks and callbacks. It owns Telegram integration end-to-end, routes Twilio voice webhooks, handles OAuth callbacks, and acts as an authenticated reverse proxy for the assistant runtime.

## Architecture

```
Telegram → gateway/ → Assistant Runtime (/v1/assistants/:id/channels/inbound) → gateway/ → Telegram

Client → gateway/ (Bearer auth) → Assistant Runtime (any path)
```

The web app is **not** in the Telegram request path. All non-Telegram requests that don't match a dedicated gateway route are forwarded to the assistant runtime with bearer token authentication.

For ingress and channel architecture details, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Setup

```bash
cd gateway
bun install
cp .env.example .env
# Edit .env with your configuration
bun run dev
```

## Configuration

| Variable                  | Required | Default | Description                                                                                                                                                                                                                                                                         |
| ------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | No       | —       | Bot token from @BotFather (Telegram disabled when unset). When not set as an env var, the gateway reads from the assistant's secure credential store: CES HTTP API first (when `CES_CREDENTIAL_URL` is configured), then the encrypted file store (`~/.vellum/protected/keys.enc`). |
| `TELEGRAM_WEBHOOK_SECRET` | No       | —       | Secret for verifying webhook requests (Telegram disabled when unset). Same credential reader fallback behavior as `TELEGRAM_BOT_TOKEN`.                                                                                                                                             |
| `GATEWAY_PORT`            | No       | `7830`  | Port for the gateway HTTP server                                                                                                                                                                                                                                                    |

Most gateway behavior is now configured via hardcoded defaults or workspace config (`~/.vellum/workspace/config.json`) rather than environment variables. Channel operational settings (Telegram API base URL, timeouts, deliver auth bypass flags, runtime base URL, routing, proxy settings, attachment limits, shutdown drain) are managed via `workspace/config.json` through `ConfigFileCache`. See the channel-specific sections in `ARCHITECTURE.md` for details.

## Routing

v1 uses deterministic settings-based routing (no database):

1. **conversation_id match** — explicit `conversation:<conversation_id>` entry in routing config
2. **actor_id match** — explicit `actor:<actor_id>` entry in routing config
3. **Unmapped policy** — `reject` (drop with message) or `default` (forward to the configured default assistant)

Routing is configured via workspace config. See `ARCHITECTURE.md` for details.

## Setting up the Telegram webhook

Webhook registration is now handled automatically by the gateway. On startup, the gateway reconciles the Telegram webhook by registering it at `${ingress.publicBaseUrl}/webhooks/telegram` with the configured secret and allowed updates. This also runs whenever the credential watcher detects changes to the bot token or webhook secret (e.g., secret rotation). If the ingress URL changes (e.g., tunnel restart), the config file watcher detects the change and triggers webhook reconciliation directly — no daemon involvement or gateway restart is needed.

For manual setup (or reference), register the webhook with Telegram using the `setWebhook` API method. Pass:

- `url` — your gateway URL, e.g. `https://your-host/webhooks/telegram`
- The verify value matching your `TELEGRAM_WEBHOOK_SECRET` env var
- `allowed_updates` — `["message", "edited_message", "callback_query"]`

See the [Telegram Bot API docs](https://core.telegram.org/bots/api#setwebhook) for the full API reference.

## Telegram Deliver Endpoint Security

The `/deliver/telegram` endpoint requires bearer auth by default (fail-closed). The security behavior is:

| Condition                                                                                 | Result                     |
| ----------------------------------------------------------------------------------------- | -------------------------- |
| Bearer token configured + valid `Authorization` header                                    | Request allowed            |
| Bearer token configured + missing/invalid `Authorization` header                          | 401 Unauthorized           |
| No bearer token configured + `telegram.deliverAuthBypass=true` in `workspace/config.json` | Request allowed (dev-only) |
| No bearer token configured + bypass not set                                               | 503 Service Not Configured |

This ensures that misconfiguration cannot expose an unauthenticated public message-send surface. In production, ensure JWT authentication is properly configured. The `telegram.deliverAuthBypass` config flag (in `workspace/config.json`) is intended for local development only and requires `APP_VERSION=0.0.0-dev`.

## Voice Ingress — Inbound Calls (Twilio)

The `/webhooks/twilio/voice` endpoint handles both outbound and inbound voice calls. For **outbound** calls (initiated by the assistant via `call_start`), the voice webhook URL includes a `callSessionId` query parameter that identifies the pre-created session. For **inbound** calls (someone dialing the assistant's Twilio phone number), no `callSessionId` is present — the gateway resolves the target assistant and the runtime creates a session on the fly.

### Inbound voice routing

When the voice webhook is called without a `callSessionId` query parameter, the gateway treats it as an inbound call and resolves the assistant using the standard routing chain:

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

**Fallback behavior:** For non-rich channels that do not support inline keyboards, the runtime substitutes the `plainTextFallback` string for the structured `promptText` before calling the delivery endpoint. The fallback includes plain-text instructions so the user can respond via text. The `channelSupportsRichApprovalUI()` function in the runtime determines which format to use. Free-text responses are classified by the conversational approval engine.

## Telegram Typing Indicator

The `/deliver/telegram` endpoint also accepts an optional `chatAction` field for ephemeral Telegram chat actions. Current supported value:

- `typing` — triggers Telegram `sendChatAction` with `action: "typing"` for the target `chatId`.

This can be sent as an action-only payload (without `text` or `attachments`) when the runtime wants to show a typing indicator while an assistant response is still in progress.

## Public Ingress Routes

The gateway serves as the single public ingress point for all external callbacks. The following routes are handled directly by the gateway before any proxy forwarding:

| Route                                      | Method          | Description                                                                                                                                   |
| ------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/webhooks/telegram`                       | POST            | Telegram bot webhook (validated via `TELEGRAM_WEBHOOK_SECRET`)                                                                                |
| `/deliver/telegram`                        | POST            | Internal endpoint for the assistant runtime to deliver outbound messages/attachments to Telegram chats                                        |
| `/webhooks/twilio/voice`                   | POST            | Twilio voice webhook (validated via HMAC-SHA1 signature)                                                                                      |
| `/webhooks/twilio/status`                  | POST            | Twilio status callback (validated via HMAC-SHA1 signature)                                                                                    |
| `/webhooks/twilio/connect-action`          | POST            | Twilio connect-action callback (validated via HMAC-SHA1 signature)                                                                            |
| `/webhooks/twilio/relay`                   | WS              | Twilio ConversationRelay WebSocket (bidirectional proxy to runtime, requires `callSessionId` query param)                                     |
| `/webhooks/oauth/callback`                 | GET             | OAuth2 callback endpoint — receives authorization codes from OAuth providers (Google, Slack, etc.) and forwards them to the assistant runtime |
| `/v1/channel-verification-sessions`        | POST            | Authenticated control-plane proxy for creating verification sessions (inbound challenge or outbound verification)                             |
| `/v1/channel-verification-sessions`        | DELETE          | Authenticated control-plane proxy for cancelling active verification sessions                                                                 |
| `/v1/channel-verification-sessions/resend` | POST            | Authenticated control-plane proxy for resending outbound verification code                                                                    |
| `/v1/channel-verification-sessions/status` | GET             | Authenticated control-plane proxy for verification binding status                                                                             |
| `/v1/channel-verification-sessions/revoke` | POST            | Authenticated control-plane proxy for revoking verification binding (cancels sessions and removes binding)                                    |
| `/v1/integrations/telegram/config`         | GET/POST/DELETE | Authenticated control-plane proxy for Telegram integration config                                                                             |
| `/v1/integrations/telegram/commands`       | POST            | Authenticated control-plane proxy for Telegram command registration                                                                           |
| `/v1/integrations/telegram/setup`          | POST            | Authenticated control-plane proxy for Telegram setup orchestration                                                                            |
| `/v1/contacts`                             | GET/POST        | Authenticated control-plane proxy for listing/searching and creating/updating contacts                                                        |
| `/v1/contacts/:id`                         | GET             | Authenticated control-plane proxy for retrieving a contact by ID                                                                              |
| `/v1/contacts/merge`                       | POST            | Authenticated control-plane proxy for merging two contacts                                                                                    |
| `/v1/contact-channels/:contactChannelId`   | PATCH           | Authenticated control-plane proxy for updating a contact channel's status/policy                                                              |
| `/v1/contacts/invites`                     | GET/POST        | Authenticated control-plane proxy for listing/creating contact invites                                                                        |
| `/v1/contacts/invites/:id`                 | DELETE          | Authenticated control-plane proxy for revoking a contact invite                                                                               |
| `/v1/contacts/invites/redeem`              | POST            | Authenticated control-plane proxy for redeeming a contact invite                                                                              |
| `/v1/health`                               | GET             | Authenticated runtime health proxy (`/v1/health` on runtime)                                                                                  |
| `/healthz`                                 | GET             | Liveness probe                                                                                                                                |
| `/readyz`                                  | GET             | Readiness probe                                                                                                                               |
| `/schema`                                  | GET             | Returns the OpenAPI 3.1 schema for this gateway                                                                                               |

### Tunnel Setup

To receive external callbacks during local development, point a tunnel service at the local gateway (default `http://127.0.0.1:7830`) and configure the resulting public URL. Ngrok, Cloudflare Tunnel, and other custom HTTPS/WSS tunnels remain supported.

#### Test Gateway Source Changes Locally (No Release Needed)

Use this flow when you are changing files under `gateway/` and need to validate immediately without publishing `@vellumai/vellum-gateway`.

```bash
# Terminal 1: restart assistant runtime HTTP server
cd assistant
bun run assistant:restart:http

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
3. Set the URL as `ingress.publicBaseUrl` in the Settings UI (Public Ingress section).
4. Use the Settings UI "Local Gateway Target" value as the source of truth for tunnel destination (it reflects `GATEWAY_PORT`).

In local tunnel setups, updating `ingress.publicBaseUrl` in Settings is typically live for Twilio inbound validation (no manual gateway restart required) because the gateway also validates signatures against forwarded public URL headers.

The assistant runtime uses this URL to construct all webhook and OAuth callback URLs automatically.

### Velay for Twilio Testing

Velay is a managed ingress transport for assistant-hosted HTTP and WebSocket traffic. When Velay registration succeeds, the gateway writes the registered public assistant URL to `ingress.publicBaseUrl` and marks it with `ingress.publicBaseUrlManagedBy: "velay"`. Twilio URL builders use that public base URL for voice, status, relay, and media-stream endpoints.

Use Velay when testing Twilio voice webhooks or Twilio WebSocket upgrades through the platform-managed tunnel:

1. In `vellum-assistant-platform`, start the local Velay service:

   ```bash
   vel up velay
   ```

2. Ensure vembda injects the Velay endpoint into assistant gateway containers. For local Docker-hosted assistants, the gateway container must dial the Velay service running on the host:

   ```bash
   VELAY_BASE_URL=http://host.docker.internal:8501
   ```

   Hosted environments should use their environment's deployed Velay URL instead.

3. Re-hatch or restart the assistant so the gateway process receives `VELAY_BASE_URL`.
4. Confirm the gateway logs include `Velay tunnel connected` followed by `Velay tunnel registered`. Registration publishes the returned Velay URL to `ingress.publicBaseUrl`.

For an HTTP bridge smoke test, send a request to the registered Velay public URL and confirm it reaches the loopback gateway, for example:

```bash
curl -i "$VELAY_PUBLIC_BASE_URL/<assistant-id>/healthz"
curl -i "$VELAY_PUBLIC_BASE_URL/<assistant-id>/schema"
```

When testing a JSON webhook route under active development, POST a small JSON body through the same Velay public URL and confirm the gateway logs or handler response show the request reached the loopback listener.

For a synthetic Twilio WebSocket smoke test, connect a local WebSocket client to the Velay public URL using one of the gateway Twilio WebSocket paths, such as:

```bash
bun -e 'const ws = new WebSocket(process.argv[1]); ws.onopen = () => { console.log("open"); ws.close(); }; ws.onerror = (event) => console.error(event);' \
  "wss://<velay-host>/<assistant-id>/webhooks/twilio/relay?callSessionId=session-123&token=<edge-token>"
```

For a real Twilio call, expose local Velay with a public HTTPS/WSS tunnel and configure the platform Velay service with that origin as `VELAY_PUBLIC_BASE_URL`. After the assistant re-registers, Twilio should fetch `/webhooks/twilio/voice` and open `/webhooks/twilio/relay` or `/webhooks/twilio/media-stream/...` through the Velay URL. Use ngrok or another custom tunnel in `ingress.publicBaseUrl` only for local/self-hosted workflows that are not routed through Velay.

## Ingress Boundary Guarantees

The gateway is the **sole public ingress point** for all external webhooks. The assistant runtime never directly accepts public webhook traffic — all Twilio and Telegram webhook routes on the runtime return `410 GATEWAY_ONLY` when accessed directly.

### Signature URL Tightening

When the ingress public base URL is configured (via `ingress.publicBaseUrl` in workspace config, read through `ConfigFileCache`), the gateway prioritizes it as the canonical URL for Twilio signature validation. If the signature only validates against the raw local request URL (fallback), a warning is logged indicating potential drift between the configured ingress URL and the actual webhook registration. The raw URL fallback is preserved for local-dev operability.

## Runtime Proxy

The gateway acts as the single ingress point for all traffic. Dedicated gateway routes (webhooks, control-plane proxies, health checks) are matched first; any request that doesn't match a specific route is forwarded to the assistant runtime via a catch-all proxy.

### Auth behavior

By default, proxied requests must include a valid `Authorization: Bearer <jwt>` header with a JWT signed by the shared signing key. Auth requirement is configured via workspace config.

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
- **Oversized** attachments (exceeding the hardcoded max attachment size, default 20 MB) are skipped and included in the partial-failure notice.
- **Partial failures** are handled gracefully: each attachment is attempted independently. If any fail, a single summary notice is sent to the chat listing the undelivered filenames.
- **Concurrency** is controlled by a hardcoded max concurrency limit (default 3).

Text and attachments are sent separately — the text reply goes first via `sendMessage`, then each attachment follows.

## Health & Readiness Probes

| Endpoint     | Method | Behavior                                                                    |
| ------------ | ------ | --------------------------------------------------------------------------- |
| `/v1/health` | GET    | Authenticated proxy to runtime health (`/v1/health`)                        |
| `/healthz`   | GET    | Always returns `200` while the process is alive                             |
| `/readyz`    | GET    | Returns `200` while accepting traffic; `503` during graceful shutdown drain |

On `SIGTERM` the gateway enters drain mode: `/readyz` begins returning `503` so the load balancer stops sending new traffic. After the hardcoded shutdown drain window (default 5 s) the process exits.

## Docker

```bash
# Build
docker build -t vellum-gateway:local gateway

# Run (pass required env vars)
docker run --rm -p 7830:7830 \
  -e TELEGRAM_BOT_TOKEN=... \
  -e TELEGRAM_WEBHOOK_SECRET=... \
  vellum-gateway:local
```

The image runs as non-root user `gateway` (uid 1001) and exposes port `7830`.

The runtime base URL is derived from `RUNTIME_HTTP_PORT` as `http://localhost:${RUNTIME_HTTP_PORT}` (default port `7821`). The gateway internal base URL is always derived from `GATEWAY_PORT` as `http://127.0.0.1:${GATEWAY_PORT}` (default `7830`). Both hosts are hardcoded to localhost — the gateway and runtime must be co-located (e.g., same host, `--network host`, or Docker Compose with shared networking). Separate-host deployments are not currently supported.

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
| "No route configured" replies  | Add a routing entry or configure the unmapped policy to `default` with a default assistant via workspace config                                                                |
| Runtime errors                 | Is the assistant runtime reachable? Check runtime logs.                                                                                                                        |
| No reply from assistant        | Is the assistant runtime processing messages? Check that the runtime HTTP server is running.                                                                                   |
| 403 on channel inbound         | The runtime rejected the request because JWT authentication failed. Ensure the gateway and runtime share the same signing key (`~/.vellum/protected/actor-token-signing-key`). |

### Guardian-Specific Troubleshooting

| Symptom                                                        | Cause                                                                                                                                              | Resolution                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guardian verification code reply gets no response              | The verification message did not reach the runtime, or the challenge expired                                                                       | Ensure the gateway is running, the bot token is valid, and the Telegram webhook is registered. Challenges expire after 10 minutes -- generate a new one via the desktop UI.                                                           |
| Non-guardian actions auto-denied with "no guardian configured" | No guardian binding exists for the channel. The runtime is fail-closed for unverified channels.                                                    | Set up a guardian by running the verification flow from the desktop UI.                                                                                                                                                               |
| Approval prompt not delivered to guardian                      | The `replyCallbackUrl` may be unreachable, or the guardian's chat ID is stale                                                                      | Verify `GATEWAY_PORT` is correct and the gateway is reachable at `http://127.0.0.1:<GATEWAY_PORT>` from the runtime (requires co-located networking in containerized deployments). Re-verify the guardian if the chat ID has changed. |
| Guardian approval expired                                      | The 30-minute TTL elapsed without a decision. A proactive sweep (every 60s) auto-denied the approval and notified both the requester and guardian. | The non-guardian user must re-trigger the action.                                                                                                                                                                                     |
| "Only the verified guardian can approve or deny"               | A non-guardian sender attempted to respond to a guardian approval prompt                                                                           | Only the guardian whose `actorExternalId` matches the approval request can approve or deny.                                                                                                                                           |
