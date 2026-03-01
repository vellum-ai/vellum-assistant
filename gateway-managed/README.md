# Vellum Managed Gateway Contracts

This directory publishes **public compatibility artifacts** for the managed shared-identity gateway lane.

The deployable managed-gateway runtime is platform-owned and maintained in `vellum-assistant-platform`.
This OSS repo intentionally keeps only contracts and fixtures so integrators and reviewers can validate wire compatibility.

## Contents

- Route resolve contract:
  - [`route-resolve-contract.md`](./route-resolve-contract.md)
- Inbound dispatch contract:
  - [`inbound-dispatch-contract.md`](./inbound-dispatch-contract.md)
- Managed Twilio webhook contracts:
  - [`managed-twilio-sms-webhook-contract.md`](./managed-twilio-sms-webhook-contract.md)
  - [`managed-twilio-voice-webhook-contract.md`](./managed-twilio-voice-webhook-contract.md)
- Canonical fixtures:
  - [`fixtures/route-resolve-request.json`](./fixtures/route-resolve-request.json)
  - [`fixtures/route-resolve-response.json`](./fixtures/route-resolve-response.json)
  - [`fixtures/inbound-dispatch-request.json`](./fixtures/inbound-dispatch-request.json)
  - [`fixtures/inbound-dispatch-response.json`](./fixtures/inbound-dispatch-response.json)

## Ownership Boundary

1. Runtime implementation, deployment manifests, and operational runbooks are platform-owned.
2. This directory is contract-only and should not reintroduce a deployable managed-gateway service.
3. Contract changes should be versioned and coordinated with platform runtime updates.
