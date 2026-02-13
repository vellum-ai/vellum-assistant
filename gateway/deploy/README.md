# Gateway Deployment

## Kubernetes

Starter manifests in `k8s/` provide:

- **Deployment** — 2 replicas, liveness/readiness probes, resource limits
- **Service** — ClusterIP on port 80 → container port 7830
- **HPA** — scales 2–10 replicas based on CPU (70% target)

### Prerequisites

1. Create a Secret `gateway-secrets` with:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `RUNTIME_PROXY_BEARER_TOKEN` (if proxy + auth enabled)

2. Create a ConfigMap `gateway-config` with:
   - `ASSISTANT_RUNTIME_BASE_URL`
   - `GATEWAY_PORT=7830`
   - Any other optional env vars from the [configuration table](../../README.md#configuration)

### Apply

```bash
kubectl apply -k gateway/deploy/k8s
```

### Verify

```bash
kubectl get pods -l app=vellum-gateway
kubectl port-forward svc/vellum-gateway 7830:80
curl http://localhost:7830/healthz
```

### Telegram webhook registration

After deploy, register (or update) the Telegram webhook to point to your gateway's external URL:

See the [Telegram Bot API setWebhook docs](https://core.telegram.org/bots/api#setwebhook). Pass `url`, your webhook secret, and `allowed_updates: ["message"]`.

### Assumptions

- Image registry: `gcr.io/vellum-ai-prod/vellum-gateway`
- The gateway pod runs as non-root (uid 1001)
- `terminationGracePeriodSeconds` (15s) > `GATEWAY_SHUTDOWN_DRAIN_MS` (5s default)
- Resource limits are conservative starting points; tune based on load test results
