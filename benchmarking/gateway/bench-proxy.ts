#!/usr/bin/env bun
/**
 * Gateway proxy-path load-test script.
 *
 * Sends requests through the runtime proxy path at high concurrency.
 * Requires a running backend at ASSISTANT_RUNTIME_BASE_URL (or a stub server).
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:7830 PROXY_TOKEN=<token> bun run benchmarking/gateway/bench-proxy.ts
 *
 * Options (env vars):
 *   GATEWAY_URL       - Target gateway URL (default: http://localhost:7830)
 *   PROXY_TOKEN       - Bearer token for proxy auth
 *   PROXY_PATH        - Path to hit (default: /v1/health)
 *   DURATION_SECS     - Test duration in seconds (default: 30)
 *   CONCURRENCY       - Concurrent connections (default: 50)
 */

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:7830";
const PROXY_TOKEN = process.env.PROXY_TOKEN;
const PROXY_PATH = process.env.PROXY_PATH || "/v1/health";
const DURATION_SECS = Number(process.env.DURATION_SECS || "30");
const CONCURRENCY = Number(process.env.CONCURRENCY || "50");

if (!PROXY_TOKEN) {
  console.error("PROXY_TOKEN is required");
  process.exit(1);
}

const url = `${GATEWAY_URL}${PROXY_PATH}`;

let total = 0;
let errors = 0;
const latencies: number[] = [];

async function worker() {
  while (Date.now() < endTime) {
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${PROXY_TOKEN}`,
        },
      });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      total++;
      if (res.status >= 500) errors++;
    } catch {
      errors++;
      total++;
    }
  }
}

console.log(`Gateway proxy benchmark`);
console.log(`  Target:      ${url}`);
console.log(`  Duration:    ${DURATION_SECS}s`);
console.log(`  Concurrency: ${CONCURRENCY}`);
console.log(`  Starting...`);

const startTime = Date.now();
const endTime = startTime + DURATION_SECS * 1000;

const workers = Array.from({ length: CONCURRENCY }, () => worker());
await Promise.all(workers);

const elapsed = (Date.now() - startTime) / 1000;
latencies.sort((a, b) => a - b);

const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
const rpm = (total / elapsed) * 60;

console.log(`\nResults:`);
console.log(`  Total requests:  ${total}`);
console.log(`  Errors:          ${errors}`);
console.log(`  Duration:        ${elapsed.toFixed(1)}s`);
console.log(`  RPM:             ${rpm.toFixed(0)}`);
console.log(`  Latency p50:     ${p50.toFixed(1)}ms`);
console.log(`  Latency p95:     ${p95.toFixed(1)}ms`);
console.log(`  Latency p99:     ${p99.toFixed(1)}ms`);
console.log(`  Error rate:      ${((errors / total) * 100).toFixed(2)}%`);
