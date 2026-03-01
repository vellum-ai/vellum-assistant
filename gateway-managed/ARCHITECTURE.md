# Managed Gateway Contracts Architecture

This directory is the OSS publication point for managed-gateway wire contracts.

## Scope

1. Public request/response contracts for internal route resolution, inbound dispatch, and outbound send.
2. Public webhook envelope contracts for managed Twilio SMS and voice ingress.
3. Canonical JSON fixtures used for compatibility and drift checks.

## Non-Scope

1. No deployable managed-gateway runtime in this repo.
2. No runtime auth middleware, routing implementation, or deployment artifacts.
3. No platform operational runbooks for hosted environments.

## Contract Endpoints

- `POST /v1/internal/managed-gateway/routes/resolve/`
- `POST /v1/internal/managed-gateway/inbound/dispatch/`
- `POST /v1/internal/managed-gateway/outbound-send/`
- `POST /webhooks/twilio/sms`
- `POST /webhooks/twilio/voice`

## Ownership Model

- Platform-owned runtime: `vellum-assistant-platform`
- OSS-owned contract artifacts: this `gateway-managed/` directory

Contract changes here must be coordinated with platform runtime changes to avoid drift.
