import { beforeEach, describe, expect, mock, test } from "bun:test";

import { publish } from "@/lib/event-bus";

interface SentEvent {
  checkName: string;
  value: number | null;
  detail: Record<string, unknown>;
  daemonEventId?: string;
}

const sendClientWatchdogEvent = mock((_event: SentEvent) => {});
const setClientPerfBootId = mock((_id: string) => {});
let consent = true;

// A complete factory rather than a spread of the actual module: the real
// `client-perf.ts` is the transport layer, and importing it here would drag
// the daemon SDK client graph into a test that never sends anything.
mock.module("@/lib/telemetry/client-perf", () => ({
  sendClientWatchdogEvent,
  setClientPerfBootId,
  emitClientPerfEvent: mock(() => {}),
  __resetClientPerfForTests: mock(() => {}),
}));
mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => consent,
}));

const {
  __resetBootTelemetryForTests,
  bootRouteLabel,
  flushBootTelemetry,
  markBoot,
  markBootBlocked,
  startBootTelemetry,
  TERMINAL_FLUSH_GRACE_MS,
} = await import("@/lib/telemetry/boot-telemetry");

function lastSent(): SentEvent {
  const call = sendClientWatchdogEvent.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0];
}

/** The single `client_boot` event from the most recent flush. */
function bootEvent(): SentEvent {
  const event = lastSent();
  expect(event.checkName).toBe("client_boot");
  return event;
}

/** The per-mark duration map inside the boot event's detail. */
function bootMarks(): Record<string, number> {
  return bootEvent().detail.marks as Record<string, number>;
}

beforeEach(() => {
  __resetBootTelemetryForTests();
  sendClientWatchdogEvent.mockClear();
  setClientPerfBootId.mockClear();
  consent = true;
});

describe("bootRouteLabel", () => {
  test("distinguishes the new-conversation draft from an existing conversation", () => {
    expect(bootRouteLabel("/assistant")).toBe("new_conversation");
    expect(bootRouteLabel("/assistant/")).toBe("new_conversation");
    expect(bootRouteLabel("/assistant/conversations/abc-123")).toBe(
      "conversation",
    );
  });

  test("never lets an id or query string reach the wire", () => {
    // The whole point of a closed label set: a conversation id in the path
    // must not survive into `detail.route`.
    const id = "3f0c2b4e-0000-4444-8888-aaaaaaaaaaaa";
    for (const path of [
      `/assistant/conversations/${id}`,
      `/assistant/conversations/${id}/inspect`,
      `/assistant/settings/${id}`,
      `/account/login`,
      `/assistant/some/unmapped/${id}`,
    ]) {
      expect(bootRouteLabel(path)).not.toContain(id);
    }
    expect(bootRouteLabel(`/assistant/conversations/${id}/inspect`)).toBe(
      "conversation_inspect",
    );
    expect(bootRouteLabel("/assistant/some/unmapped/path")).toBe("other");
  });
});

describe("markBoot", () => {
  test("buffers marks and flushes ONE event carrying the whole waterfall", () => {
    startBootTelemetry();
    markBoot("safe_area_ready", { value: 100 });
    markBoot("session_ready", { value: 250 });
    markBoot("react_mount", { value: 300 });

    expect(sendClientWatchdogEvent).not.toHaveBeenCalled();

    flushBootTelemetry();

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(bootMarks()).toMatchObject({
      safe_area_ready: 100,
      session_ready: 250,
      react_mount: 300,
    });
    // No terminal mark landed, so the boot has no scalar and no outcome.
    expect(bootEvent().value).toBeNull();
    expect(bootEvent().detail.outcome).toBeNull();
  });

  test("first write wins, so a later navigation cannot overwrite a cold mark", () => {
    startBootTelemetry();
    markBoot("transcript_painted", { value: 500 });
    markBoot("transcript_painted", { value: 9_000 });
    flushBootTelemetry();

    expect(bootMarks().transcript_painted).toBe(500);
  });

  test("a terminal mark does not flush synchronously, it arms a grace window", async () => {
    // Reaching interactive does not mean the paint vitals have landed: a page
    // that loads hidden defers FCP until it is shown. Flushing on the spot
    // would ship the waterfall with those marks missing.
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    markBoot("transcript_painted", { value: 700 });
    markBoot("chat_interactive", { value: 800 });

    expect(sendClientWatchdogEvent).not.toHaveBeenCalled();

    // A late vital still makes the same waterfall.
    markBoot("fcp", { value: 2_396 });
    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(bootMarks()).toMatchObject({ chat_interactive: 800, fcp: 2_396 });
  });

  test("a slow history fetch is waited for, not flushed past", async () => {
    // `chat_interactive` fires when the assistant goes active, BEFORE the
    // initial history fetch resolves. Closing the boot 3s later would drop
    // `transcript_painted` from exactly the slow loads this baseline exists to
    // measure, biasing the sample backwards.
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });

    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);
    expect(sendClientWatchdogEvent).not.toHaveBeenCalled();

    // History finally resolves well after the grace window would have closed.
    markBoot("transcript_painted", { value: 9_000 });
    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(bootMarks()).toMatchObject({
      chat_interactive: 800,
      transcript_painted: 9_000,
    });
    // Two grace windows of real time; well inside the 20s boot deadline.
  }, 15_000);

  test("a boot whose transcript never paints still reports, on the deadline", () => {
    // The deadline stays armed while `transcript_painted` is outstanding, so a
    // transcript that never settles cannot silently swallow the whole boot.
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry("deadline");

    expect(bootMarks()).toMatchObject({ chat_interactive: 800 });
    expect(bootEvent().detail.flush_trigger).toBe("deadline");
  });

  test("the flush latch closes the family, so nothing is double-sent", () => {
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry();
    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);

    markBoot("transcript_painted", { value: 900 });
    flushBootTelemetry();

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
  });
});

describe("navigation timing", () => {
  test("is re-read at flush, so marks that were still 0 at startup are not lost", () => {
    // Verified against a real page load: `domContentLoadedEventEnd` and
    // `loadEventEnd` are 0 when a React effect runs, and non-zero once the
    // document finishes. A startup-only read drops both permanently.
    const nav = {
      entryType: "navigation",
      type: "navigate",
      responseStart: 6,
      domContentLoadedEventEnd: 0,
      loadEventEnd: 0,
    };
    const original = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = ((entryType: string) =>
      entryType === "navigation"
        ? [nav]
        : original(entryType)) as typeof performance.getEntriesByType;

    try {
      startBootTelemetry();
      // The document finishes loading after boot telemetry started.
      nav.domContentLoadedEventEnd = 79;
      nav.loadEventEnd = 81;
      flushBootTelemetry();

      expect(bootMarks()).toMatchObject({
        ttfb: 6,
        dom_content_loaded: 79,
        load_event_end: 81,
      });
    } finally {
      performance.getEntriesByType = original;
    }
  });

  test("a zero reading is treated as unmeasurable, never as a real 0ms", () => {
    const nav = {
      entryType: "navigation",
      type: "navigate",
      responseStart: 0,
      domContentLoadedEventEnd: 0,
      loadEventEnd: 0,
    };
    const original = performance.getEntriesByType.bind(performance);
    performance.getEntriesByType = ((entryType: string) =>
      entryType === "navigation"
        ? [nav]
        : original(entryType)) as typeof performance.getEntriesByType;

    try {
      startBootTelemetry();
      markBoot("react_mount", { value: 300 });
      flushBootTelemetry();

      expect(Object.keys(bootMarks())).toEqual(["react_mount"]);
    } finally {
      performance.getEntriesByType = original;
    }
  });
});

describe("units", () => {
  test("the CLS score keeps decimals in its own field, apart from the ms marks", () => {
    // Rounding a score to the nearest integer destroys it: a normal CLS of
    // 0.05 becomes 0 and the whole series reads as "no layout shift anywhere".
    // Keeping it out of the duration map means nobody can average ms with a
    // score by iterating `marks`.
    startBootTelemetry();
    markBoot("cls", { value: 0.0523 });
    markBoot("react_mount", { value: 300.7 });
    flushBootTelemetry();

    expect(bootEvent().detail.cls).toBe(0.052);
    expect(bootEvent().detail.cls).not.toBe(0);
    expect(bootMarks().react_mount).toBe(301);
    expect(bootMarks()).not.toHaveProperty("cls");
  });

  test("cls is null, not absent or zero, when the engine never reported one", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    expect(bootEvent().detail.cls).toBeNull();
  });
});

describe("terminal exclusivity", () => {
  test("a boot records exactly one outcome, even if both are reported", () => {
    // A lifecycle that passes through a non-interactive screen on its way to
    // chat must not land in both the numerator and the denominator of the same
    // success rate.
    startBootTelemetry();
    markBootBlocked("lifecycle_error");
    markBoot("chat_interactive", { value: 900 });
    flushBootTelemetry();

    expect(bootEvent().detail.outcome).toBe("blocked");
    expect(bootMarks()).not.toHaveProperty("chat_interactive");
  });

  test("holds in the other order too", () => {
    startBootTelemetry();
    markBoot("chat_interactive", { value: 900 });
    markBootBlocked("stuck_connecting");
    flushBootTelemetry();

    expect(bootEvent().detail.outcome).toBe("interactive");
    expect(bootEvent().value).toBe(900);
    expect(bootEvent().detail.blocked_reason).toBeNull();
    expect(bootMarks()).not.toHaveProperty("chat_blocked");
  });
});

describe("flush trigger", () => {
  test("distinguishes a settled boot from one cut short or one that stalled", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry("pagehide");

    expect(bootEvent().detail.flush_trigger).toBe("pagehide");

    __resetBootTelemetryForTests();
    sendClientWatchdogEvent.mockClear();
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry("deadline");

    expect(bootEvent().detail.flush_trigger).toBe("deadline");
  });
});

describe("resume", () => {
  test("measures an observed reopen, and stays silent when none was needed", async () => {
    // `sse-service` does not reopen (so does not publish `sse.opened`) when the
    // socket was never torn down: a short hide inside the teardown grace
    // window, or an `online` resume while the stream is live. Reporting a
    // failure on that silence would fill the denominator with healthy resumes.
    startBootTelemetry();
    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "a", cause: "resume" });

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(lastSent().checkName).toBe("client_resume.to_sse_open");

    // A resume with no reopen: nothing is emitted, ever.
    sendClientWatchdogEvent.mockClear();
    publish("app.resume", { signal: "online" });
    await Bun.sleep(200);

    expect(sendClientWatchdogEvent).not.toHaveBeenCalled();
  });

  test("away_ms is null when no background preceded the resume", () => {
    // `hiddenAt` used to survive every completed resume, so an `online` resume
    // reported the hours since some earlier background as time spent away.
    startBootTelemetry();
    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "a", cause: "resume" });
    expect(lastSent().detail.away_ms).not.toBeNull();

    sendClientWatchdogEvent.mockClear();
    publish("app.resume", { signal: "online" });
    publish("sse.opened", { assistantId: "a", cause: "error" });

    expect(lastSent().detail.away_ms).toBeNull();
  });

  test("a second hide during a pending resume cannot corrupt away_ms", async () => {
    // A pending measurement can outlive a second hide: the user foregrounds,
    // the socket has not reopened, and they background again before it does.
    // Reading `hiddenAt` at emit time would subtract the LATER hide from the
    // EARLIER resume and report a negative interval.
    startBootTelemetry();
    publish("app.hidden", { signal: "app_state" });
    await Bun.sleep(20);
    publish("app.resume", { signal: "app_state" }); // interval opens here
    await Bun.sleep(20);
    publish("app.hidden", { signal: "app_state" }); // second hide, still pending
    await Bun.sleep(20);
    publish("sse.opened", { assistantId: "a", cause: "resume" });

    expect(lastSent().checkName).toBe("client_resume.to_sse_open");
    const away = lastSent().detail.away_ms as number;
    expect(away).toBeGreaterThanOrEqual(0);
    // Measured against the hide that actually preceded this resume, so it is
    // bounded by the gap between them, not by the whole elapsed window.
    expect(away).toBeLessThan(200);
  });

  test("shares the boot's id so the two families stitch together", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();
    const bootId = bootEvent().detail.boot_id;
    expect(typeof bootId).toBe("string");

    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "a", cause: "resume" });

    expect(lastSent().detail.boot_id).toBe(bootId);
  });
});

describe("registration lifetime", () => {
  test("survives a StrictMode remount", () => {
    // The caller is a React effect under StrictMode, which runs setup, cleanup,
    // setup in development. A teardown that detached the observers but left the
    // latch set left dev builds with no paint marks, no sse_open, no resume
    // tracking, and no flush on leave.
    const teardown = startBootTelemetry();
    teardown();
    startBootTelemetry();

    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "a", cause: "resume" });

    expect(lastSent().checkName).toBe("client_resume.to_sse_open");
  });

  test("a remount does not start a second boot record", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    startBootTelemetry().call(null);
    startBootTelemetry();
    flushBootTelemetry();

    expect(sendClientWatchdogEvent).toHaveBeenCalledTimes(1);
    expect(setClientPerfBootId).toHaveBeenCalledTimes(1);
    expect(Object.keys(bootMarks())).toEqual(["react_mount"]);
  });
});

describe("markBootBlocked", () => {
  test("records the failure terminal with its reason at the top level", () => {
    startBootTelemetry();
    markBootBlocked("stuck_connecting");
    flushBootTelemetry();

    expect(bootEvent().detail.outcome).toBe("blocked");
    expect(bootEvent().detail.blocked_reason).toBe("stuck_connecting");
    expect(bootMarks()).toHaveProperty("chat_blocked");
    // The terminal mark's time is the boot's scalar even on failure, so
    // time-to-failure is aggregable alongside time-to-interactive.
    expect(typeof bootEvent().value).toBe("number");
  });

  test("success and failure are distinct outcomes, not one value with a flag", () => {
    // The success/failure split has to be a plain field comparison in
    // BigQuery, so the two outcomes must never collapse onto the same shape.
    startBootTelemetry();
    markBootBlocked("lifecycle_error");
    flushBootTelemetry();
    const blocked = bootEvent().detail.outcome;

    __resetBootTelemetryForTests();
    sendClientWatchdogEvent.mockClear();
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry();

    expect(blocked).toBe("blocked");
    expect(bootEvent().detail.outcome).toBe("interactive");
  });
});

describe("consent", () => {
  test("an opt-out drops the event at flush time", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    consent = false;
    flushBootTelemetry();

    expect(sendClientWatchdogEvent).not.toHaveBeenCalled();
  });

  test("consent is read at send time, not at record time", () => {
    // Recording a mark is not an upload, so the only check that matters is the
    // one immediately before the request. Here it flips the permissive way;
    // the test above covers the direction that actually protects the user, an
    // opt-out landing mid-window and suppressing the whole event.
    consent = false;
    startBootTelemetry();
    markBoot("safe_area_ready", { value: 100 });
    markBoot("session_ready", { value: 250 });

    consent = true;
    flushBootTelemetry();

    expect(bootMarks()).toMatchObject({
      safe_area_ready: 100,
      session_ready: 250,
    });
  });
});

describe("the boot event", () => {
  test("carries shared boot context and stays inside the 4096-byte cap", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    const detail = bootEvent().detail;
    expect(detail).toMatchObject({
      route: expect.any(String),
      surface: expect.any(String),
      os: expect.any(String),
      lcp_supported: expect.any(Boolean),
      cls_supported: expect.any(Boolean),
    });
    expect(typeof detail.boot_id).toBe("string");

    // An unavailable value is `null`, never a `"unknown"` string sentinel:
    // `client-perf.ts` documents that convention for the shared `client_*`
    // families, and a sentinel forces a cast before any aggregation.
    expect(
      detail.nav_type === null || typeof detail.nav_type === "string",
    ).toBe(true);
    expect(detail.nav_type).not.toBe("unknown");

    // Ingest rejects a single event whose `detail` exceeds this when
    // serialized (WatchdogTelemetryEventSerializer.DETAIL_MAX_JSON_BYTES).
    expect(JSON.stringify(detail).length).toBeLessThan(4096);
  });

  test("carries a deterministic collapse key derived from the boot id", () => {
    // A double send of the same boot must collapse downstream instead of
    // counting twice.
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    expect(bootEvent().daemonEventId).toBe(
      `client_boot:${String(bootEvent().detail.boot_id)}`,
    );
  });

  test("carries no message, conversation, or assistant identifiers", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    for (const key of Object.keys(bootEvent().detail)) {
      expect(key).not.toMatch(/conversation|assistant|message|user|path|url/i);
    }
  });
});
