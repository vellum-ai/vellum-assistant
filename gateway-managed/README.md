# Vellum Managed Gateway

Managed gateway service skeleton for Vellum-owned shared channel identities.

## Current scope

- package scaffold and startup entrypoint
- strict startup config validation for enabled managed gateway mode
- internal auth middleware abstraction for bearer and mTLS service auth
- Django internal route resolve endpoint wiring for managed route lookup
- staging deployment manifests, smoke checks, and rollout/rollback runbook
- Twilio signature verifier primitives with rotation/revocation/expiry support
- managed Twilio SMS webhook endpoint skeleton with explicit auth/validation envelopes
- managed Twilio voice webhook endpoint skeleton with explicit auth/validation envelopes
- health and readiness endpoints:
  - `/healthz`
  - `/readyz`
  - `/v1/internal/managed-gateway/healthz/`
  - `/v1/internal/managed-gateway/readyz/`
- route resolve endpoint:
  - `POST /v1/internal/managed-gateway/routes/resolve/`
- Twilio inbound endpoint:
  - `POST /webhooks/twilio/sms`
  - `POST /webhooks/twilio/voice`

## Configuration

- `MANAGED_GATEWAY_ENABLED` (default `true`)
- `MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL` (required when enabled and strict validation is on)
- `MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION` (default `true`)
- `MANAGED_GATEWAY_INTERNAL_AUTH_MODE` (`bearer` or `mtls`)
- `MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE` (expected audience for internal callers)
- `MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS` (JSON token catalog)
- `MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS` (comma-separated token IDs)
- `MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS` (comma-separated principal IDs)
- `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS` (JSON Twilio signature token catalog)
- `MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS` (comma-separated Twilio token IDs)

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

## Twilio Signature Token Lifecycle

- Issuance: add a new entry to `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS` with `token_id`, `auth_token`, and optional `expires_at`.
- Rotation: keep old and new Twilio auth token entries active during overlap.
- Revocation: set `revoked: true` on a token entry or add its `token_id` to `MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS`.
- Expiry: set `expires_at` as ISO-8601 UTC; expired Twilio tokens are ignored by signature validation.

## Route Resolve Contract

Managed gateway route resolution contract lives in [`route-resolve-contract.md`](./route-resolve-contract.md).

## Managed Twilio SMS Webhook Contract

Managed Twilio SMS webhook contract lives in [`managed-twilio-sms-webhook-contract.md`](./managed-twilio-sms-webhook-contract.md).

## Managed Twilio Voice Webhook Contract

Managed Twilio voice webhook contract lives in [`managed-twilio-voice-webhook-contract.md`](./managed-twilio-voice-webhook-contract.md).

## Staging Deployment Artifacts

- Deployment scaffolding index: [`deploy/README.md`](./deploy/README.md)
- Kubernetes stubs:
  - [`deploy/k8s/deployment.staging.yaml`](./deploy/k8s/deployment.staging.yaml)
  - [`deploy/k8s/service.staging.yaml`](./deploy/k8s/service.staging.yaml)
- Manifest + optional live probe checks:
  - `bun run smoke:staging`
- Rollout and rollback runbook:
  - [`deploy/staging-rollout.md`](./deploy/staging-rollout.md)
