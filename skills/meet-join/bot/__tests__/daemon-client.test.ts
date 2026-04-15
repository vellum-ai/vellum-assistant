/**
 * Unit tests for `DaemonClient`.
 *
 * The client only hits the network through an injected fetch, so the tests
 * here run a canned fetch mock and assert on:
 *
 *   - URL shape (includes `/v1/internal/meet/<meetingId>/events`).
 *   - `Authorization: Bearer <token>` header present on every POST.
 *   - Batching: enqueue < maxBatchSize → one flush after flushIntervalMs.
 *   - Batching: enqueue == maxBatchSize → immediate flush.
 *   - Retry: 500 then 200 produces exactly one successful POST after retry.
 *   - No retry on 4xx: surfaces via onError.
 *   - `stop()` drains pending events before resolving.
 */

import { describe, expect, test } from "bun:test";

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import {
  DaemonClient,
  type FetchFn,
} from "../src/control/daemon-client.js";

/** Shape the mock records for every intercepted request. */
interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Response blueprint the mock plays back in order. */
interface CannedResponse {
  status: number;
  bodyText?: string;
  /** Throw instead of resolving — simulates a network failure. */
  throw?: Error;
}

interface MockFetch {
  fn: FetchFn;
  calls: RecordedCall[];
  queueResponses: (responses: CannedResponse[]) => void;
}

function makeMockFetch(initial: CannedResponse[] = []): MockFetch {
  let queued: CannedResponse[] = [...initial];
  const calls: RecordedCall[] = [];

  const fn: FetchFn = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyRaw = init?.body ?? "";
    let body: unknown = bodyRaw;
    if (typeof bodyRaw === "string" && bodyRaw.length > 0) {
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        body = bodyRaw;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body,
    });
    const next = queued.shift();
    if (!next) {
      throw new Error(
        `mock fetch: no queued response for call #${calls.length}`,
      );
    }
    if (next.throw) throw next.throw;
    const bodyText = next.bodyText ?? "";
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => bodyText,
    };
  };

  return {
    fn,
    calls,
    queueResponses: (responses) => {
      queued = [...queued, ...responses];
    },
  };
}

/** Build a stub lifecycle event suitable for enqueue. */
function makeLifecycleEvent(detail: string): MeetBotEvent {
  return {
    type: "lifecycle",
    meetingId: "m-1",
    timestamp: new Date().toISOString(),
    state: "joined",
    detail,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DaemonClient", () => {
  test("POSTs buffered events to the ingress URL with bearer auth", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local:1234",
      meetingId: "m-abc",
      botApiToken: "secret-token",
      fetch: mock.fn,
      flushIntervalMs: 50,
    });

    client.enqueue(makeLifecycleEvent("hello"));

    // Wait past the flush interval.
    await sleep(120);
    await client.stop();

    expect(mock.calls.length).toBe(1);
    const call = mock.calls[0]!;
    expect(call.url).toBe(
      "http://daemon.local:1234/v1/internal/meet/m-abc/events",
    );
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer secret-token");
    expect(call.headers["content-type"]).toBe("application/json");
    // The wire shape is a bare array of events (matching PR 9's
    // `MeetIngressBatchSchema = z.array(MeetBotEventSchema)`).
    expect(Array.isArray(call.body)).toBe(true);
    const body = call.body as MeetBotEvent[];
    expect(body).toHaveLength(1);
    expect(body[0]!.type).toBe("lifecycle");
  });

  test("flushes within the flush interval even for a single event", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 80,
    });

    const start = Date.now();
    client.enqueue(makeLifecycleEvent("one"));

    // Poll for the flush to land (stop polling as soon as it does).
    while (mock.calls.length === 0 && Date.now() - start < 500) {
      await sleep(10);
    }
    const elapsed = Date.now() - start;
    expect(mock.calls.length).toBe(1);
    // Should have flushed shortly after the 80ms timer — generous upper
    // bound so CI jitter doesn't trip us.
    expect(elapsed).toBeLessThan(300);

    await client.stop();
  });

  test("flushes immediately when the batch reaches maxBatchSize", async () => {
    const mock = makeMockFetch([{ status: 204 }, { status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      // Default is 20 — use it directly to match the PR spec.
      flushIntervalMs: 10_000,
    });

    for (let i = 0; i < 25; i += 1) {
      client.enqueue(makeLifecycleEvent(`ev-${i}`));
    }

    // Give the first (size-triggered) flush a moment to complete.
    const deadline = Date.now() + 500;
    while (mock.calls.length === 0 && Date.now() < deadline) {
      await sleep(5);
    }

    expect(mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstBatch = mock.calls[0]!.body as MeetBotEvent[];
    // First flush fires at exactly 20 (the default maxBatchSize).
    expect(firstBatch.length).toBe(20);

    // Drain the remainder — stop() flushes the last 5 events.
    await client.stop();
    expect(mock.calls.length).toBe(2);
    const secondBatch = mock.calls[1]!.body as MeetBotEvent[];
    expect(secondBatch.length).toBe(5);
  });

  test("retries on 5xx and succeeds on the next attempt", async () => {
    const mock = makeMockFetch([
      { status: 503 },
      { status: 204 },
    ]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 30,
    });

    client.enqueue(makeLifecycleEvent("retry-me"));
    await client.stop();

    // Two attempts total: 503 → retry → 204.
    expect(mock.calls.length).toBe(2);
    expect((mock.calls[0]!.body as MeetBotEvent[]).length).toBe(1);
    expect((mock.calls[1]!.body as MeetBotEvent[]).length).toBe(1);
  });

  test("retries on network errors and surfaces after exhausting budget", async () => {
    const mock = makeMockFetch([
      { status: 0, throw: new Error("ECONNREFUSED") },
      { status: 0, throw: new Error("ECONNREFUSED") },
      { status: 0, throw: new Error("ECONNREFUSED") },
      { status: 0, throw: new Error("ECONNREFUSED") },
    ]);
    const errors: Array<{ err: Error; batch: MeetBotEvent[] }> = [];
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 30,
      onError: (err, batch) => errors.push({ err, batch }),
    });

    client.enqueue(makeLifecycleEvent("never-lands"));
    await client.stop();

    expect(mock.calls.length).toBe(4); // 1 original + 3 retries.
    expect(errors.length).toBe(1);
    expect(errors[0]!.err.message).toContain("ECONNREFUSED");
    expect(errors[0]!.batch.length).toBe(1);
  });

  test("does not retry 4xx — surfaces via onError immediately", async () => {
    const mock = makeMockFetch([
      { status: 400, bodyText: "invalid event batch" },
    ]);
    const errors: Array<{ err: Error; batch: MeetBotEvent[] }> = [];
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 20,
      onError: (err, batch) => errors.push({ err, batch }),
    });

    client.enqueue(makeLifecycleEvent("reject"));
    await client.stop();

    expect(mock.calls.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]!.err.message).toContain("400");
    expect(errors[0]!.err.message).toContain("invalid event batch");
  });

  test("stop() drains pending events before resolving", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 5_000, // long — stop() is the only thing that can flush in time.
    });

    client.enqueue(makeLifecycleEvent("pending-1"));
    client.enqueue(makeLifecycleEvent("pending-2"));

    // Right after enqueue, nothing has been POSTed yet.
    expect(mock.calls.length).toBe(0);

    await client.stop();

    expect(mock.calls.length).toBe(1);
    const body = mock.calls[0]!.body as MeetBotEvent[];
    expect(body.length).toBe(2);
  });

  test("stop() is idempotent — calling twice does not re-POST", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 5_000,
    });

    client.enqueue(makeLifecycleEvent("only"));
    await client.stop();
    await client.stop();

    expect(mock.calls.length).toBe(1);
  });

  test("enqueue after stop() is a no-op", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 5_000,
    });

    client.enqueue(makeLifecycleEvent("pre-stop"));
    await client.stop();

    client.enqueue(makeLifecycleEvent("post-stop"));
    // Give any errant timer a moment to fire.
    await sleep(30);

    expect(mock.calls.length).toBe(1);
    const body = mock.calls[0]!.body as MeetBotEvent[];
    expect(body.length).toBe(1);
    expect((body[0] as { detail?: string }).detail).toBe("pre-stop");
  });

  test("URL encodes the meeting id", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local",
      meetingId: "m/weird id",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 20,
    });

    client.enqueue({
      type: "lifecycle",
      meetingId: "m/weird id",
      timestamp: new Date().toISOString(),
      state: "joined",
    });
    await client.stop();

    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!.url).toBe(
      "http://daemon.local/v1/internal/meet/m%2Fweird%20id/events",
    );
  });

  test("trims trailing slashes from the daemon URL", async () => {
    const mock = makeMockFetch([{ status: 204 }]);
    const client = new DaemonClient({
      daemonUrl: "http://daemon.local:9000/",
      meetingId: "m-1",
      botApiToken: "tk",
      fetch: mock.fn,
      flushIntervalMs: 20,
    });

    client.enqueue(makeLifecycleEvent("x"));
    await client.stop();

    expect(mock.calls[0]!.url).toBe(
      "http://daemon.local:9000/v1/internal/meet/m-1/events",
    );
  });
});
