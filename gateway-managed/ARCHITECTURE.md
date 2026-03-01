# Managed Gateway Architecture

The managed gateway is a dedicated service lane for Vellum-owned shared channel identities.

## PR-1 scope

- Exposes service health and readiness surfaces for deployment wiring.
- Defers channel handlers and business routing to follow-up PRs.

## PR-2 scope

- Adds strict startup validation for managed-gateway config when enabled.
- Fails fast on missing or invalid `MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL`.
- Supports safe defaults when disabled or when strict validation is explicitly turned off.

## PR-3 scope

- Adds internal auth middleware abstraction with `bearer` and `mtls` modes.
- Enforces deny-by-default verification for audience and required scopes.
- Defines token lifecycle checks for expiry and revocation to support safe rotation.

## PR-4 scope

- Adds managed route-resolution endpoint wiring at `/v1/internal/managed-gateway/routes/resolve/`.
- Enforces internal auth (`bearer` or `mtls`) with required `routes:resolve` scope.
- Normalizes request routing keys and proxies to Django internal route resolver with explicit error envelopes.

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1/internal/managed-gateway/healthz/`
- `GET /v1/internal/managed-gateway/readyz/`
- `POST /v1/internal/managed-gateway/routes/resolve/`
