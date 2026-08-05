/**
 * Pins the conversation-switch paint measurement:
 *   - one sample per opened window: painted, stalled, or abandoned, never two
 *   - a paint for a different conversation leaves the window open
 *   - every way a switch can end early emits its own abandon reason, so the
 *     three series together cover every attempt
 *   - `useSwitchPaintMeasurement` observes a switch whose incoming transcript
 *     was already cached, and abandons anything still open on unmount
 *   - no emitted detail carries a conversation id
 *
 * The emitter itself is mocked: its envelope, consent gate, and surface labels
 * are `client-perf`'s contract and are pinned by `client-perf.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

const emitClientPerfEventMock = mock(
  (
    _checkName: string,
    _value: number,
    _detail?: Record<string, unknown>,
  ): void => {},
);

mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: emitClientPerfEventMock,
  setClientPerfBootId: () => {},
  __resetClientPerfForTests: () => {},
}));

const { publish, __resetForTesting } = await import("@/lib/event-bus");
const {
  __resetSwitchTelemetryForTests,
  abandonSwitchMeasurement,
  noteConversationSwitchStarted,
  noteSwitchTranscriptPainted,
  subscribeSwitchTelemetry,
  useSwitchPaintMeasurement,
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

type Sample = {
  checkName: string;
  value: number;
  detail: Record<string, unknown>;
};

function emittedSamples(): Sample[] {
  return emitClientPerfEventMock.mock.calls.map((call) => ({
    checkName: call[0],
    value: call[1],
    detail: call[2] ?? {},
  }));
}

function onlySample(): Sample {
  const samples = emittedSamples();
  expect(samples).toHaveLength(1);
  return samples[0]!;
}

type PaintProps = {
  conversationId: string | null;
  historyLoadFailed: boolean;
  transcriptPainted: boolean;
  hadHistory: boolean;
};

const PAINTED_PROPS: PaintProps = {
  conversationId: "conv-1",
  historyLoadFailed: false,
  transcriptPainted: true,
  hadHistory: true,
};

function renderPaintMeasurement(props: PaintProps) {
  return renderHook(
    (current: PaintProps) => useSwitchPaintMeasurement(current),
    {
      initialProps: props,
    },
  );
}

beforeEach(() => {
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
  emitClientPerfEventMock.mockClear();
  __resetForTesting();
  __resetSwitchTelemetryForTests();
});

afterEach(() => {
  cleanup();
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

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.transcript_painted");
    expect(sample.value).toBe(412);
    expect(sample.detail.had_history).toBe(true);
  });

  test("labels an empty incoming conversation with had_history false", () => {
    noteConversationSwitchStarted("conv-1");
    noteSwitchTranscriptPainted("conv-1", { hadHistory: false });

    expect(onlySample().detail.had_history).toBe(false);
  });

  test("ignores a paint for a different conversation and keeps the window", () => {
    noteConversationSwitchStarted("conv-1");
    noteSwitchTranscriptPainted("conv-2", { hadHistory: true });
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();

    clock += 50;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(onlySample().value).toBe(50);
  });

  test("a re-switch closes the previous window as superseded", () => {
    noteConversationSwitchStarted("conv-1");
    clock += 90;
    noteConversationSwitchStarted("conv-2");

    const superseded = onlySample();
    expect(superseded.checkName).toBe("client_switch.abandoned");
    expect(superseded.value).toBe(90);
    expect(superseded.detail.reason).toBe("superseded");

    // The superseded window is gone: only the newest one can still paint.
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emittedSamples()).toHaveLength(1);

    clock += 10;
    noteSwitchTranscriptPainted("conv-2", { hadHistory: true });
    expect(emittedSamples()[1]!.value).toBe(10);
  });

  test("emits one stall sample when the window outlives its TTL", () => {
    noteConversationSwitchStarted("conv-1");
    runScheduledTimers();

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.stalled");
    expect(sample.value).toBe(15_000);
    expect(sample.detail.reason).toBe("timeout");

    // The stall closed the window: a late paint is not a second sample.
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emittedSamples()).toHaveLength(1);
  });

  test("a paint cancels the stall so a switch never reports both", () => {
    noteConversationSwitchStarted("conv-1");
    clock += 200;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    runScheduledTimers();

    expect(onlySample().checkName).toBe("client_switch.transcript_painted");
  });

  test("app.hidden abandons the pending sample as hidden", () => {
    const unsubscribe = subscribeSwitchTelemetry();
    noteConversationSwitchStarted("conv-1");
    clock += 70;
    publish("app.hidden", { signal: "visibility" });

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.abandoned");
    expect(sample.value).toBe(70);
    expect(sample.detail.reason).toBe("hidden");

    // The window went with it, so neither a stall nor a late paint follows.
    runScheduledTimers();
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emittedSamples()).toHaveLength(1);

    unsubscribe();
  });

  test("unsubscribing drops a pending window with no sample and no stall", () => {
    const unsubscribe = subscribeSwitchTelemetry();
    noteConversationSwitchStarted("conv-1");
    unsubscribe();

    runScheduledTimers();
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
  });

  test("a context change abandons the window and cancels its stall", () => {
    // The store takes this branch for assistant switches and for re-entering
    // the same conversation; draft-key resolution has its own reason.
    noteConversationSwitchStarted("conv-1");
    clock += 300;
    abandonSwitchMeasurement("context_change");

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.abandoned");
    expect(sample.value).toBe(300);
    expect(sample.detail.reason).toBe("context_change");

    runScheduledTimers();
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(emittedSamples()).toHaveLength(1);
  });

  test("abandoning with no pending window emits nothing", () => {
    abandonSwitchMeasurement("unmount");
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();

    noteConversationSwitchStarted("conv-1");
    clock += 40;
    noteSwitchTranscriptPainted("conv-1", { hadHistory: true });
    expect(onlySample().value).toBe(40);
  });

  test("never puts a conversation id in an emitted detail bag", () => {
    noteConversationSwitchStarted("conv-secret-1");
    clock += 5;
    noteSwitchTranscriptPainted("conv-secret-1", { hadHistory: true });
    noteConversationSwitchStarted("conv-secret-2");
    abandonSwitchMeasurement("hidden");
    noteConversationSwitchStarted("conv-secret-3");
    runScheduledTimers();

    const samples = emittedSamples();
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      const serialized = JSON.stringify(sample.detail);
      expect(serialized).not.toContain("conv-secret-");
      for (const key of Object.keys(sample.detail)) {
        expect(key).not.toContain("conversation");
        expect(key).not.toContain("assistant");
      }
    }
  });
});

describe("useSwitchPaintMeasurement", () => {
  test("reports the paint for the conversation it renders", () => {
    const { rerender } = renderPaintMeasurement({
      ...PAINTED_PROPS,
      transcriptPainted: false,
    });
    noteConversationSwitchStarted("conv-1");
    clock += 120;
    rerender(PAINTED_PROPS);

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.transcript_painted");
    expect(sample.value).toBe(120);
    expect(sample.detail.had_history).toBe(true);
  });

  test("closes a window whose incoming transcript was already cached", () => {
    // A cache-warm switch batches the transcript reset and the cached snapshot
    // into one commit, so the panel can re-render with every observed value
    // identical. The window still has to close, or the TTL bills an instant
    // switch as a stall.
    const { rerender } = renderPaintMeasurement(PAINTED_PROPS);
    expect(emitClientPerfEventMock).not.toHaveBeenCalled();

    noteConversationSwitchStarted("conv-1");
    clock += 8;
    rerender(PAINTED_PROPS);

    expect(onlySample().checkName).toBe("client_switch.transcript_painted");

    runScheduledTimers();
    expect(emittedSamples()).toHaveLength(1);
  });

  test("a failed history load abandons the window instead of painting", () => {
    const { rerender } = renderPaintMeasurement({
      ...PAINTED_PROPS,
      transcriptPainted: false,
    });
    noteConversationSwitchStarted("conv-1");
    clock += 250;
    rerender({
      conversationId: "conv-1",
      historyLoadFailed: true,
      transcriptPainted: true,
      hadHistory: false,
    });

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.abandoned");
    expect(sample.value).toBe(250);
    expect(sample.detail.reason).toBe("history_error");

    // The stall timer went with it, so the failure never lands as a slow switch.
    runScheduledTimers();
    expect(emittedSamples()).toHaveLength(1);
  });

  test("unmounting abandons a window that is still open", () => {
    const { unmount } = renderPaintMeasurement({
      ...PAINTED_PROPS,
      transcriptPainted: false,
    });
    noteConversationSwitchStarted("conv-1");
    clock += 33;
    unmount();

    const sample = onlySample();
    expect(sample.checkName).toBe("client_switch.abandoned");
    expect(sample.value).toBe(33);
    expect(sample.detail.reason).toBe("unmount");

    runScheduledTimers();
    expect(emittedSamples()).toHaveLength(1);
  });

  test("renders with no active conversation without touching the window", () => {
    const { rerender } = renderPaintMeasurement({
      ...PAINTED_PROPS,
      conversationId: null,
    });
    noteConversationSwitchStarted("conv-1");
    rerender({ ...PAINTED_PROPS, conversationId: null });

    expect(emitClientPerfEventMock).not.toHaveBeenCalled();
  });
});
