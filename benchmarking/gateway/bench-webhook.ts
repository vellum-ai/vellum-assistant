#!/usr/bin/env bun
/**
 * Gateway webhook load-test script.
 *
 * Sends simulated Telegram webhook POSTs to the gateway at high concurrency.
 * The gateway will reject them (no route configured), but this exercises the
 * full inbound path: secret verification → JSON parse → normalize → routing.
 *
 * Usage:
 *   GATEWAY_URL=http://localhost:7830 WEBHOOK_SECRET=<secret> bun run benchmarking/gateway/bench-webhook.ts
 *
 * Options (env vars):
 *   GATEWAY_URL       - Target gateway URL (default: http://localhost:7830)
 *   WEBHOOK_SECRET    - Telegram webhook secret for auth
 *   DURATION_SECS     - Test duration in seconds (default: 30)
 *   CONCURRENCY       - Concurrent connections (default: 50)
 */

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:7830";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DURATION_SECS = Number(process.env.DURATION_SECS || "30");
const CONCURRENCY = Number(process.env.CONCURRENCY || "50");

if (!WEBHOOK_SECRET) {
  console.error("WEBHOOK_SECRET is required");
  process.exit(1);
}

const url = `${GATEWAY_URL}/webhooks/telegram`;

function makePayload(i: number) {
  return JSON.stringify({
    update_id: 100000 + i,
    message: {
      message_id: i,
      chat: { id: 10000 + (i % 100), type: "private" },
      from: { id: 20000 + (i % 100), is_bot: false, first_name: "Bench" },
      text: `Load test message ${i}`,
    },
  });
}

let total = 0;
let errors = 0;
let counter = 0;
const latencies: number[] = [];

async function worker() {
  while (Date.now() < endTime) {
    const i = counter++;
    const body = makePayload(i);
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
        },
        body,
      });
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      total++;
      if (!res.ok && res.status !== 200) {
        // 500-level errors count as failures
        if (res.status >= 500) errors++;
      }
    } catch {
      errors++;
      total++;
    }
  }
}

console.log(`Gateway webhook benchmark`);
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

// Pass/fail: target is 3000+ RPM per pod with <1% error rate
const RPM_TARGET = 3000;
const ERROR_RATE_MAX = 1;
const errorRate = (errors / total) * 100;

if (rpm >= RPM_TARGET && errorRate <= ERROR_RATE_MAX) {
  console.log(`\n✓ PASS: ${rpm.toFixed(0)} RPM ≥ ${RPM_TARGET} target, ${errorRate.toFixed(2)}% errors ≤ ${ERROR_RATE_MAX}%`);
} else {
  console.log(`\n✗ FAIL:`);
  if (rpm < RPM_TARGET) console.log(`  RPM ${rpm.toFixed(0)} < ${RPM_TARGET} target`);
  if (errorRate > ERROR_RATE_MAX) console.log(`  Error rate ${errorRate.toFixed(2)}% > ${ERROR_RATE_MAX}% max`);
  process.exit(1);
}
