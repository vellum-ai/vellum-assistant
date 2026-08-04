/**
 * Pins the conversation-switch paint measurement:
 *   - one sample per switch, painted or stalled, never both
 *   - a paint for a different conversation leaves the window open
 *   - a re-switch supersedes the pending sample silently
 *   - `app.hidden` abandons it so backgrounded switches never land
 *   - a failed history load abandons it: neither a paint nor a stall
 *   - nothing is emitted without analytics consent
 *   - no emitted detail carries a conversation id
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let consent = true;
const postTelemetryEventsMock = mock((_events: readonly object[]) => {});

mock.module("@/lib/telemetry/consent", () => ({
  readAnalyticsConsent: () => consent,
}));
mock.module("@/lib/telemetry/ingest", () => ({
  postTelemetryEvents: postTelemetryEventsMock,
}));

const { publish, __resetForTesting } = await import("@/lib/event-bus");
const {
  __resetSwitchTelemetryForTests,
  abandonSwitchMeasurement,
  noteConversationSwitchStarted,
  noteSwitchTranscriptPainted,
  subscribeSwitchTelemetry,
} = await import("./switch-telemetry");

// The module reads `performance.now()` for elapsed time and schedules the TTL
// on `setTimeout`; both are driven from the test so the 15s window is
// exercised without real waiting.
let clock = 0;
let realNow: () => number;
let realSetTimeout: typeof globalThis.setTimeout;
let realClearTimeout: typeof globalThis.clearTimeout;
let timers = new Map<number, () => void>();
let nextTimerId = 1;

function runScheduledTimers(): void {
  const due = [...timers.values()];
  timers.clear();
  for (const fn of due) {
    fn();
  }
}

function emittedEvents(): Record<string, unknown>[] {
  return postTelemetryEventsMock.mock.calls.flatMap(
    (call) => call[0] as Record<string, unknown>[],
  );
}

function onlyEvent(): Record<string, unknown> {
  const events = emittedEvents();
  expect(events).toHaveLength(1);
  return events[0]!;
}

beforeEach(() => {
  consent = true;
  clock = 1_000;
  timers = new Map();
  nextTimerId = 1;
  realNow = performance.now.bind(performance);
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  performance.now = () => clock;
  globalThis.setTimeout = ((fn: () => void) => {
    const id = nextTimerId++;
    timers.set(id, fn);
    return id;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) {
      timers.delete(id);
    }
  }) as unknown as typeof globalThis.clearTimeout;
  postTelemetryEventsMock.mockClear();
  __resetForTesting();
  __resetSwitchTelemetryForTests();
});

afterEach(() => {
  performance.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  __resetForTesting();
  __resetSwitchTelemetryForTests();
});

describe("switch telemetry", () => {
  test("emits the elapsed paint time for the switched-to conversation", () => {
    noteConversationSwitchStarted("conv-1");
    clock += 412;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });

    const event = onlyEvent();
    expect(event.check_name).toBe("client_switch.transcript_painted");
    expect(event.value).toBe(412);
    expect((event.detail as Record<string, unknown>).had_history).toBe("true");
  });

  test("labels an empty incoming conversation with had_history false", () => {
    noteConversationSwitchStarted("conv-1");
    noteSwitchTranscriptPainted("conv-1", { hadHistory: false });

    expect((onlyEvent().detail as Record<string, unknown>).had_history).toBe(
      "false",
    );
  });

  test("ignores a paint for a different conversation and keeps the window", () => {
    noteConversationSwitchStarted("conv-1");
    noteSwitchTranscriptPainted("conv-2", { hadHistory: true });
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    clock += 50;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(onlyEvent().value).toBe(50);
  });

  test("a re-switch supersedes the pending sample without emitting", () => {
    noteConversationSwitchStarted("conv-1");
    clock += 90;
    noteConversationSwitchStarted("conv-2");
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    clock += 10;
    noteSwitchTranscriptPainted("conv-2", { hadHistory: true });
    expect(onlyEvent().value).toBe(10);
  });

  test("emits one stall sample when the window outlives its TTL", () => {
    noteConversationSwitchStarted("conv-1");
    runScheduledTimers();

    const event = onlyEvent();
    expect(event.check_name).toBe("client_switch.stalled");
    expect(event.value).toBe(15_000);
    expect((event.detail as Record<string, unknown>).reason).toBe("timeout");

    // The stall closed the window: a late paint is not a second sample.
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emittedEvents()).toHaveLength(1);
  });

  test("a paint cancels the stall so a switch never reports both", () => {
    noteConversationSwitchStarted("conv-1");
    clock += 200;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    runScheduledTimers();

    expect(onlyEvent().check_name).toBe("client_switch.transcript_painted");
  });

  test("app.hidden abandons the pending sample silently", () => {
    const unsubscribe = subscribeSwitchTelemetry();
    noteConversationSwitchStarted("conv-1");
    publish("app.hidden", { signal: "visibility" });
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    runScheduledTimers();
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    unsubscribe();
  });

  test("a failed history load abandons the window without a sample", () => {
    // The panel calls this on the error path instead of reporting a paint.
    noteConversationSwitchStarted("conv-1");
    clock += 300;
    abandonSwitchMeasurement();
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();

    // The stall timer went with it, so the failure never lands as a slow switch.
    runScheduledTimers();
    noteSwitchTranscriptPainted("conv-1", { hadHistory: false });
    expect(postTelemetryEventsMock).not.toHaveBeenCalled();
  });

  test("abandoning with no pending window is a no-op", () => {
    abandonSwitchMeasurement();
    noteConversationSwitchStarted("conv-1");
    clock += 40;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });

    expect(onlyEvent().value).toBe(40);
  });

  test("emits nothing without analytics consent", () => {
    consent = false;
    noteConversationSwitchStarted("conv-1");
    clock += 100;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    runScheduledTimers();

    expect(postTelemetryEventsMock).not.toHaveBeenCalled();
  });

  test("never puts a conversation id in an emitted detail bag", () => {
    noteConversationSwitchStarted("conv-secret-1");
    clock += 5;
    noteSwitchTranscriptPainted("conv-secret-1", { hadHistory: true });
    noteConversationSwitchStarted("conv-secret-2");
    runScheduledTimers();

    const events = emittedEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      const serialized = JSON.stringify(event.detail);
      expect(serialized).not.toContain("conv-secret-1");
      expect(serialized).not.toContain("conv-secret-2");
      for (const key of Object.keys(event.detail as Record<string, unknown>)) {
        expect(key).not.toContain("conversation");
        expect(key).not.toContain("assistant");
      }
    }
  });
});
