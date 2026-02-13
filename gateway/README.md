# Vellum Gateway

Standalone service that owns Telegram integration end-to-end and optionally acts as an authenticated reverse proxy for the assistant runtime.

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
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | — | Secret for verifying webhook requests |
| `TELEGRAM_API_BASE_URL` | No | `https://api.telegram.org` | Override Telegram API base URL |
| `ASSISTANT_RUNTIME_BASE_URL` | Yes | — | Base URL of the assistant runtime HTTP server |
| `GATEWAY_ASSISTANT_ROUTING_JSON` | No | `{}` | JSON mapping of Telegram identities to assistant IDs |
| `GATEWAY_DEFAULT_ASSISTANT_ID` | No | — | Default assistant ID for unmapped users |
| `GATEWAY_UNMAPPED_POLICY` | No | `reject` | Policy for unmapped users: `reject` or `default` |
| `GATEWAY_PORT` | No | `7830` | Port for the gateway HTTP server |
| `GATEWAY_RUNTIME_PROXY_ENABLED` | No | `false` | Enable runtime proxy for non-Telegram requests |
| `GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH` | No | `true` | Require bearer auth for proxied requests |
| `RUNTIME_PROXY_BEARER_TOKEN` | Conditional | — | Bearer token for proxy auth (required when proxy + auth enabled) |
| `GATEWAY_SHUTDOWN_DRAIN_MS` | No | `5000` | Graceful shutdown drain window in milliseconds |
| `GATEWAY_RUNTIME_TIMEOUT_MS` | No | `30000` | Timeout for runtime HTTP calls (ms) |
| `GATEWAY_RUNTIME_MAX_RETRIES` | No | `2` | Max retries for runtime forward on 5xx/network errors |
| `GATEWAY_RUNTIME_INITIAL_BACKOFF_MS` | No | `500` | Initial backoff between retries (doubles each attempt) |
| `GATEWAY_TELEGRAM_TIMEOUT_MS` | No | `15000` | Timeout for Telegram API/download calls (ms) |
| `GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES` | No | `1048576` | Max inbound webhook payload size (rejects with 413) |
| `GATEWAY_MAX_ATTACHMENT_BYTES` | No | `20971520` | Max single attachment size (oversized are skipped) |
| `GATEWAY_MAX_ATTACHMENT_CONCURRENCY` | No | `3` | Max concurrent attachment download/upload operations |

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

After deploying the gateway, register the webhook with Telegram using the `setWebhook` API method. Pass:
- `url` — your gateway URL, e.g. `https://your-host/webhooks/telegram`
- The verify value matching your `TELEGRAM_WEBHOOK_SECRET` env var
- `allowed_updates` — `["message"]`

See the [Telegram Bot API docs](https://core.telegram.org/bots/api#setwebhook) for the full API reference.

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
