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

  test("draws in the capture colour, not the assistant's", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, call: LISTENING_CALL, watching: true });
    expect(
      frameOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  test("goes once the session is over", () => {
    const { container } = render(<CompanionWatchFramePage />);
    pushState({ ...STATE, watching: true });
    pushState({ ...STATE, watching: false });
    expect(frameOf(container)).toBeNull();
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
