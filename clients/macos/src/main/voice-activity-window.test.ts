import { describe, expect, mock, test } from "bun:test";

import type {
  VoiceActivityContent,
  VoiceActivityStart,
  VoiceActivityState,
} from "@vellumai/ipc-contract";

// The module under test reaches `window-state.ts` for the panel's remembered
// position, which loads `electron-store` — a real module that imports the
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

// Dynamic, so the mock above is installed before the module graph loads —
// static imports hoist above it. Same pattern as `window-state.test.ts`.
const { createVoiceActivityController } =
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
    // the store persists, so a second start is expected traffic — an elapsed
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
