import { beforeEach, describe, expect, mock, test } from "bun:test";

import { publish } from "@/lib/event-bus";

const postTelemetryEvents = mock(() => {});
let consent = true;

mock.module("@/lib/telemetry/ingest", () => ({ postTelemetryEvents }));
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

/** The events from the most recent flush. */
function lastBatch(): Array<Record<string, unknown>> {
  const call = postTelemetryEvents.mock.calls.at(-1) as
    | [Array<Record<string, unknown>>]
    | undefined;
  return call?.[0] ?? [];
}

function checkNames(): string[] {
  return lastBatch().map((event) => String(event.check_name));
}

beforeEach(() => {
  __resetBootTelemetryForTests();
  postTelemetryEvents.mockClear();
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
  test("buffers marks and emits one watchdog event per mark on flush", () => {
    startBootTelemetry();
    markBoot("safe_area_ready", { value: 100 });
    markBoot("session_ready", { value: 250 });
    markBoot("react_mount", { value: 300 });

    expect(postTelemetryEvents).not.toHaveBeenCalled();

    flushBootTelemetry();

    const batch = lastBatch();
    expect(batch).toHaveLength(3);
    expect(checkNames()).toEqual([
      "client_boot.safe_area_ready",
      "client_boot.session_ready",
      "client_boot.react_mount",
    ]);
    expect(batch.map((e) => e.value)).toEqual([100, 250, 300]);
    expect(batch.every((e) => e.type === "watchdog")).toBe(true);
  });

  test("first write wins, so a later navigation cannot overwrite a cold mark", () => {
    startBootTelemetry();
    markBoot("transcript_painted", { value: 500 });
    markBoot("transcript_painted", { value: 9_000 });
    flushBootTelemetry();

    const painted = lastBatch().find(
      (e) => e.check_name === "client_boot.transcript_painted",
    );
    expect(painted?.value).toBe(500);
  });

  test("a terminal mark does not flush synchronously, it arms a grace window", async () => {
    // Reaching interactive does not mean the paint vitals have landed: a page
    // that loads hidden defers FCP until it is shown. Flushing on the spot
    // would ship the waterfall with those marks missing.
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    markBoot("transcript_painted", { value: 700 });
    markBoot("chat_interactive", { value: 800 });

    expect(postTelemetryEvents).not.toHaveBeenCalled();

    // A late vital still makes the same batch.
    markBoot("fcp", { value: 2_396 });
    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);

    expect(postTelemetryEvents).toHaveBeenCalledTimes(1);
    expect(checkNames()).toContain("client_boot.chat_interactive");
    expect(checkNames()).toContain("client_boot.fcp");
  });

  test("a slow history fetch is waited for, not flushed past", async () => {
    // `chat_interactive` fires when the assistant goes active, BEFORE the
    // initial history fetch resolves. Closing the boot 3s later would drop
    // `transcript_painted` from exactly the slow loads this baseline exists to
    // measure, biasing the sample backwards.
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });

    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);
    expect(postTelemetryEvents).not.toHaveBeenCalled();

    // History finally resolves well after the grace window would have closed.
    markBoot("transcript_painted", { value: 9_000 });
    await Bun.sleep(TERMINAL_FLUSH_GRACE_MS + 250);

    expect(postTelemetryEvents).toHaveBeenCalledTimes(1);
    expect(checkNames()).toContain("client_boot.transcript_painted");
    expect(checkNames()).toContain("client_boot.chat_interactive");
    // Two grace windows of real time; well inside the 20s boot deadline.
  }, 15_000);

  test("a boot whose transcript never paints still reports, on the deadline", () => {
    // The deadline stays armed while `transcript_painted` is outstanding, so a
    // transcript that never settles cannot silently swallow the whole boot.
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry("deadline");

    expect(checkNames()).toContain("client_boot.chat_interactive");
    expect(
      (lastBatch()[0]?.detail as Record<string, unknown>).flush_trigger,
    ).toBe("deadline");
  });

  test("the flush latch closes the family, so nothing is double-sent", () => {
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry();
    expect(postTelemetryEvents).toHaveBeenCalledTimes(1);

    markBoot("transcript_painted", { value: 900 });
    flushBootTelemetry();

    expect(postTelemetryEvents).toHaveBeenCalledTimes(1);
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

      const batch = lastBatch();
      const byName = new Map(
        batch.map((e) => [String(e.check_name), e.value as number]),
      );
      expect(byName.get("client_boot.ttfb")).toBe(6);
      expect(byName.get("client_boot.dom_content_loaded")).toBe(79);
      expect(byName.get("client_boot.load_event_end")).toBe(81);
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

      expect(checkNames()).toEqual(["client_boot.react_mount"]);
    } finally {
      performance.getEntriesByType = original;
    }
  });
});

describe("units", () => {
  test("a CLS score survives rounding, and durations stay whole ms", () => {
    // Rounding a score to the nearest integer destroys it: a normal CLS of
    // 0.05 becomes 0 and the whole series reads as "no layout shift anywhere".
    startBootTelemetry();
    markBoot("cls", { value: 0.0523 });
    markBoot("react_mount", { value: 300.7 });
    flushBootTelemetry();

    const byName = new Map(
      lastBatch().map((e) => [String(e.check_name), e.value as number]),
    );
    expect(byName.get("client_boot.cls")).toBe(0.052);
    expect(byName.get("client_boot.cls")).not.toBe(0);
    expect(byName.get("client_boot.react_mount")).toBe(301);
  });

  test("every event declares its unit so ms and score never get averaged together", () => {
    startBootTelemetry();
    markBoot("cls", { value: 0.05 });
    markBoot("fcp", { value: 1_200 });
    flushBootTelemetry();

    const byName = new Map(
      lastBatch().map((e) => [
        String(e.check_name),
        (e.detail as Record<string, unknown>).unit,
      ]),
    );
    expect(byName.get("client_boot.cls")).toBe("score");
    expect(byName.get("client_boot.fcp")).toBe("ms");
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

    const terminals = checkNames().filter(
      (n) =>
        n === "client_boot.chat_blocked" ||
        n === "client_boot.chat_interactive",
    );
    expect(terminals).toEqual(["client_boot.chat_blocked"]);
  });

  test("holds in the other order too", () => {
    startBootTelemetry();
    markBoot("chat_interactive", { value: 900 });
    markBootBlocked("stuck_connecting");
    flushBootTelemetry();

    const terminals = checkNames().filter(
      (n) =>
        n === "client_boot.chat_blocked" ||
        n === "client_boot.chat_interactive",
    );
    expect(terminals).toEqual(["client_boot.chat_interactive"]);
  });
});

describe("flush trigger", () => {
  test("distinguishes a settled boot from one cut short or one that stalled", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry("pagehide");

    expect(
      (lastBatch()[0]?.detail as Record<string, unknown>).flush_trigger,
    ).toBe("pagehide");

    __resetBootTelemetryForTests();
    postTelemetryEvents.mockClear();
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry("deadline");

    expect(
      (lastBatch()[0]?.detail as Record<string, unknown>).flush_trigger,
    ).toBe("deadline");
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

    expect(postTelemetryEvents).toHaveBeenCalledTimes(1);
    expect(checkNames()).toEqual(["client_resume.to_sse_open"]);

    // A resume with no reopen: nothing is emitted, ever.
    postTelemetryEvents.mockClear();
    publish("app.resume", { signal: "online" });
    await Bun.sleep(200);

    expect(postTelemetryEvents).not.toHaveBeenCalled();
  });

  test("away_ms is null when no background preceded the resume", () => {
    // `hiddenAt` used to survive every completed resume, so an `online` resume
    // reported the hours since some earlier background as time spent away.
    startBootTelemetry();
    publish("app.hidden", { signal: "app_state" });
    publish("app.resume", { signal: "app_state" });
    publish("sse.opened", { assistantId: "a", cause: "resume" });
    expect(
      (lastBatch()[0]?.detail as Record<string, unknown>).away_ms,
    ).not.toBeNull();

    postTelemetryEvents.mockClear();
    publish("app.resume", { signal: "online" });
    publish("sse.opened", { assistantId: "a", cause: "error" });

    expect(
      (lastBatch()[0]?.detail as Record<string, unknown>).away_ms,
    ).toBeNull();
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

    const away = (lastBatch()[0]?.detail as Record<string, unknown>)
      .away_ms as number;
    expect(checkNames()).toEqual(["client_resume.to_sse_open"]);
    expect(away).toBeGreaterThanOrEqual(0);
    // Measured against the hide that actually preceded this resume, so it is
    // bounded by the gap between them, not by the whole elapsed window.
    expect(away).toBeLessThan(200);
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

    expect(checkNames()).toEqual(["client_resume.to_sse_open"]);
  });

  test("a remount does not start a second boot record", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    startBootTelemetry().call(null);
    startBootTelemetry();
    flushBootTelemetry();

    const bootIds = new Set(
      lastBatch().map(
        (e) => (e.detail as Record<string, unknown>).boot_id as string,
      ),
    );
    expect(bootIds.size).toBe(1);
    expect(checkNames()).toEqual(["client_boot.react_mount"]);
  });
});

describe("markBootBlocked", () => {
  test("records the failure terminal with its reason in detail", () => {
    startBootTelemetry();
    markBootBlocked("stuck_connecting");
    flushBootTelemetry();

    const batch = lastBatch();
    expect(batch).toHaveLength(1);
    expect(batch[0]?.check_name).toBe("client_boot.chat_blocked");
    expect(batch[0]?.detail).toMatchObject({ reason: "stuck_connecting" });
  });

  test("success and failure are distinct check names, not one name with a flag", () => {
    // The success/failure split has to be a plain count comparison in BigQuery,
    // so the two outcomes must never collapse onto the same check name.
    startBootTelemetry();
    markBootBlocked("lifecycle_error");
    flushBootTelemetry();
    const blockedNames = checkNames();

    __resetBootTelemetryForTests();
    postTelemetryEvents.mockClear();
    startBootTelemetry();
    markBoot("chat_interactive", { value: 800 });
    flushBootTelemetry();

    expect(blockedNames).not.toEqual(checkNames());
    expect(blockedNames).toEqual(["client_boot.chat_blocked"]);
    expect(checkNames()).toEqual(["client_boot.chat_interactive"]);
  });
});

describe("consent", () => {
  test("an opt-out drops the batch at flush time", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    consent = false;
    flushBootTelemetry();

    expect(postTelemetryEvents).not.toHaveBeenCalled();
  });

  test("consent is read at send time, not at record time", () => {
    // Recording a mark is not an upload, so the only check that matters is the
    // one immediately before the request. Here it flips the permissive way;
    // the test above covers the direction that actually protects the user, an
    // opt-out landing mid-window and suppressing the whole batch.
    consent = false;
    startBootTelemetry();
    markBoot("safe_area_ready", { value: 100 });
    markBoot("session_ready", { value: 250 });

    consent = true;
    flushBootTelemetry();

    expect(checkNames()).toEqual([
      "client_boot.safe_area_ready",
      "client_boot.session_ready",
    ]);
  });
});

describe("detail bag", () => {
  test("carries shared boot context and stays inside the 4096-byte cap", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    const detail = lastBatch()[0]?.detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      route: expect.any(String),
      surface: expect.any(String),
      os: expect.any(String),
      lcp_supported: expect.any(Boolean),
      cls_supported: expect.any(Boolean),
      unit: "ms",
    });
    expect(typeof detail.boot_id).toBe("string");

    // An unavailable value is `null`, never a `"unknown"` string sentinel:
    // `client-perf.ts` documents that convention for the shared `client_*`
    // families, and a sentinel forces a cast before any aggregation.
    expect(
      detail.nav_type === null || typeof detail.nav_type === "string",
    ).toBe(true);
    expect(detail.nav_type).not.toBe("unknown");

    // Ingest silently drops a single event whose `detail` exceeds this when
    // serialized (WatchdogTelemetryEventSerializer.DETAIL_MAX_JSON_BYTES).
    expect(JSON.stringify(detail).length).toBeLessThan(4096);
  });

  test("every mark in one boot shares a boot_id so the waterfall stitches back together", () => {
    startBootTelemetry();
    markBoot("safe_area_ready", { value: 100 });
    markBoot("session_ready", { value: 250 });
    flushBootTelemetry();

    const bootIds = new Set(
      lastBatch().map(
        (e) => (e.detail as Record<string, unknown>).boot_id as string,
      ),
    );
    expect(bootIds.size).toBe(1);
  });

  test("carries no message, conversation, or assistant identifiers", () => {
    startBootTelemetry();
    markBoot("react_mount", { value: 300 });
    flushBootTelemetry();

    const detail = lastBatch()[0]?.detail as Record<string, unknown>;
    for (const key of Object.keys(detail)) {
      expect(key).not.toMatch(/conversation|assistant|message|user|path|url/i);
    }
  });
});
