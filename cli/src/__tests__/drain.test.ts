import { describe, expect, test } from "bun:test";

import { drainAssistant, parseWaitDuration } from "../lib/drain.js";

const BASE = "http://127.0.0.1:7823";

interface RecordedCall {
  url: string;
  method: string;
}

/**
 * Fetch stub: routes requests through `handler` and records every call.
 * Throwing from the handler simulates a network failure.
 */
function fetchStub(
  handler: (url: string, method: string) => Response | Promise<Response>,
): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return handler(url, method);
  };
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function busyStatus(): unknown {
  return {
    quiescedUntil: Date.now() + 60_000,
    idle: false,
    activeConversations: [],
    memoryJobs: [
      { id: "job-1", type: "memory_retrospective", startedAt: Date.now() },
    ],
    scheduleRuns: [],
    workflowRuns: [],
    heartbeatRuns: [],
  };
}

function workflowBusyStatus(): unknown {
  return {
    quiescedUntil: Date.now() + 60_000,
    idle: false,
    activeConversations: [],
    memoryJobs: [],
    scheduleRuns: [],
    workflowRuns: [
      { runId: "wf-1", name: "nightly-report", startedAt: Date.now() },
    ],
    heartbeatRuns: [],
  };
}

function idleStatus(): unknown {
  return {
    quiescedUntil: Date.now() + 60_000,
    idle: true,
    activeConversations: [],
    memoryJobs: [],
    scheduleRuns: [],
    workflowRuns: [],
    heartbeatRuns: [],
  };
}

function idleExpiredLeaseStatus(): unknown {
  return { ...(idleStatus() as Record<string, unknown>), quiescedUntil: null };
}

describe("parseWaitDuration", () => {
  test("parses bare seconds, seconds, and minutes", () => {
    expect(parseWaitDuration("90")).toBe(90_000);
    expect(parseWaitDuration("90s")).toBe(90_000);
    expect(parseWaitDuration("10m")).toBe(600_000);
    expect(parseWaitDuration(" 5s ")).toBe(5_000);
  });

  test("rejects invalid durations", () => {
    expect(parseWaitDuration("0")).toBeNull();
    expect(parseWaitDuration("abc")).toBeNull();
    expect(parseWaitDuration("5x")).toBeNull();
    expect(parseWaitDuration("-5")).toBeNull();
    expect(parseWaitDuration("")).toBeNull();
  });
});

describe("drainAssistant", () => {
  test("arms the lease, narrates, and returns drained when work finishes", async () => {
    let statusCalls = 0;
    const { impl, calls } = fetchStub((url, method) => {
      if (url.endsWith("/v1/lifecycle/quiesce") && method === "POST") {
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      statusCalls += 1;
      return jsonResponse(statusCalls < 3 ? busyStatus() : idleStatus());
    });
    const lines: string[] = [];

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: (line) => lines.push(line),
    });

    expect(outcome).toBe("drained");
    expect(calls[0]).toEqual({
      url: `${BASE}/v1/lifecycle/quiesce`,
      method: "POST",
    });
    expect(lines.join("\n")).toContain("memory memory_retrospective");
  });

  test("a running workflow keeps the drain busy and is narrated", async () => {
    let statusCalls = 0;
    const { impl } = fetchStub((_url, method) => {
      if (method === "POST") {
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      statusCalls += 1;
      return jsonResponse(
        statusCalls < 2 ? workflowBusyStatus() : idleStatus(),
      );
    });
    const lines: string[] = [];

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: (line) => lines.push(line),
    });

    expect(outcome).toBe("drained");
    expect(lines.join("\n")).toContain('workflow "nightly-report"');
  });

  test("a single idle snapshot is not enough — drained needs two in a row", async () => {
    let statusCalls = 0;
    const sequence = [idleStatus(), busyStatus(), idleStatus(), idleStatus()];
    const { impl } = fetchStub((_url, method) => {
      if (method === "POST") {
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      const status = sequence[Math.min(statusCalls, sequence.length - 1)];
      statusCalls += 1;
      return jsonResponse(status);
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("drained");
    // idle, busy (streak reset), idle, idle — four reads, not one.
    expect(statusCalls).toBe(4);
  });

  test("idle without a live lease re-arms instead of counting toward drained", async () => {
    let statusCalls = 0;
    let armCalls = 0;
    const { impl } = fetchStub((_url, method) => {
      if (method === "POST") {
        armCalls += 1;
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      statusCalls += 1;
      // The lease has lapsed on the first idle read; once re-armed, the
      // subsequent idle reads carry a live lease.
      return jsonResponse(
        statusCalls === 1 ? idleExpiredLeaseStatus() : idleStatus(),
      );
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("drained");
    // Initial arm + the re-arm triggered by the lapsed lease.
    expect(armCalls).toBeGreaterThanOrEqual(2);
    // The expired-lease idle read did not count: two live-lease reads follow.
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  test("an unmaintainable lease fails the drain instead of trusting idle", async () => {
    let armCalls = 0;
    const { impl } = fetchStub((_url, method) => {
      if (method === "POST") {
        armCalls += 1;
        if (armCalls === 1) {
          return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
        }
        return jsonResponse({ error: "boom" }, 500);
      }
      return jsonResponse(idleExpiredLeaseStatus());
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("unreachable");
  });

  test("returns unsupported when the assistant lacks the quiesce route", async () => {
    const { impl } = fetchStub(() => jsonResponse({ error: "nope" }, 404));

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("unsupported");
  });

  test("returns unreachable when the initial lease request fails", async () => {
    const { impl } = fetchStub(() => {
      throw new Error("connection refused");
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("unreachable");
  });

  test("returns timeout when the deadline passes while still busy", async () => {
    const { impl } = fetchStub((_url, method) =>
      method === "POST"
        ? jsonResponse({ quiescedUntil: Date.now() + 60_000 })
        : jsonResponse(busyStatus()),
    );

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: Date.now() + 40,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("timeout");
  });

  test("returns unreachable after sustained status failures", async () => {
    const { impl } = fetchStub((_url, method) => {
      if (method === "POST") {
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      throw new Error("boom");
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      log: () => {},
    });

    expect(outcome).toBe("unreachable");
  });

  test("cancel releases the lease and returns cancelled", async () => {
    const controller = new AbortController();
    const { impl, calls } = fetchStub((_url, method) => {
      if (method === "POST") {
        return jsonResponse({ quiescedUntil: Date.now() + 60_000 });
      }
      if (method === "DELETE") {
        return jsonResponse({ released: true });
      }
      // First busy status arrives, then the user hits Ctrl-C.
      controller.abort();
      return jsonResponse(busyStatus());
    });

    const outcome = await drainAssistant({
      baseUrl: BASE,
      token: "tok",
      deadlineAt: null,
      pollIntervalMs: 1,
      fetchImpl: impl,
      signal: controller.signal,
      log: () => {},
    });

    expect(outcome).toBe("cancelled");
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.endsWith("/v1/lifecycle/quiesce"),
      ),
    ).toBe(true);
  });
});
