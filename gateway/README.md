# Vellum Gateway

Standalone service that serves as the public ingress boundary for all external webhooks and callbacks. It owns Telegram integration end-to-end, routes Twilio voice webhooks, handles OAuth callbacks, and optionally acts as an authenticated reverse proxy for the assistant runtime.

## Architecture

```
Telegram → gateway/ → Assistant Runtime (/v1/assistants/:id/channels/inbound) → gateway/ → Telegram

Client → gateway/ (Bearer auth) → Assistant Runtime (any path)
```

The web app is **not** in the Telegram request path. When proxy mode is enabled, non-Telegram requests are forwarded to the assistant runtime with optional bearer token authentication.

## Setup

```bash
cd gateway
bun install
cp .env.example .env
# Edit .env with your configuration
bun run dev
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | No | — | Bot token from @BotFather (Telegram disabled when unset). When not set as an env var, the gateway reads from the assistant's secure credential store via the credential reader fallback chain: macOS Keychain first (via `security` CLI), then encrypted file store (`~/.vellum/protected/keys.enc`). The keychain reader discriminates exit code 44 (`errSecItemNotFound` — credential genuinely missing) from other non-zero exit codes (transient errors), logging the latter as warnings. On non-macOS platforms, only the encrypted store is used. |
| `TELEGRAM_WEBHOOK_SECRET` | No | — | Secret for verifying webhook requests (Telegram disabled when unset). Same credential reader fallback behavior as `TELEGRAM_BOT_TOKEN`. |
| `TELEGRAM_API_BASE_URL` | No | `https://api.telegram.org` | Override Telegram API base URL |
| `ASSISTANT_RUNTIME_BASE_URL` | Yes | — | Base URL of the assistant runtime HTTP server |
| `GATEWAY_ASSISTANT_ROUTING_JSON` | No | `{}` | JSON mapping of Telegram identities to assistant IDs |
| `GATEWAY_DEFAULT_ASSISTANT_ID` | No | — | Default assistant ID for unmapped users |
| `GATEWAY_UNMAPPED_POLICY` | No | `reject` | Policy for unmapped users: `reject` or `default` |
| `GATEWAY_PORT` | No | `7830` | Port for the gateway HTTP server |
| `GATEWAY_INTERNAL_BASE_URL` | No | `http://127.0.0.1:${GATEWAY_PORT}` | Base URL for runtime→gateway callbacks (e.g., the `replyCallbackUrl` sent to the assistant runtime for Telegram reply delivery). Defaults to `http://127.0.0.1:${GATEWAY_PORT}`. Override when the gateway and runtime are not co-located (e.g., separate containers, hosts, or behind a service mesh). |
| `INGRESS_PUBLIC_BASE_URL` | No | — | Public URL where the gateway is reachable (e.g. `https://abc123.ngrok-free.app`). Used by the assistant runtime to construct webhook and OAuth callback URLs. Set this to your tunnel's public URL. |
| `GATEWAY_RUNTIME_PROXY_ENABLED` | No | `false` | Enable runtime proxy for non-Telegram requests |
| `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH` | No | `true` | Require bearer auth for proxied requests |
| `RUNTIME_BEARER_TOKEN` | No | `~/.vellum/http-token` (if present) | Bearer token used by gateway when forwarding requests to assistant runtime internal endpoints (Twilio/OAuth/proxy upstream). |
| `RUNTIME_PROXY_BEARER_TOKEN` | Conditional | — | Bearer token for proxy auth (required when proxy + auth enabled) |
| `GATEWAY_SHUTDOWN_DRAIN_MS` | No | `5000` | Graceful shutdown drain window in milliseconds |
| `GATEWAY_RUNTIME_TIMEOUT_MS` | No | `30000` | Timeout for runtime HTTP calls (ms) |
| `GATEWAY_RUNTIME_MAX_RETRIES` | No | `2` | Max retries for runtime forward on 5xx/network errors |
| `GATEWAY_RUNTIME_INITIAL_BACKOFF_MS` | No | `500` | Initial backoff between retries (doubles each attempt) |
| `GATEWAY_TELEGRAM_TIMEOUT_MS` | No | `15000` | Timeout for Telegram API/download calls (ms) |
| `GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES` | No | `1048576` | Max inbound webhook payload size (rejects with 413) |
| `GATEWAY_MAX_ATTACHMENT_BYTES` | No | `20971520` | Max single attachment size (oversized are skipped) |
| `GATEWAY_MAX_ATTACHMENT_CONCURRENCY` | No | `3` | Max concurrent attachment download/upload operations |
| `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS` | No | `false` | Dev-only: skip bearer auth on `/deliver/telegram` when no token is configured |

## Routing

v1 uses deterministic settings-based routing (no database):

1. **chat_id match** — explicit `chat:<chat_id>` entry in routing JSON
2. **user_id match** — explicit `user:<user_id>` entry in routing JSON
3. **Unmapped policy** — `reject` (drop with message) or `default` (forward to `GATEWAY_DEFAULT_ASSISTANT_ID`)

### Routing JSON format

```json
{
  "chat:12345": "assistant-id-a",
  "user:67890": "assistant-id-b"
}
```

## Setting up the Telegram webhook

Webhook registration is now handled automatically by the gateway. On startup, the gateway reconciles the Telegram webhook by registering it at `${INGRESS_PUBLIC_BASE_URL}/webhooks/telegram` with the configured secret and allowed updates. This also runs whenever the credential watcher detects changes to the bot token or webhook secret (e.g., secret rotation). If the ingress URL changes (e.g., tunnel restart), the assistant daemon triggers an immediate internal reconcile so the webhook re-registers automatically without a gateway restart.

For manual setup (or reference), register the webhook with Telegram using the `setWebhook` API method. Pass:
- `url` — your gateway URL, e.g. `https://your-host/webhooks/telegram`
- The verify value matching your `TELEGRAM_WEBHOOK_SECRET` env var
- `allowed_updates` — `["message", "edited_message", "callback_query"]`

See the [Telegram Bot API docs](https://core.telegram.org/bots/api#setwebhook) for the full API reference.

## Telegram Deliver Endpoint Security

The `/deliver/telegram` endpoint requires bearer auth by default (fail-closed). The security behavior is:

| Condition | Result |
|-----------|--------|
| Bearer token configured + valid `Authorization` header | Request allowed |
| Bearer token configured + missing/invalid `Authorization` header | 401 Unauthorized |
| No bearer token configured + `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS=true` | Request allowed (dev-only) |
| No bearer token configured + bypass not set | 503 Service Not Configured |

This ensures that misconfiguration cannot expose an unauthenticated public message-send surface. In production, always configure `RUNTIME_PROXY_BEARER_TOKEN`. The `GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS` flag is intended for local development only.

## Callback Query Handling

The gateway normalizes Telegram `callback_query` updates (inline button clicks) into the same `GatewayInboundEventV1` format used for regular messages. When a `callback_query` is present in the webhook payload, the normalizer extracts:

- `callbackQueryId` — the Telegram callback query ID
- `callbackData` — the opaque data string attached to the button (e.g., `apr:<runId>:<action>`)
- `content` — set to the callback data string (so the runtime always has content to process)

These fields are forwarded to the runtime in the `/channels/inbound` payload alongside the standard `externalChatId`, `externalMessageId`, and sender metadata. The runtime uses `callbackData` to route the click to the appropriate approval handler.

## Approval Buttons and Inline Keyboard

The `/deliver/telegram` endpoint accepts an optional `approval` field in the request body. When present, the gateway renders Telegram inline keyboard buttons below the message text.

**Approval payload shape:**

```json
{
  "chatId": "123456",
  "text": "The assistant wants to use the tool \"bash\". Do you want to allow this?",
  "approval": {
    "runId": "run-uuid",
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

**Inline keyboard format:** Each action is rendered as a single-button row. The callback data uses the compact format `apr:<runId>:<action>` (e.g., `apr:run-uuid:approve_once`) so the runtime can parse it back when the button is clicked.

**Fallback behavior:** For non-Telegram channels that do not support inline keyboards, the `plainTextFallback` string is included in the prompt text, providing plain-text instructions for the user to type their decision.

## Public Ingress Routes

The gateway serves as the single public ingress point for all external callbacks. The following routes are handled directly by the gateway before any proxy forwarding:

| Route | Method | Description |
|-------|--------|-------------|
| `/webhooks/telegram` | POST | Telegram bot webhook (validated via `TELEGRAM_WEBHOOK_SECRET`) |
| `/deliver/telegram` | POST | Internal endpoint for the assistant runtime to deliver outbound messages/attachments to Telegram chats |
| `/webhooks/twilio/voice` | POST | Twilio voice webhook (validated via HMAC-SHA1 signature) |
| `/webhooks/twilio/status` | POST | Twilio status callback (validated via HMAC-SHA1 signature) |
| `/webhooks/twilio/connect-action` | POST | Twilio connect-action callback (validated via HMAC-SHA1 signature) |
| `/webhooks/twilio/relay` | WS | Twilio ConversationRelay WebSocket (bidirectional proxy to runtime, requires `callSessionId` query param) |
| `/webhooks/oauth/callback` | GET | OAuth2 callback endpoint — receives authorization codes from OAuth providers (Google, Slack, etc.) and forwards them to the assistant runtime |
| `/healthz` | GET | Liveness probe |
| `/readyz` | GET | Readiness probe |
| `/schema` | GET | Returns the OpenAPI 3.1 schema for this gateway |

#### Backward-Compatibility Paths

The following legacy paths are aliases that map to their canonical equivalents above:

| Legacy Path | Canonical Path |
|-------------|---------------|
| `/v1/calls/twilio/voice-webhook` | `/webhooks/twilio/voice` |
| `/v1/calls/twilio/status` | `/webhooks/twilio/status` |
| `/v1/calls/twilio/connect-action` | `/webhooks/twilio/connect-action` |
| `/v1/calls/relay` | `/webhooks/twilio/relay` |

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

## Default Mode: Telegram-Only

By default the gateway only serves the Telegram webhook endpoint (`/webhooks/telegram`). All other HTTP requests return `404`. The runtime proxy is **opt-in** — set `GATEWAY_RUNTIME_PROXY_ENABLED=true` to enable it. This behavior is enforced by automated tests.

## Runtime Proxy Mode

When `GATEWAY_RUNTIME_PROXY_ENABLED=true`, the gateway forwards all non-Telegram HTTP requests to the assistant runtime at `ASSISTANT_RUNTIME_BASE_URL`. This allows the gateway to serve as a single ingress point for both Telegram and API traffic.

### Auth behavior

By default (`GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=true`), proxied requests must include a valid `Authorization: Bearer <token>` header matching `RUNTIME_PROXY_BEARER_TOKEN`. Set `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH=false` to disable auth.

`OPTIONS` requests are always allowed without auth (CORS preflight). Telegram webhook requests use their own secret-based verification and are not affected by proxy auth.

### Examples

```bash
# Unauthorized (expect 401 when auth required)
curl -i http://localhost:7830/v1/assistants/test/health

# Authorized (expect 200)
curl -i \
  -H "Authorization: Bearer $RUNTIME_PROXY_BEARER_TOKEN" \
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

| Endpoint | Method | Behavior |
|----------|--------|----------|
| `/healthz` | GET | Always returns `200` while the process is alive |
| `/readyz` | GET | Returns `200` while accepting traffic; `503` during graceful shutdown drain |

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

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci-gateway.yml` | PR (`gateway/**`) | Typecheck + tests |
| `ci-gateway-image.yml` | PR (`gateway/**`) | Build Docker image + smoke check |
| `cd-gateway-image.yml` | Push to `main` (`gateway/**`) | Build + push image to GCR |

The CD workflow requires these GitHub repository variables:
- `GCP_WORKLOAD_IDENTITY_PROVIDER` — OIDC provider for keyless auth
- `GCP_SERVICE_ACCOUNT` — Service account with push permissions
- `GCP_PROJECT_ID` — GCP project ID
- `GATEWAY_IMAGE_NAME` — Image name (e.g. `vellum-gateway`)
- `GCP_REGISTRY_HOST` — Registry host (e.g. `gcr.io`)

## Load Testing

See [`benchmarking/gateway/README.md`](../benchmarking/gateway/README.md) for load-test scripts and throughput targets.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Telegram messages not arriving | Is the webhook registered? `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` |
| 401 on webhook | Does `TELEGRAM_WEBHOOK_SECRET` match the `secret_token` in setWebhook? |
| "No route configured" replies | Add a routing entry or set `GATEWAY_UNMAPPED_POLICY=default` with a default assistant |
| Runtime errors | Is `ASSISTANT_RUNTIME_BASE_URL` reachable? Check runtime logs. |
| No reply from assistant | Is the assistant runtime processing messages? Check for `RUNTIME_HTTP_PORT` env var. |
