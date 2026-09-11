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

const { CompanionDockZonesPage } = await import("./companion-dock-zones-page");

afterEach(() => {
  cleanup();
  listeners.clear();
});

const zonesOf = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-testid='companion-dock-zone']",
    ),
  );

const armedOf = (container: HTMLElement): string[] =>
  zonesOf(container)
    .filter((zone) => zone.dataset.armed === "true")
    .map((zone) => zone.dataset.dock ?? "");

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
 * The edges a call's bar can be dropped on. The window exists only while a
 * drag is in flight, so what these pin is that the page draws off the state
 * the shell pushes rather than off its own existence, and lights the edge the
 * shell says the drop would land on.
 */
describe("the edges a call's bar can dock to", () => {
  test("draws nothing while no drag is in flight", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, dock: "bottom" });
    expect(zonesOf(container)).toHaveLength(0);
  });

  test("shows all four edges once a drag is in flight", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "bottom" });
    expect(zonesOf(container).map((zone) => zone.dataset.dock)).toEqual([
      "bottom",
      "top",
      "left",
      "right",
    ]);
  });

  test("lights the one the drop would land on, and follows it", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "left" });
    expect(armedOf(container)).toEqual(["left"]);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "top" });
    expect(armedOf(container)).toEqual(["top"]);
  });

  test("takes the edges down on the release", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "right" });
    expect(zonesOf(container)).toHaveLength(4);
    pushState({ ...STATE, call: LISTENING_CALL, dock: "right" });
    expect(zonesOf(container)).toHaveLength(0);
  });

  test("lights the edge in the running call's accent", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "right" });
    const page = container.querySelector<HTMLElement>(
      "[data-testid='companion-dock-zones']",
    );
    expect(page?.style.getPropertyValue("--companion-ring-accent")).toBe(
      "#ff9f45",
    );
  });

  /**
   * The middle of each edge, not the whole of it: the bar lands at the
   * centre of the edge, and the zone is the size of what lands there.
   */
  test("sits at the centre of its edge rather than corner to corner", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "top" });
    const [bottom, top, left, right] = zonesOf(container);
    expect(top?.style.left).toBe("50%");
    expect(top?.style.width).toBe("360px");
    expect(bottom?.style.left).toBe("50%");
    expect(left?.style.top).toBe("50%");
    expect(left?.style.height).toBe("360px");
    expect(right?.style.top).toBe("50%");
  });

  test("takes no pointer, so the drag underneath it goes on", () => {
    const { container } = render(<CompanionDockZonesPage />);
    pushState({ ...STATE, call: LISTENING_CALL, docking: "right" });
    const page = container.querySelector<HTMLElement>(
      "[data-testid='companion-dock-zones']",
    );
    expect(page?.className).toContain("pointer-events-none");
  });
});
