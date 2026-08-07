import { describe, expect, mock, test } from "bun:test";

import {
  DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL,
  DONE_HIDE_MS,
  ERROR_HIDE_MS,
  createDictationOverlayController,
  createRoutedDictationDeps,
  positionDictationOverlayInWorkArea,
  type DictationOverlayDeps,
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

/**
 * Which surface draws the session.
 *
 * The companion surface is the dictation HUD whenever it is on screen, and the
 * top-center overlay is the fallback for a user who is not targeted by the flag
 * or has hidden the surface from the tray. Both are never up at once describing
 * the same session, which is the whole reason this routes rather than fanning
 * out.
 */
describe("createRoutedDictationDeps", () => {
  const createRouted = (canHost: () => boolean) => {
    const base = {
      showOverlay: mock(() => undefined),
      hideOverlay: mock(() => undefined),
      forwardState: mock(() => undefined),
      setTimeout: (callback: () => void) => callback as unknown,
      clearTimeout: () => undefined,
    } satisfies DictationOverlayDeps;
    const host = {
      canHost,
      begin: mock(() => undefined),
      forward: mock(() => undefined),
      end: mock(() => undefined),
    };
    return { base, host, deps: createRoutedDictationDeps(base, host) };
  };

  const RECORDING: DictationOverlayState = {
    kind: "recording",
    transcription: "hi",
  };

  test("draws on the host while it is on screen", () => {
    const { base, host, deps } = createRouted(() => true);

    deps.showOverlay();
    deps.forwardState(RECORDING);
    deps.hideOverlay();

    expect(host.begin).toHaveBeenCalledTimes(1);
    expect(host.forward).toHaveBeenCalledWith(RECORDING);
    expect(host.end).toHaveBeenCalledTimes(1);
    expect(base.showOverlay).not.toHaveBeenCalled();
    expect(base.forwardState).not.toHaveBeenCalled();
    expect(base.hideOverlay).not.toHaveBeenCalled();
  });

  test("falls back to the overlay when the host is not on screen", () => {
    const { base, host, deps } = createRouted(() => false);

    deps.showOverlay();
    deps.forwardState(RECORDING);
    deps.hideOverlay();

    expect(base.showOverlay).toHaveBeenCalledTimes(1);
    expect(base.forwardState).toHaveBeenCalledWith(RECORDING);
    expect(base.hideOverlay).toHaveBeenCalledTimes(1);
    expect(host.begin).not.toHaveBeenCalled();
  });

  test("with no host at all, everything goes to the overlay", () => {
    const base = {
      showOverlay: mock(() => undefined),
      hideOverlay: mock(() => undefined),
      forwardState: mock(() => undefined),
      setTimeout: (callback: () => void) => callback as unknown,
      clearTimeout: () => undefined,
    } satisfies DictationOverlayDeps;
    const deps = createRoutedDictationDeps(base, undefined);

    deps.showOverlay();
    deps.hideOverlay();

    expect(base.showOverlay).toHaveBeenCalledTimes(1);
    expect(base.hideOverlay).toHaveBeenCalledTimes(1);
  });

  // The two cases the latch exists for. A surface that appears or disappears
  // mid-session must not split it across both windows, which would leave
  // whichever one never got its end sitting there for good.
  test("a host that disappears mid-session still finishes the session", () => {
    let onScreen = true;
    const { base, host, deps } = createRouted(() => onScreen);

    deps.showOverlay();
    onScreen = false;
    deps.forwardState(RECORDING);
    deps.hideOverlay();

    expect(host.forward).toHaveBeenCalledWith(RECORDING);
    expect(host.end).toHaveBeenCalledTimes(1);
    expect(base.hideOverlay).not.toHaveBeenCalled();
  });

  test("a host that appears mid-session does not steal the running one", () => {
    let onScreen = false;
    const { base, host, deps } = createRouted(() => onScreen);

    deps.showOverlay();
    onScreen = true;
    deps.forwardState(RECORDING);
    deps.hideOverlay();

    expect(base.forwardState).toHaveBeenCalledWith(RECORDING);
    expect(base.hideOverlay).toHaveBeenCalledTimes(1);
    expect(host.begin).not.toHaveBeenCalled();
    expect(host.end).not.toHaveBeenCalled();
  });

  test("the next session re-decides", () => {
    let onScreen = false;
    const { base, host, deps } = createRouted(() => onScreen);

    deps.showOverlay();
    deps.hideOverlay();
    onScreen = true;
    deps.showOverlay();

    expect(base.showOverlay).toHaveBeenCalledTimes(1);
    expect(host.begin).toHaveBeenCalledTimes(1);
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

describe("dictation overlay window level", () => {
  test("uses the screen-saver level so it stays above focused app windows", () => {
    expect(DICTATION_OVERLAY_ALWAYS_ON_TOP_LEVEL).toBe("screen-saver");
  });
});
