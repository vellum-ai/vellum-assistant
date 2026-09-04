import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

const STATE: CompanionSurfaceState = {
  growth: "right",
  cardGrowth: "up",
  avatarBox: 44,
  optionsBox: 44,
  call: null,
  assistantName: "Ziggy",
  working: false,
  intro: null,
};

const listeners = new Set<(state: CompanionSurfaceState) => void>();

const pushState = (state: CompanionSurfaceState) => {
  act(() => {
    for (const listener of listeners) {
      listener(state);
    }
  });
};

mock.module("@/runtime/companion-surface", () => ({
  getCompanionState: async () => STATE,
  subscribeCompanionState: (
    listener: (state: CompanionSurfaceState) => void,
  ) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

const { CompanionWatchFramePage } =
  await import("./companion-watch-frame-page");

afterEach(() => {
  cleanup();
  listeners.clear();
});

const frameOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-watch-frame");

const LISTENING_CALL = {
  phase: "listening" as const,
  label: "Listening",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

/**
 * The frame around what is being read. The window exists only while the shell
 * holds a session, so what these pin is that the border follows the state the
 * shell pushes rather than the window's own existence.
 */
describe("the frame around what is read", () => {
  test("is empty with nothing running", () => {
    const { container } = render(<CompanionWatchFramePage />);
    expect(frameOf(container)).toBeNull();
  });

  test("draws for a session reading the screen", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true });
    expect(frameOf(container)).not.toBeNull();
  });

  /**
   * A call is a microphone, not a screen. The creature's ring already says a
   * call is running; the frame is reserved for the capture.
   */
  test("stays empty for a call alone", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, call: LISTENING_CALL, dialing: true });
    expect(frameOf(container)).toBeNull();
  });

  /**
   * The edge and the call pill are one light. A colour of the frame's own
   * would leave the user to work out that two unrelated lights on the same
   * desktop were about one session.
   */
  test("draws in the running call's accent", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, call: LISTENING_CALL, watching: true });
    expect(
      frameOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#5eead4");
  });

  test("falls back to the accent the app published", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      accentHex: "#a78bfa",
      screenShare: { kind: "display", displayId: 7 },
    });
    expect(
      frameOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#a78bfa");
  });

  /**
   * Handing CSS an unusable value drops the custom property and takes the
   * border's colour with it, so an accent that does not parse is left unset
   * and the class keeps its own.
   */
  test("leaves the colour to the class when no accent resolves", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, accentHex: "not a colour", watching: true });
    expect(
      frameOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("");
  });

  test("goes once the session is over", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true });
    pushState({ ...STATE, watching: false });
    expect(frameOf(container)).toBeNull();
  });

  /**
   * A share is the other way a surface leaves the machine, and the shell
   * opens and places this window for it exactly as it does for a watch.
   */
  test("draws for a screen a call is sharing", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      call: LISTENING_CALL,
      screenShare: { kind: "display", displayId: 7 },
    });
    expect(frameOf(container)).not.toBeNull();
  });

  test("draws for a window or tab a call is sharing", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      call: LISTENING_CALL,
      screenShare: { kind: "window", windowId: 42 },
    });
    expect(frameOf(container)).not.toBeNull();
  });

  test("stays while a share outlives the watch beside it", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      watching: true,
      screenShare: { kind: "display", displayId: 7 },
    });
    pushState({
      ...STATE,
      watching: false,
      screenShare: { kind: "display", displayId: 7 },
    });
    expect(frameOf(container)).not.toBeNull();
  });

  test("goes once the share is stopped", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      call: LISTENING_CALL,
      screenShare: { kind: "display", displayId: 7 },
    });
    pushState({ ...STATE, call: LISTENING_CALL });
    expect(frameOf(container)).toBeNull();
  });

  /**
   * `captureCount` is the watch session's total and a share does not advance
   * it. A share still holding the frame after the watch ended would otherwise
   * sit on that session's last count and flash for a read nobody took.
   */
  test("does not flash for a share left holding the frame", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({
      ...STATE,
      watching: true,
      captureCount: 3,
      screenShare: { kind: "display", displayId: 7 },
    });
    pushState({
      ...STATE,
      watching: false,
      captureCount: 4,
      screenShare: { kind: "display", displayId: 7 },
    });
    expect(container.querySelector(".companion-watch-frame-flash")).toBeNull();
  });

  test("reads a state that says nothing about it as empty", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE });
    expect(frameOf(container)).toBeNull();
  });

  /**
   * The session's screen reads reach this window the same way the flag does,
   * and they are the half nothing else can stand in for: the flag says a
   * session is open and only the count says the screen has actually been read.
   */
  test("flashes for a capture the session reported", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true, captureCount: 3 });
    pushState({ ...STATE, watching: true, captureCount: 4 });
    expect(
      container.querySelector(".companion-watch-frame-flash"),
    ).not.toBeNull();
  });

  /**
   * This window is opened with the session and main answers it with the total
   * it has been keeping. That number stands for reads taken before this
   * window existed, so drawing it would present the last of them as one
   * happening now.
   */
  test("does not flash for a capture it only inherited from main", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true, captureCount: 3 });
    expect(container.querySelector(".companion-watch-frame-flash")).toBeNull();
  });

  test("reads a state that says nothing about captures as none", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true });
    pushState({ ...STATE, watching: true });
    expect(container.querySelector(".companion-watch-frame-flash")).toBeNull();
  });

  test("is never something to point at", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true });
    expect(container.firstElementChild?.className).toContain(
      "pointer-events-none",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
