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

const { CompanionCallGlowPage } = await import("./companion-call-glow-page");

afterEach(() => {
  cleanup();
  listeners.clear();
});

const glowOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".companion-call-glow");

const LISTENING_CALL = {
  phase: "listening" as const,
  label: "Listening",
  accentHex: "#ff9f45",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

/**
 * The display's edge, lit for a call. The window exists only while the shell
 * holds a call, so what these pin is that the light follows the state the
 * shell pushes rather than the window's own existence.
 */
describe("the display's edge glow", () => {
  test("is dark with nothing running", () => {
    const { container } = render(<CompanionCallGlowPage />);
    expect(glowOf(container)).toBeNull();
  });

  test("lights for a dial, which is the call's first beat", () => {
    const { container } = render(<CompanionCallGlowPage />);
    pushState({ ...STATE, dialing: true });
    expect(glowOf(container)).not.toBeNull();
  });

  test("lights in the call's own colour", () => {
    const { container } = render(<CompanionCallGlowPage />);
    pushState({ ...STATE, call: LISTENING_CALL });
    expect(
      glowOf(container)?.style.getPropertyValue("--companion-ring-accent"),
    ).toBe("#ff9f45");
  });

  test("goes dark once the call is over", () => {
    const { container } = render(<CompanionCallGlowPage />);
    pushState({ ...STATE, call: LISTENING_CALL });
    pushState({ ...STATE, call: null });
    expect(glowOf(container)).toBeNull();
  });

  test("is never something to point at", () => {
    const { container } = render(<CompanionCallGlowPage />);
    pushState({ ...STATE, dialing: true });
    expect(container.firstElementChild?.className).toContain(
      "pointer-events-none",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
