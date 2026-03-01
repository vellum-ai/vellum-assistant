# Managed Gateway Architecture

The managed gateway is a dedicated service lane for Vellum-owned shared channel identities.

## PR-1 scope

- Exposes service health and readiness surfaces for deployment wiring.
- Defers channel handlers and business routing to follow-up PRs.

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1/internal/managed-gateway/healthz/`
- `GET /v1/internal/managed-gateway/readyz/`
