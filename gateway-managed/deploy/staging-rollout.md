# Managed Gateway Staging Rollout

## Preflight

1. Validate staging manifests and probe paths:
   - `gateway-managed/deploy/scripts/smoke-check-staging.sh`
2. Confirm deployment env values match Django internal routing and auth expectations:
   - `gateway-managed/deploy/k8s/deployment.staging.yaml`
   - ensure `MANAGED_GATEWAY_TWILIO_AUTH_TOKENS` is set via secret-backed env before rollout

## Rollout

1. Apply staging manifests:
   - `kubectl apply -f gateway-managed/deploy/k8s/service.staging.yaml`
   - `kubectl apply -f gateway-managed/deploy/k8s/deployment.staging.yaml`
2. Wait for deployment readiness:
   - `kubectl -n <namespace> rollout status deployment/managed-gateway`
3. Confirm pod health/readiness state:
   - `kubectl -n <namespace> get pods -l app.kubernetes.io/component=managed-gateway`
4. Probe service health endpoints from cluster context or via port-forward:
   - `curl -fsS http://<managed-gateway-service>/v1/internal/managed-gateway/healthz/`
   - `curl -fsS http://<managed-gateway-service>/v1/internal/managed-gateway/readyz/`

Expected rollout signals:
- Deployment reaches `Available=True` and `Progressing=True`.
- Probes return `200` for both `healthz` and `readyz`.
- No restart loop is observed on managed-gateway pods.

## Rollback

1. Re-apply previous known-good deployment revision:
   - `kubectl -n <namespace> rollout undo deployment/managed-gateway`
2. Wait for rollback readiness:
   - `kubectl -n <namespace> rollout status deployment/managed-gateway`
3. Re-run health/readiness probes and confirm baseline behavior:
   - `curl -fsS http://<managed-gateway-service>/v1/internal/managed-gateway/healthz/`
   - `curl -fsS http://<managed-gateway-service>/v1/internal/managed-gateway/readyz/`

Expected rollback signals:
- Previous revision pods become Ready.
- Managed-gateway health/readiness endpoints return baseline successful responses.
- Restart count and error rate return to pre-rollout levels.
