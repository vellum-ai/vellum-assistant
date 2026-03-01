# Vellum Managed Gateway

Managed gateway service skeleton for Vellum-owned shared channel identities.

## Current scope

- package scaffold and startup entrypoint
- health and readiness endpoints:
  - `/healthz`
  - `/readyz`
  - `/v1/internal/managed-gateway/healthz/`
  - `/v1/internal/managed-gateway/readyz/`

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
