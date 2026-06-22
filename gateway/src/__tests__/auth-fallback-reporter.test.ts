import { describe, expect, mock, test } from "bun:test";

import { AuthFallbackCountTracker } from "../auth-fallback-count-tracker.js";
import { AuthFallbackReporter } from "../auth-fallback-reporter.js";

const BASE_URL = "http://127.0.0.1:7821";

function makeReporter(
  tracker: AuthFallbackCountTracker,
  fetchImpl: typeof import("../fetch.js").fetchImpl,
) {
  return new AuthFallbackReporter({
    tracker,
    baseUrl: BASE_URL,
    intervalMs: 60_000,
    fetchImpl,
    mintToken: () => "test-service-token",
  });
}

describe("AuthFallbackReporter", () => {
  test("does nothing when there is nothing to flush", async () => {
    const tracker = new AuthFallbackCountTracker(0);
    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    await makeReporter(tracker, fetchMock as never).flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("drains and POSTs the counts to the daemon route with a service token", async () => {
    const tracker = new AuthFallbackCountTracker(0);
    tracker.increment("edge", "/v1/chat", "missing_authorization");
    tracker.increment("edge", "/v1/chat", "missing_authorization");
    tracker.increment("edge-guardian", "/v1/sync", "guardian_mismatch");

    const fetchMock = mock(async () => new Response("{}", { status: 200 }));
    await makeReporter(tracker, fetchMock as never).flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/v1/internal/telemetry/auth-fallback`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer test-service-token");

    const body = JSON.parse(init.body as string);
    expect(typeof body.window_start).toBe("number");
    expect(typeof body.window_end).toBe("number");
    expect(body.counts).toEqual(
      expect.arrayContaining([
        {
          guard: "edge",
          path: "/v1/chat",
          failure_kind: "missing_authorization",
          count: 2,
        },
        {
          guard: "edge-guardian",
          path: "/v1/sync",
          failure_kind: "guardian_mismatch",
          count: 1,
        },
      ]),
    );

    // Successful flush drains the tracker.
    expect(tracker.snapshot()).toEqual([]);
  });

  test("re-queues counts when the daemon returns a non-OK status", async () => {
    const tracker = new AuthFallbackCountTracker(0);
    tracker.increment("edge", "/v1/chat", "missing_authorization");

    const fetchMock = mock(async () => new Response("nope", { status: 404 }));
    await makeReporter(tracker, fetchMock as never).flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Counts merged back so the next flush retries them.
    const snap = tracker.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].count).toBe(1);
  });

  test("re-queues counts when the POST throws", async () => {
    const tracker = new AuthFallbackCountTracker(0);
    tracker.increment("edge", "/v1/chat", "missing_authorization");
    tracker.increment("edge", "/v1/chat", "missing_authorization");

    const fetchMock = mock(async () => {
      throw new Error("connection refused");
    });
    await makeReporter(tracker, fetchMock as never).flush();

    const snap = tracker.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].count).toBe(2);
  });
});
