# Managed Gateway Architecture

The managed gateway is a dedicated service lane for Vellum-owned shared channel identities.

## PR-1 scope

- Exposes service health and readiness surfaces for deployment wiring.
- Defers channel handlers and business routing to follow-up PRs.

## PR-2 scope

- Adds strict startup validation for managed-gateway config when enabled.
- Fails fast on missing or invalid `MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL`.
- Supports safe defaults when disabled or when strict validation is explicitly turned off.

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1/internal/managed-gateway/healthz/`
- `GET /v1/internal/managed-gateway/readyz/`
