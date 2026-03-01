# Vellum Managed Gateway

Managed gateway service skeleton for Vellum-owned shared channel identities.

## Current scope

- package scaffold and startup entrypoint
- strict startup config validation for enabled managed gateway mode
- health and readiness endpoints:
  - `/healthz`
  - `/readyz`
  - `/v1/internal/managed-gateway/healthz/`
  - `/v1/internal/managed-gateway/readyz/`

## Configuration

- `MANAGED_GATEWAY_ENABLED` (default `true`)
- `MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL` (required when enabled and strict validation is on)
- `MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION` (default `true`)

## Run locally

```bash
cd gateway-managed
bun install
bun run dev
```

## Tests

```bash
cd gateway-managed
bun run test
```
