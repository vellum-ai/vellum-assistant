# Vellum Managed Gateway

Managed gateway service skeleton for Vellum-owned shared channel identities.

## Current scope

- package scaffold and startup entrypoint
- strict startup config validation for enabled managed gateway mode
- internal auth middleware abstraction for bearer and mTLS service auth
- health and readiness endpoints:
  - `/healthz`
  - `/readyz`
  - `/v1/internal/managed-gateway/healthz/`
  - `/v1/internal/managed-gateway/readyz/`

## Configuration

- `MANAGED_GATEWAY_ENABLED` (default `true`)
- `MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL` (required when enabled and strict validation is on)
- `MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION` (default `true`)
- `MANAGED_GATEWAY_INTERNAL_AUTH_MODE` (`bearer` or `mtls`)
- `MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE` (expected audience for internal callers)
- `MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS` (JSON token catalog)
- `MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS` (comma-separated token IDs)
- `MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS` (comma-separated principal IDs)

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

## Internal Auth Lifecycle

- Issuance: add a new entry to `MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS` with `token_id`, `principal`, `audience`, `scopes`, and optional `expires_at`.
- Rotation: keep old and new bearer entries active during rollout overlap.
- Revocation: set `revoked: true` on a token entry or add its `token_id` to `MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS`.
- Expiry: set `expires_at` as ISO-8601 UTC; expired bearer tokens are rejected.
