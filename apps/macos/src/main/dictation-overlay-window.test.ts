import { describe, expect, mock, test } from "bun:test";

import {
  DONE_HIDE_MS,
  ERROR_HIDE_MS,
  createDictationOverlayController,
  positionDictationOverlayInWorkArea,
  type DictationOverlayState,
} from "./dictation-overlay-window";

type Harness = {
  controller: ReturnType<typeof createDictationOverlayController>;
  flushTimers: () => void;
  pendingTimerDelays: () => number[];
  showOverlay: ReturnType<typeof mock>;
  hideOverlay: ReturnType<typeof mock>;
  forwarded: DictationOverlayState[];
};

const createHarness = (): Harness => {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let nextTimerId = 1;
  const showOverlay = mock(() => undefined);
  const hideOverlay = mock(() => undefined);
  const forwarded: DictationOverlayState[] = [];

  const controller = createDictationOverlayController({
    showOverlay,
    hideOverlay,
    forwardState: (state) => {
      forwarded.push(state);
    },
    setTimeout: (callback, ms) => {
      const id = nextTimerId++;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    controller,
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const { callback } of pending) callback();
    },
    pendingTimerDelays: () => [...timers.values()].map((t) => t.ms),
    showOverlay,
    hideOverlay,
    forwarded,
  };
};

describe("createDictationOverlayController", () => {
  test("shows the overlay and forwards live transcription while unfocused", () => {
    const h = createHarness();

    h.controller.handleMessage({
      kind: "recording",
      transcription: "",
      audioLevel: 0,
    });
    h.controller.handleMessage({
      kind: "recording",
      transcription: "hello wor",
      audioLevel: 0.6,
    });
    h.controller.handleMessage({ kind: "processing" });

    expect(h.showOverlay).toHaveBeenCalledTimes(1);
    expect(h.forwarded).toEqual([
      { kind: "recording", transcription: "", audioLevel: 0 },
      { kind: "recording", transcription: "hello wor", audioLevel: 0.6 },
      { kind: "processing" },
    ]);
    expect(h.hideOverlay).not.toHaveBeenCalled();
  });

  test("keeps forwarding updates throughout a visible session", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    h.controller.handleMessage({ kind: "recording", transcription: "still showing" });

    expect(h.showOverlay).toHaveBeenCalledTimes(1);
    expect(h.forwarded).toHaveLength(2);
  });

  test("dismiss hides immediately during recording (cancelled session)", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    h.controller.handleMessage({ kind: "dismiss" });

    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
  });

  test("dismiss without a session is a no-op", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "dismiss" });

    expect(h.hideOverlay).not.toHaveBeenCalled();
  });

  test("done lingers on its own timer and ignores the store's dismiss", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "hi" });
    h.controller.handleMessage({ kind: "processing" });
    h.controller.handleMessage({ kind: "done" });
    expect(h.pendingTimerDelays()).toEqual([DONE_HIDE_MS]);

    h.controller.handleMessage({ kind: "dismiss" });
    expect(h.hideOverlay).not.toHaveBeenCalled();

    h.flushTimers();
    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
  });

  test("error lingers longer than done and ignores dismiss", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    h.controller.handleMessage({ kind: "error", message: "Paste blocked" });
    expect(h.forwarded).toContainEqual({ kind: "error", message: "Paste blocked" });
    expect(h.pendingTimerDelays()).toEqual([ERROR_HIDE_MS]);

    h.controller.handleMessage({ kind: "dismiss" });
    expect(h.hideOverlay).not.toHaveBeenCalled();

    h.flushTimers();
    expect(h.hideOverlay).toHaveBeenCalledTimes(1);
  });

  test("a new recording cancels a pending terminal hide and reuses the session", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    h.controller.handleMessage({ kind: "done" });
    h.controller.handleMessage({ kind: "recording", transcription: "again" });

    expect(h.pendingTimerDelays()).toEqual([]);
    h.flushTimers();
    expect(h.hideOverlay).not.toHaveBeenCalled();
    // Window already visible — no second show needed.
    expect(h.showOverlay).toHaveBeenCalledTimes(1);
    expect(h.forwarded).toContainEqual({ kind: "recording", transcription: "again" });
  });

  test("a session can start again after a terminal hide completes", () => {
    const h = createHarness();

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    h.controller.handleMessage({ kind: "done" });
    h.flushTimers();
    expect(h.hideOverlay).toHaveBeenCalledTimes(1);

    h.controller.handleMessage({ kind: "recording", transcription: "" });
    expect(h.showOverlay).toHaveBeenCalledTimes(2);
  });
});

describe("positionDictationOverlayInWorkArea", () => {
  test("positions the transparent overlay canvas top-center of the display work area", () => {
    expect(
      positionDictationOverlayInWorkArea({
        x: 100,
        y: 50,
        width: 1440,
        height: 900,
      }),
    ).toEqual({
      x: 580,
      y: 50,
    });
  });
});
