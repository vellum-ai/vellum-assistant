import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceActivityContent,
  VoiceActivityStart,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

// The module under test reaches `window-state.ts` for the panel's remembered
// position, which loads `electron-store`, a real module that imports the
// Electron binary's default export and cannot resolve off-Electron. Only the
// import chain needs satisfying here: these cases exercise the controller,
// which touches no store. Same shape as `window-state.test.ts`, which mocks it
// for the same reason.
mock.module("electron-store", () => ({
  default: class {
    get(_key: string, fallback?: unknown) {
      return fallback;
    }
    set() {}
  },
}));

// Dynamic, so the mock above is installed before the module graph loads:
// static imports hoist above it. Same pattern as `window-state.test.ts`.
const { createVoiceActivityController, createFrontmostTracker } =
  await import("./voice-activity-window");

const CONTENT: VoiceActivityContent = {
  phase: "listening",
  label: "Listening…",
  accentHex: "#7C5CFF",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
};

const START: VoiceActivityStart = {
  ...CONTENT,
  assistantName: "Aria",
  avatarBase64: "iVBORw0KGgo=",
};

type Harness = {
  controller: ReturnType<typeof createVoiceActivityController>;
  showPanel: ReturnType<typeof mock>;
  hidePanel: ReturnType<typeof mock>;
  sent: (VoiceActivityState | null)[];
  setFrontmost: (frontmost: boolean) => void;
  setNow: (now: number) => void;
};

const createHarness = (
  options: { frontmost?: boolean; now?: number } = {},
): Harness => {
  let frontmost = options.frontmost ?? false;
  let now = options.now ?? 1_000;
  const showPanel = mock(() => undefined);
  const hidePanel = mock(() => undefined);
  const sent: (VoiceActivityState | null)[] = [];

  const controller = createVoiceActivityController({
    showPanel,
    hidePanel,
    sendState: (state) => {
      sent.push(state);
    },
    isAppFrontmost: () => frontmost,
    now: () => now,
  });

  return {
    controller,
    showPanel,
    hidePanel,
    sent,
    setFrontmost: (next) => {
      frontmost = next;
    },
    setNow: (next) => {
      now = next;
    },
  };
};

describe("createVoiceActivityController", () => {
  test("shows the panel for a session started while the app is in the background", () => {
    const h = createHarness({ frontmost: false });

    h.controller.start(START);

    expect(h.showPanel).toHaveBeenCalledTimes(1);
    expect(h.hidePanel).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toMatchObject({
      assistantName: "Aria",
      phase: "listening",
      startedAt: 1_000,
    });
  });

  test("keeps the panel hidden while Vellum is frontmost", () => {
    const h = createHarness({ frontmost: true });

    h.controller.start(START);

    expect(h.showPanel).not.toHaveBeenCalled();
    expect(h.hidePanel).toHaveBeenCalledTimes(1);
    // State is still published: the app being frontmost decides visibility,
    // not whether the session is tracked.
    expect(h.controller.currentState()).not.toBeNull();
  });

  test("shows and hides as the app loses and regains focus mid-session", () => {
    const h = createHarness({ frontmost: true });
    h.controller.start(START);

    h.setFrontmost(false);
    h.controller.focusChanged();
    expect(h.showPanel).toHaveBeenCalledTimes(1);

    h.setFrontmost(true);
    h.controller.focusChanged();
    expect(h.hidePanel).toHaveBeenCalledTimes(2);
  });

  test("a focus change with no session never shows the panel", () => {
    const h = createHarness({ frontmost: false });

    h.controller.focusChanged();

    expect(h.showPanel).not.toHaveBeenCalled();
  });

  test("a redundant start updates the session without restarting the clock", () => {
    const h = createHarness({ now: 1_000 });
    h.controller.start(START);

    h.setNow(60_000);
    h.controller.start({ ...START, phase: "thinking", label: "Thinking…" });

    // The session controller remounts across layout-level route changes while
    // the store persists, so a second start is expected traffic. An elapsed
    // timer that jumped back to zero there would be a visible lie.
    expect(h.controller.currentState()).toMatchObject({
      phase: "thinking",
      startedAt: 1_000,
    });
  });

  test("update merges content and leaves the session's fixed fields alone", () => {
    const h = createHarness();
    h.controller.start(START);

    h.controller.update({ ...CONTENT, phase: "speaking", label: "Speaking…" });

    expect(h.controller.currentState()).toMatchObject({
      phase: "speaking",
      label: "Speaking…",
      assistantName: "Aria",
      avatarBase64: "iVBORw0KGgo=",
      startedAt: 1_000,
    });
  });

  test("update with no running session is dropped rather than promoted", () => {
    const h = createHarness();

    h.controller.update(CONTENT);

    // Content carries no assistant name or avatar, so honoring it would put an
    // anonymous panel on screen.
    expect(h.controller.currentState()).toBeNull();
    expect(h.showPanel).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  test("end clears the session and pushes the clear before hiding", () => {
    const h = createHarness();
    h.controller.start(START);
    h.sent.length = 0;
    h.hidePanel.mockClear();

    h.controller.end();

    // Null first: a panel shown again later in the same launch must never
    // paint the previous session's phase for a frame.
    expect(h.sent).toEqual([null]);
    expect(h.hidePanel).toHaveBeenCalledTimes(1);
    expect(h.controller.currentState()).toBeNull();
  });

  test("a focus change after the session ended keeps the panel hidden", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.end();
    h.showPanel.mockClear();

    h.setFrontmost(false);
    h.controller.focusChanged();

    expect(h.showPanel).not.toHaveBeenCalled();
  });

  test("carries the pending approval through to the panel", () => {
    const h = createHarness();
    h.controller.start(START);

    h.controller.update({
      ...CONTENT,
      detail: "Waiting for your decision",
      approvalRequestId: "req-42",
    });

    expect(h.sent.at(-1)).toMatchObject({ approvalRequestId: "req-42" });
  });
});

describe("createFrontmostTracker", () => {
  test("falls back to the window server before any signal lands", () => {
    const focused = createFrontmostTracker(() => true);
    const unfocused = createFrontmostTracker(() => false);

    expect(focused.isFrontmost()).toBe(true);
    expect(unfocused.isFrontmost()).toBe(false);
  });

  test("a launch that activated before install still reads as frontmost", () => {
    // The install runs before `installMainWindow`, so at install time there is
    // no window to focus and the launch's `did-become-active` has already
    // fired. A tracker that latched "not frontmost" there would open the panel
    // over a focused app for the whole first session.
    let otherWindowFocused = false;
    const tracker = createFrontmostTracker(() => otherWindowFocused);

    expect(tracker.isFrontmost()).toBe(false);

    otherWindowFocused = true;

    expect(tracker.isFrontmost()).toBe(true);
  });

  test("clicking the panel does not count as the app coming forward", () => {
    // Clicking the panel activates the app despite its non-activating window
    // type, so an unguarded `did-become-active` hid the panel the instant the
    // user touched it, including on a drag of its own header.
    const tracker = createFrontmostTracker(() => false);
    tracker.resignedActive();

    tracker.becameActive(true);

    expect(tracker.isFrontmost()).toBe(false);
  });

  test("focus moving to a real window after a panel click still hides it", () => {
    // macOS fires no second activation once the panel has already made the app
    // active, so window focus is the only signal left to catch this.
    const tracker = createFrontmostTracker(() => false);
    tracker.resignedActive();
    tracker.becameActive(true);

    tracker.windowFocused(false);

    expect(tracker.isFrontmost()).toBe(true);
  });

  test("the panel taking focus never marks the app frontmost", () => {
    const tracker = createFrontmostTracker(() => false);
    tracker.resignedActive();

    tracker.windowFocused(true);

    expect(tracker.isFrontmost()).toBe(false);
  });

  test("an activation with the panel unfocused marks the app frontmost", () => {
    const tracker = createFrontmostTracker(() => false);

    tracker.becameActive(false);

    expect(tracker.isFrontmost()).toBe(true);
  });

  test("resigning active always wins", () => {
    const tracker = createFrontmostTracker(() => true);
    tracker.windowFocused(false);
    expect(tracker.isFrontmost()).toBe(true);

    tracker.resignedActive();

    expect(tracker.isFrontmost()).toBe(false);
  });
});
