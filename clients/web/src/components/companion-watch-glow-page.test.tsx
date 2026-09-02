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

const { CompanionWatchGlowPage } = await import("./companion-watch-glow-page");

afterEach(() => {
  cleanup();
  listeners.clear();
});

const glowOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-watch-glow");

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
 * The display's edge, lit while the screen is being read. The window exists
 * only while the shell holds a session, so what these pin is that the light
 * follows the state the shell pushes rather than the window's own existence.
 */
describe("the display's edge glow", () => {
  test("is dark with nothing running", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    expect(glowOf(container)).toBeNull();
  });

  test("lights for a session reading the screen", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE, watching: true });
    expect(glowOf(container)).not.toBeNull();
  });

  /**
   * A call is a microphone, not a screen. The creature's ring already says a
   * call is running; the frame is reserved for the capture.
   */
  test("stays dark for a call alone", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE, call: LISTENING_CALL, dialing: true });
    expect(glowOf(container)).toBeNull();
  });

  test("lights in the capture colour, not the assistant's", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE, call: LISTENING_CALL, watching: true });
    expect(
      glowOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  test("goes dark once the session is over", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE, watching: true });
    pushState({ ...STATE, watching: false });
    expect(glowOf(container)).toBeNull();
  });

  test("reads a state that says nothing about it as dark", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE });
    expect(glowOf(container)).toBeNull();
  });

  test("is never something to point at", () => {
    const { container } = render(<CompanionWatchGlowPage />);
    pushState({ ...STATE, watching: true });
    expect(container.firstElementChild?.className).toContain(
      "pointer-events-none",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
