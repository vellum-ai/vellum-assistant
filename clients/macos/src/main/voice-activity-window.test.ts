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
  setCollapsed: ReturnType<typeof mock>;
  sent: (VoiceActivityState | null)[];
  setNow: (now: number) => void;
};

const createHarness = (options: { now?: number } = {}): Harness => {
  let now = options.now ?? 1_000;
  const showPanel = mock(() => undefined);
  const hidePanel = mock(() => undefined);
  const setCollapsed = mock((_collapsed: boolean) => undefined);
  const sent: (VoiceActivityState | null)[] = [];

  const controller = createVoiceActivityController({
    showPanel,
    hidePanel,
    setCollapsed,
    sendState: (state) => {
      sent.push(state);
    },
    now: () => now,
  });

  return {
    controller,
    showPanel,
    hidePanel,
    setCollapsed,
    sent,
    setNow: (next) => {
      now = next;
    },
  };
};

describe("createVoiceActivityController", () => {
  test("shows the panel when a session starts", () => {
    const h = createHarness();

    h.controller.start(START);

    expect(h.showPanel).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)).toMatchObject({
      assistantName: "Aria",
      phase: "listening",
      startedAt: 1_000,
      collapsed: false,
    });
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

describe("closing the window", () => {
  test("dismiss hides the window and leaves the session running", () => {
    const h = createHarness();
    h.controller.start(START);
    h.hidePanel.mockClear();

    h.controller.dismiss();

    // The button a user reaches for when a panel is in the way must never hang
    // up on them.
    expect(h.hidePanel).toHaveBeenCalledTimes(1);
    expect(h.controller.currentState()).not.toBeNull();
  });

  test("updates keep flowing to a dismissed panel without reopening it", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.dismiss();
    h.showPanel.mockClear();

    h.controller.update({ ...CONTENT, phase: "thinking", label: "Thinking…" });

    expect(h.showPanel).not.toHaveBeenCalled();
    expect(h.controller.currentState()).toMatchObject({ phase: "thinking" });
  });

  test("reopen brings it back for the session already running", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.dismiss();
    h.showPanel.mockClear();

    h.controller.reopen();

    expect(h.showPanel).toHaveBeenCalledTimes(1);
  });

  test("a new session reopens a panel closed during the last one", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.dismiss();
    h.controller.end();
    h.showPanel.mockClear();

    h.controller.start(START);

    // A closed panel means a live microphone with no floating control, so a
    // dismissal lasts only as long as the call it was aimed at.
    expect(h.showPanel).toHaveBeenCalledTimes(1);
  });

  test("a remount during a dismissed session does not reopen it", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.dismiss();
    h.showPanel.mockClear();

    h.controller.start({ ...START, phase: "thinking", label: "Thinking…" });

    // A redundant start is the mirror re-syncing, not the user changing their
    // mind about a panel they closed.
    expect(h.showPanel).not.toHaveBeenCalled();
  });
});

describe("collapsing to the chip", () => {
  test("resizes the window before telling the page", () => {
    const h = createHarness();
    h.controller.start(START);

    h.controller.setCollapsed(true);

    // The page must never draw a chip into a window still the size of the
    // expanded panel.
    expect(h.setCollapsed).toHaveBeenCalledWith(true);
    expect(h.sent.at(-1)).toMatchObject({ collapsed: true });
  });

  test("restoring expands it again", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.setCollapsed(true);

    h.controller.setCollapsed(false);

    expect(h.setCollapsed).toHaveBeenLastCalledWith(false);
    expect(h.controller.currentState()).toMatchObject({ collapsed: false });
  });

  test("a redundant collapse does not resize the window again", () => {
    const h = createHarness();
    h.controller.start(START);
    h.controller.setCollapsed(true);
    h.setCollapsed.mockClear();

    h.controller.setCollapsed(true);

    expect(h.setCollapsed).not.toHaveBeenCalled();
  });

  test("collapsing with no session does nothing", () => {
    const h = createHarness();

    h.controller.setCollapsed(true);

    expect(h.setCollapsed).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });
});
