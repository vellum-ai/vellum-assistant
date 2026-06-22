import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject module is imported so the
// happy-path (mocked Sentry) is exercised.
// ---------------------------------------------------------------------------

interface SentryBreadcrumbCall {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}
const sentryBreadcrumbs: SentryBreadcrumbCall[] = [];

mock.module("@sentry/react", () => ({
  addBreadcrumb: (crumb: SentryBreadcrumbCall) => {
    sentryBreadcrumbs.push(crumb);
  },
  captureMessage: () => {},
  captureException: () => {},
}));

// Controllable reconnect cursor so the reconnect-URL tests can exercise
// the resumable-stream wiring without a live daemon.
let mockReconnectCursor: number | null = null;
mock.module("@/lib/streaming/reconnect-cursor", () => ({
  getReconnectCursor: () => mockReconnectCursor,
}));

import { getLifecycleDiagnosticsEvents } from "@/lib/diagnostics";
import { subscribeEvents, type StreamReconnectCause } from "@/lib/streaming/stream-transport";

describe("subscribeEvents idle watchdog", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // The vellum-api request interceptor reads document.cookie via
    // ensureCsrfCookie() on mutating requests; harmless for this GET
    // path but keeps the bun (Node) test env consistent.
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  test("omits any conversation query param when subscribing to all assistant events", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain("/v1/assistants/asst-1/events/");
      // Neither the legacy nor the canonical wire field should appear when
      // subscribing to all assistant events (no conversation filter).
      expect(requestedUrls[0]).not.toContain("conversationKey");
      expect(requestedUrls[0]).not.toContain("conversationId");
    } finally {
      stream.cancel();
    }
  });

  test("force-reconnects when the SSE stream stalls past the idle timeout", async () => {
    // When the SSE transport silently stalls (no bytes flowing) but
    // never raises an error, the for-await-of loop in
    // subscribeEvents blocks forever and any messages emitted
    // server-side never reach the UI. The watchdog must abort the
    // active fetch after idleTimeoutMs and let the existing reconnect
    // path open a fresh connection.
    let fetchCallCount = 0;
    const capturedSignals: AbortSignal[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        if (signal) capturedSignals.push(signal);

        // A body that never produces any bytes — the watchdog is the
        // only thing that can break this stream out of its read.
        const body = new ReadableStream({
          start() {
            // Intentionally empty: never enqueue, never close.
          },
        });

        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    ) as unknown as typeof fetch;

    const onEvent = mock(() => {});
    const onError = mock(() => {});
    let reconnectCallbacks = 0;

    const stream = subscribeEvents(
      "asst-1",
      onEvent,
      onError,
      {
        // Short timings so the test runs in well under a second.
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: () => {
          reconnectCallbacks++;
        },
      },
    );

    try {
      // Allow: connect → stall → watchdog (~50ms) → reconnect delay
      // (~10ms) → second connect, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      // The watchdog must have aborted at least the first attempt and
      // forced the SDK to open a fresh fetch.
      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      expect(capturedSignals[0]?.aborted).toBe(true);

      // Reconnect path was actually exercised, so reconcileActive-
      // Conversation() (wired by callers as onReconnect) would fire.
      expect(reconnectCallbacks).toBeGreaterThanOrEqual(1);
    } finally {
      stream.cancel();
    }
  });

  test("does not arm the watchdog while a slow onReconnect callback is in flight", async () => {
    // client.sse.get returns a lazy async generator: the underlying
    // fetch only kicks off on the first iterator pull, and the
    // onReconnect callback (which performs an HTTP reconcile
    // roundtrip and can take longer than idleTimeoutMs in practice)
    // sits between the two. Arming the watchdog before onReconnect
    // resolves would charge that reconcile time against the timeout
    // and could abort the new attempt before any SSE traffic ever
    // started — burning the reconnect budget on a recoverable
    // connection.
    let fetchCallCount = 0;
    const signalAbortedAtFetchStart: boolean[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        signalAbortedAtFetchStart.push(signal?.aborted ?? false);

        return new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire and trigger reconnect.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Comfortably longer than idleTimeoutMs: simulates a slow
        // reconcileActiveConversation() round-trip.
        onReconnect: async () => {
          await new Promise((r) => setTimeout(r, 150));
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // slow onReconnect (~150ms) → second fetch starts.
      await new Promise((r) => setTimeout(r, 400));

      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      // The signal each attempt receives must not already be aborted
      // at the moment the SDK initiates its fetch — if it were, the
      // watchdog would have charged the onReconnect window against
      // its budget and aborted the attempt before the stream could
      // produce any traffic.
      expect(signalAbortedAtFetchStart[0]).toBe(false);
      expect(signalAbortedAtFetchStart[1]).toBe(false);
    } finally {
      stream.cancel();
    }
  });

  test("records sse_watchdog_fired with attempt + idleTimeoutMs when the stream stalls", async () => {
    // The deferred Layer 2/3 watchdog work hinges on field data
    // showing how often the watchdog actually fires in production.
    // The diagnostic must (a) be recorded before the abort cascade
    // tears down per-attempt state, and (b) carry enough context
    // (attempt counter + idleTimeoutMs) for downstream analysis to
    // distinguish first-attempt fires from reconnect-attempt fires.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getLifecycleDiagnosticsEvents().length;
    const breadcrumbsBefore = sentryBreadcrumbs.length;

    const sub = subscribeEvents(
      "asst-watchdog",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      // Comfortably past the first watchdog fire (~50ms).
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getLifecycleDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(fires.length).toBeGreaterThanOrEqual(1);
      const first = fires[0]!;
      expect(first.details).toMatchObject({
        assistantId: "asst-watchdog",
        idleTimeoutMs: 50,
      });
      // The first watchdog fire happens on the very first connect
      // attempt, before any reconnect has incremented the counter.
      expect(first.details.attempt).toBe(0);
      // Centralized platform tag is injected by the diagnostics recorder.
      expect(first.details.platform).toBe("web");

      // Breadcrumb attaches to nearby Sentry error events for
      // debugging context.
      const newBreadcrumbs = sentryBreadcrumbs.slice(breadcrumbsBefore);
      const watchdogBreadcrumb = newBreadcrumbs.find(
        (crumb) =>
          crumb.category === "sse.watchdog" &&
          crumb.message === "watchdog_fired",
      );
      expect(watchdogBreadcrumb).toBeDefined();
      expect(watchdogBreadcrumb!.data).toMatchObject({
        assistantId: "asst-watchdog",
        idleTimeoutMs: 50,
      });
    } finally {
      sub.cancel();
    }
  });

  test("records wasTurnSending + liveness counters in diagnostics and breadcrumb so user-harming vs benign stalls are distinguishable", async () => {
    // wasTurnSending splits stalls into two populations: in-flight
    // turn (user-harming — visible blank screen) vs idle stream
    // (benign). The liveness counters further split by whether
    // vembda was alive: "vembda alive, daemon silent" vs "server
    // never responded" vs "stream died mid-turn".
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getLifecycleDiagnosticsEvents().length;
    const breadcrumbsBefore = sentryBreadcrumbs.length;

    const sub = subscribeEvents(
      "asst-aggregation",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Caller supplies a synchronous snapshot of turn state at
        // watchdog-fire time. Returning true here models a stall
        // during an in-flight turn — the user-harming case.
        getActiveTurnSending: () => true,
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getLifecycleDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // The diagnostic ring and breadcrumb carry the full context
      // so both support snapshots and Sentry error events have it.
      expect(firstFire!.details).toMatchObject({
        wasTurnSending: true,
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });

      // Breadcrumb carries the same fields for debugging context.
      const newBreadcrumbs = sentryBreadcrumbs.slice(breadcrumbsBefore);
      const watchdogBreadcrumb = newBreadcrumbs.find(
        (crumb) =>
          crumb.category === "sse.watchdog" &&
          crumb.message === "watchdog_fired",
      );
      expect(watchdogBreadcrumb).toBeDefined();
      expect(watchdogBreadcrumb!.data).toMatchObject({
        wasTurnSending: true,
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("records wasTurnSending: null in breadcrumb when no getActiveTurnSending snapshot is supplied", async () => {
    // Callers without turn-sending wiring produce wasTurnSending: null
    // in the breadcrumb, distinguishing "caller didn't provide" from
    // "caller provided false".
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const breadcrumbsBefore = sentryBreadcrumbs.length;

    const sub = subscribeEvents(
      "asst-no-snapshot",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newBreadcrumbs = sentryBreadcrumbs.slice(breadcrumbsBefore);
      const watchdogBreadcrumb = newBreadcrumbs.find(
        (crumb) =>
          crumb.category === "sse.watchdog" &&
          crumb.message === "watchdog_fired",
      );
      expect(watchdogBreadcrumb).toBeDefined();
      expect(watchdogBreadcrumb!.data).toMatchObject({
        wasTurnSending: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("counts heartbeat comment frames and data frames separately so vembda-alive vs server-silent stalls are distinguishable", async () => {
    // Comment frames (vembda's `: keepalive\n\n` heartbeats and the
    // daemon's own heartbeats) reset the watchdog but never yield
    // through the for-await iterator. Counting them separately
    // from data frames lets the diagnostic distinguish three
    // failure modes at the moment of a stall:
    //
    //   - keepalives > 0, dataFrames = 0 → vembda alive, daemon silent
    //     (the daemon stopped emitting tokens but the vembda
    //     keepalive injector is still running)
    //   - keepalives = 0, dataFrames > 0 → stream died mid-turn
    //     (data was flowing but suddenly stopped with no keepalive
    //     before the timeout)
    //   - keepalives = 0, dataFrames = 0 → server never responded
    //     (no traffic at all on this attempt)
    //
    // Each of these maps to a different fix. Without splitting the
    // counters, the watchdog fire is uninterpretable.
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              // Two heartbeat comment frames (no data:line) and one
              // data frame, then stall.
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(
                encoder.encode('event: token\ndata: "hello"\n\n'),
              );
              // Now stall — let the watchdog fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getLifecycleDiagnosticsEvents().length;

    const sub = subscribeEvents(
      "asst-heartbeat",
      () => {},
      () => {},
      { idleTimeoutMs: 100, reconnectBaseDelayMs: 10 },
    );

    try {
      // First fire happens after the data frame at ~20ms +
      // idleTimeoutMs = ~120ms. 250ms gives comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      const newEvents = getLifecycleDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // Two heartbeat comment frames and one data frame arrived
      // before the stall.
      expect(firstFire!.details.keepalivesReceivedSinceConnect).toBe(2);
      expect(firstFire!.details.dataFramesReceivedSinceConnect).toBe(1);
      // lastByteAgeMs is the time since the last SSE chunk; with
      // idleTimeoutMs=100 the watchdog fires ~100ms after the
      // last chunk, so the age should be in the 100-200ms range.
      // Don't pin a tight bound (the test runner's clock has
      // resolution >1ms); just assert it is a positive number,
      // not null (which would mean "no traffic at all").
      expect(typeof firstFire!.details.lastByteAgeMs).toBe("number");
      expect(firstFire!.details.lastByteAgeMs as number).toBeGreaterThanOrEqual(
        90,
      );
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'watchdog' to onReconnect after the watchdog aborts a stall", async () => {
    // Distinguishing watchdog-driven reconnects from ordinary
    // transport-error reconnects is what makes the post-reconnect
    // reconcile_result diagnostic interpretable: a "messages
    // recovered" signal is only meaningful when scoped to the
    // silent-stall recovery path.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const causes: StreamReconnectCause[] = [];

    const sub = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // onReconnect invoked, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      // Every reconnect in this scenario is watchdog-driven because
      // the stalling fetch never produces an SDK-surfaced error.
      for (const cause of causes) {
        expect(cause).toBe("watchdog");
      }
    } finally {
      sub.cancel();
    }
  });

  test("does not falsely tag a transport error as watchdog-driven when the timer would fire mid-backoff", async () => {
    // Regression for the stale-timer hazard: armWatchdog runs a
    // setTimeout that survives the for-await loop's exit, so a
    // transport error close to the idle deadline can leave the
    // timer armed during the reconnect backoff. If the timer then
    // fires before the next connect attempt, the new diagnostic
    // path would set lastAbortCause = "watchdog" and tag a
    // recoverable error path as a watchdog stall in telemetry.
    // Verifies that clearing the watchdog when the for-await loop
    // exits prevents that false attribution.
    // Every attempt errors after ~50ms — earlier than the 100ms
    // idle deadline — so the watchdog should never legitimately
    // fire under test. With the fix in place, the timer is cleared
    // when the for-await loop exits, before the reconnect backoff
    // window opens; without it, the timer would fire mid-backoff
    // and false-tag the next reconnect as watchdog-driven.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      const localCount = fetchCallCount;
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.error(
                new Error(`transport failure ${localCount}`),
              );
            }, 50);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: StreamReconnectCause[] = [];
    const eventCountBefore = getLifecycleDiagnosticsEvents().length;

    const sub = subscribeEvents(
      "asst-stale",
      () => {},
      () => {},
      {
        // Tight idle window + longer backoff: the original idle
        // timer's deadline (100ms) lands inside the reconnect
        // backoff window (200ms), so a stale fire would be
        // observable as a "watchdog" cause on the next attempt.
        idleTimeoutMs: 100,
        reconnectBaseDelayMs: 200,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // First fetch errors (~50ms) → reconnect awaits 200ms →
      // second connect runs at ~250ms (also errors at ~50ms in).
      // 400ms gives a clean window with exactly one onReconnect
      // call observable and no watchdog opportunity on attempt 2.
      await new Promise((r) => setTimeout(r, 400));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");

      // No sse_watchdog_fired diagnostic should have been recorded
      // for this subscription — every fetch errored before its
      // watchdog deadline, so any fire is from a stale timer.
      const newEvents = getLifecycleDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) =>
          event.kind === "sse_watchdog_fired" &&
          (event.details as { assistantId?: unknown }).assistantId ===
            "asst-stale",
      );
      expect(fires.length).toBe(0);
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'error' to onReconnect when the stream surfaces a transport error", async () => {
    // Symmetric counterpart to the watchdog-cause test: when the SDK
    // raises an error on the iterator (a real transport failure, not
    // a silent stall), the reconnect path must report `cause:
    // "error"` so callers don't tag the post-reconnect reconcile as
    // a watchdog-recovery in their telemetry.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First attempt: body errors out shortly after open. The SDK
        // surfaces this via onSseError, which ends the iterator and
        // sends connect() down its reconnect branch with no watchdog
        // involvement.
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.error(new Error("transport failure"));
              }, 10);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      // Subsequent attempts stall so we can cancel cleanly without
      // the test cascading through more reconnect rounds.
      return new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: StreamReconnectCause[] = [];

    const sub = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      {
        // Generous idle timeout: must comfortably exceed the
        // ~10ms transport error + ~10ms reconnect delay + the
        // measurement window below, so the watchdog cannot race
        // the error path and contaminate the recorded cause.
        idleTimeoutMs: 5000,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");
    } finally {
      sub.cancel();
    }
  });

  test("cancel() halts further reconnects after the watchdog fires", async () => {
    // The watchdog must not survive cancel(): otherwise a stalled
    // stream that the caller has already torn down would keep
    // hammering the daemon with reconnect attempts.
    let fetchCallCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(
        new ReadableStream({
          start() {
            // Never produce bytes — force the watchdog to fire.
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    const sub = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    // Wait long enough for at least one watchdog fire + reconnect.
    await new Promise((r) => setTimeout(r, 200));
    sub.cancel();
    const countAtCancel = fetchCallCount;

    // After cancel, no further attempts should be scheduled.
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchCallCount).toBe(countAtCancel);
  });
});

describe("subscribeEvents onStreamOpen / onStreamClose", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  test("fires onStreamOpen on the first frame, then onStreamClose when the stream ends", async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = mock(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            // A single data frame proves the stream is live, then close.
            controller.enqueue(encoder.encode('event: token\ndata: "hi"\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const onStreamOpen = mock(() => {});
    const onStreamClose = mock(() => {});

    const stream = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      {
        idleTimeoutMs: 5_000,
        reconnectBaseDelayMs: 10_000,
        onStreamOpen,
        onStreamClose,
      },
    );

    // The handle is returned synchronously while the fetch is still in
    // flight — neither signal may have fired yet.
    expect(onStreamOpen).not.toHaveBeenCalled();

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(onStreamOpen).toHaveBeenCalledTimes(1);
      expect(onStreamClose).toHaveBeenCalledTimes(1);
    } finally {
      stream.cancel();
    }
  });

  test("does not fire onStreamClose for a connect that opens but never receives a frame", async () => {
    // A 200 response whose body closes immediately with no frames: no
    // proof of liveness, so it must never read as connected — and the
    // paired close must not fire either.
    globalThis.fetch = mock(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const onStreamOpen = mock(() => {});
    const onStreamClose = mock(() => {});

    const stream = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      {
        idleTimeoutMs: 5_000,
        reconnectBaseDelayMs: 10_000,
        onStreamOpen,
        onStreamClose,
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(onStreamOpen).not.toHaveBeenCalled();
      expect(onStreamClose).not.toHaveBeenCalled();
    } finally {
      stream.cancel();
    }
  });

  test("does not fire onStreamOpen when the initial connect never establishes", async () => {
    // Reject every fetch so the connection never opens; the handle still
    // exists, but a caller mirroring liveness must never see "connected".
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const onStreamOpen = mock(() => {});
    const onError = mock(() => {});

    const stream = subscribeEvents("asst-1", () => {}, onError, {
      idleTimeoutMs: 5_000,
      // Keep backoff long so only the first attempt runs within the window.
      reconnectBaseDelayMs: 10_000,
      onStreamOpen,
    });

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(onStreamOpen).not.toHaveBeenCalled();
    } finally {
      stream.cancel();
    }
  });
});

describe("subscribeEvents reconnect cursor (resumable stream)", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    mockReconnectCursor = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  // First connect closes the stream cleanly so the transport schedules
  // a reconnect; the second connect is the one that should carry the
  // cursor. Returns the URLs requested in order.
  const captureReconnectUrls = async (): Promise<string[]> => {
    const requestedUrls: string[] = [];
    let callCount = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requestedUrls.push(input instanceof Request ? input.url : String(input));
      callCount++;
      const closeImmediately = callCount === 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            // First attempt ends cleanly (→ reconnect); later attempts
            // stay open so no third connect races into the assertion.
            if (closeImmediately) controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const stream = subscribeEvents(
      "asst-1",
      () => {},
      () => {},
      { idleTimeoutMs: 10_000, reconnectBaseDelayMs: 5 },
    );
    try {
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      stream.cancel();
    }
    return requestedUrls;
  };

  test("cold connect sends lastSeenSeq when anchored at a snapshot watermark", async () => {
    // GIVEN the cursor has been seeded at a snapshot watermark S on a cold
    // session (cold-start anchored replay)
    mockReconnectCursor = 42;

    // WHEN the stream connects for the first time
    const urls = await captureReconnectUrls();

    // THEN the cold connect carries lastSeenSeq=S so the daemon ring-replays
    // events emitted between the /messages snapshot and the stream attaching
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls[0]).toContain("lastSeenSeq=42");
  });

  test("cold connect omits lastSeenSeq when no cursor has been seeded", async () => {
    // GIVEN no watermark has anchored the cursor yet
    mockReconnectCursor = null;

    // WHEN the stream connects for the first time
    const urls = await captureReconnectUrls();

    // THEN the cold connect is cursor-less
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls[0]).not.toContain("lastSeenSeq");
  });

  test("reconnect sends lastSeenSeq when a cursor exists", async () => {
    // GIVEN a non-null cursor
    mockReconnectCursor = 42;

    // WHEN the stream drops and reconnects
    const urls = await captureReconnectUrls();

    // THEN the reconnect URL resumes the global stream from the cursor
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls[1]).toContain("lastSeenSeq=42");
  });

  test("reconnect omits lastSeenSeq when no cursor has been seen yet", async () => {
    // GIVEN no event has seeded the cursor
    mockReconnectCursor = null;

    // WHEN the stream drops and reconnects
    const urls = await captureReconnectUrls();

    // THEN there is nothing to resume from, so the param is omitted
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls[1]).not.toContain("lastSeenSeq");
  });
});
