# Managed Gateway Deployment Artifacts

This directory contains staging deployment scaffolding for `gateway-managed`.

Included artifacts:
- `k8s/deployment.staging.yaml`: staging deployment stub with readiness/liveness probes
- `k8s/service.staging.yaml`: cluster service stub exposing HTTP traffic to managed-gateway
- `scripts/smoke-check-staging.sh`: static manifest checks and optional live probe checks
- `staging-rollout.md`: rollout and rollback runbook with readiness checkpoints

Important env contract:
- `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS` must define at least one active token when startup validation is enabled.
