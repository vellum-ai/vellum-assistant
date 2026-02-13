# Gateway Load Testing

Scripts for measuring gateway throughput and latency.

## Prerequisites

- Bun installed
- Gateway running locally (or accessible at `GATEWAY_URL`)
- For proxy benchmarks: proxy mode enabled with a running backend

## Webhook Benchmark

Tests the Telegram webhook inbound path (secret verification, JSON parse, normalize, routing).

```bash
# Start gateway
cd gateway && bun run dev

# Run benchmark (separate terminal)
GATEWAY_URL=http://localhost:7830 \
WEBHOOK_SECRET=<your-secret> \
DURATION_SECS=30 \
CONCURRENCY=50 \
bun run benchmarking/gateway/bench-webhook.ts
```

### Pass/fail criteria

| Metric | Target |
|--------|--------|
| RPM | >= 3,000 per pod |
| Error rate | < 1% |
| p95 latency | Informational (logged, no hard gate) |

## Proxy Benchmark

Tests the runtime proxy path (auth + proxy forwarding).

```bash
GATEWAY_URL=http://localhost:7830 \
PROXY_TOKEN=<your-token> \
PROXY_PATH=/v1/health \
DURATION_SECS=30 \
CONCURRENCY=50 \
bun run benchmarking/gateway/bench-proxy.ts
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_URL` | `http://localhost:7830` | Target gateway URL |
| `WEBHOOK_SECRET` | — | Telegram webhook secret (webhook bench only) |
| `PROXY_TOKEN` | — | Bearer token (proxy bench only) |
| `PROXY_PATH` | `/v1/health` | Path to hit (proxy bench only) |
| `DURATION_SECS` | `30` | Test duration |
| `CONCURRENCY` | `50` | Concurrent connections |

## Interpreting Results

Output includes: total requests, errors, RPM, p50/p95/p99 latency, and error rate. The webhook benchmark has an automated pass/fail gate.
