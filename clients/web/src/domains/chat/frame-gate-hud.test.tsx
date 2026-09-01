/**
 * Who sees the tuning panel, what it says about the frame the gate just
 * judged, and what a slider does to the gate underneath it.
 *
 * The last one is the property the whole design turns on: moving a threshold
 * writes into the options record the running gate already holds. If a change
 * replaced that record instead, the gate would have to be rebuilt, and a fresh
 * gate keeps the next frame it sees, which on these surfaces is an upload and
 * a persisted message nobody asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { FrameGateHud } from "@/domains/chat/frame-gate-hud";
import { DEFAULT_FRAME_GATE_OPTIONS } from "@/lib/camera/frame-gate";
import {
  FRAME_GATE_LIVE_OPTIONS,
  defaultFrameGateOverrides,
  recordFrameGateDecision,
  syncFrameGateDebugOptions,
  type FrameGateDebugSurface,
} from "@/lib/camera/frame-gate-debug";
import { setupCameraGateHudAccessSync } from "@/lib/camera/frame-gate-debug-access";
import { useAuthStore, type AuthUser } from "@/stores/auth-store";
import { useCameraGateDebugStore } from "@/stores/camera-gate-debug-store";

const STAFF_USER: AuthUser = {
  kind: "platform",
  id: "user-1",
  username: "staffer",
  email: "staffer@vellum.ai",
  isStaff: true,
  firstName: "Staff",
  lastName: "Member",
};

const LOCAL_USER: AuthUser = {
  kind: "local",
  id: "gateway-local",
  username: null,
  email: null,
  isStaff: false,
  firstName: "",
  lastName: "",
};

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const initialAuthState = useAuthStore.getState();
const initialDebugState = useCameraGateDebugStore.getState();

let pendingFrames: Array<() => void> = [];
let stopAccessSync: (() => void) | null = null;

function flushFrames(): void {
  const queued = pendingFrames;
  pendingFrames = [];
  for (const frame of queued) {
    frame();
  }
}

/**
 * Feed one decision through and let the panel see it.
 *
 * `novelty` is null on the frames the gate judged with nothing kept to score
 * against, which is what tells the panel which branch to draw.
 */
function judge(
  surface: FrameGateDebugSurface,
  reason: "novel" | "rate-floor" | "warmup" | "first",
  keep: boolean,
  novelty: number | null = 0.9,
): void {
  act(() => {
    recordFrameGateDecision(
      surface,
      { keep, reason, motion: 0.02, novelty, detail: 22 },
      performance.now(),
    );
    flushFrames();
  });
}

/** The step rows on screen, in the order the panel lists them. */
function renderedSteps(): string[] {
  return screen
    .getAllByTestId(/^frame-gate-hud-step-/)
    .map((element) =>
      (element.getAttribute("data-testid") ?? "").replace(
        "frame-gate-hud-step-",
        "",
      ),
    );
}

beforeEach(() => {
  pendingFrames = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    pendingFrames.push(() => callback(0));
    return pendingFrames.length;
  }) as typeof globalThis.requestAnimationFrame;
  useAuthStore.setState({ user: STAFF_USER });
  useCameraGateDebugStore.setState(
    { ...initialDebugState, overrides: defaultFrameGateOverrides() },
    true,
  );
  // What the sliders do to the gate runs through the access sync, so the panel
  // is exercised over the same wiring the app boots.
  stopAccessSync = setupCameraGateHudAccessSync();
  useCameraGateDebugStore.getState().setHudEnabled(true);
});

afterEach(() => {
  cleanup();
  stopAccessSync?.();
  stopAccessSync = null;
  useCameraGateDebugStore.getState().setHudEnabled(false);
  useCameraGateDebugStore.setState(
    { ...initialDebugState, overrides: defaultFrameGateOverrides() },
    true,
  );
  syncFrameGateDebugOptions(false, defaultFrameGateOverrides());
  useAuthStore.setState(initialAuthState, true);
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
});

describe("FrameGateHud gating", () => {
  test("renders nothing for a session that is neither staff nor flagged", () => {
    useAuthStore.setState({ user: LOCAL_USER });
    judge("composer", "novel", true);

    render(<FrameGateHud surface="composer" />);

    expect(screen.queryByTestId("frame-gate-hud")).toBeNull();
  });

  test("renders nothing while the readout is switched off", () => {
    judge("composer", "novel", true);
    act(() => {
      useCameraGateDebugStore.getState().setHudEnabled(false);
    });

    render(<FrameGateHud surface="composer" />);

    expect(screen.queryByTestId("frame-gate-hud")).toBeNull();
  });

  test("renders nothing before any camera has fed the gate", () => {
    render(<FrameGateHud surface="composer" />);

    expect(screen.queryByTestId("frame-gate-hud")).toBeNull();
  });

  test("only the mount for the surface feeding the gate renders", () => {
    render(
      <>
        <FrameGateHud surface="composer" />
        <FrameGateHud surface="voice" />
      </>,
    );

    judge("voice", "novel", true);

    expect(screen.getAllByTestId("frame-gate-hud").length).toBe(1);
    expect(screen.getByText("Voice room camera")).toBeTruthy();
  });
});

describe("FrameGateHud readout", () => {
  test("shows the latest verdict and highlights the check that made it", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "rate-floor", false);

    expect(screen.getByText("Skip")).toBeTruthy();
    expect(screen.getByText("Too soon after the last photo.")).toBeTruthy();
    expect(
      screen
        .getByTestId("frame-gate-hud-step-rate-floor")
        .getAttribute("data-decided"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("frame-gate-hud-step-novel")
        .getAttribute("data-decided"),
    ).toBeNull();
  });

  test("a keep replaces the verdict on the next frame", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "warmup", false);
    expect(screen.getByText("Skip")).toBeTruthy();

    judge("composer", "novel", true);

    expect(screen.getByText("Keep")).toBeTruthy();
    expect(
      screen
        .getByTestId("frame-gate-hud-step-novel")
        .getAttribute("data-decided"),
    ).toBe("true");
  });
});

describe("FrameGateHud decision order", () => {
  test("lists the checks the gate runs once it has a baseline", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "novel", true);

    expect(renderedSteps()).toEqual([
      "warmup",
      "featureless",
      "rate-floor",
      "moving",
      "heartbeat",
      "novel",
      "unchanged",
    ]);
  });

  test("lists the shorter path for a frame judged with no baseline", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "first", true, null);

    // The floor and the settle check are above the keep, which is the order
    // the gate runs them in on this branch, and the checks that score against
    // a kept frame are not on it at all.
    expect(renderedSteps()).toEqual([
      "warmup",
      "featureless",
      "rate-floor",
      "moving",
      "first",
    ]);
    expect(
      screen
        .getByTestId("frame-gate-hud-step-first")
        .getAttribute("data-decided"),
    ).toBe("true");
  });

  test("a floor skip with no baseline highlights the floor, not the keep", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "rate-floor", false, null);

    expect(renderedSteps()).toEqual([
      "warmup",
      "featureless",
      "rate-floor",
      "moving",
      "first",
    ]);
    expect(
      screen
        .getByTestId("frame-gate-hud-step-rate-floor")
        .getAttribute("data-decided"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("frame-gate-hud-step-first")
        .getAttribute("data-decided"),
    ).toBeNull();
  });
});

describe("FrameGateHud thresholds", () => {
  test("a slider writes into the record the running gate holds", () => {
    const recordBefore = FRAME_GATE_LIVE_OPTIONS;
    render(<FrameGateHud surface="composer" />);
    judge("composer", "novel", true);

    const noveltySlider = within(
      screen.getByTestId("frame-gate-hud-slider-noveltyThreshold"),
    ).getByRole("slider");
    act(() => {
      fireEvent.keyDown(noveltySlider, { key: "ArrowRight" });
    });

    const moved = useCameraGateDebugStore.getState().overrides.noveltyThreshold;
    expect(moved).toBeGreaterThan(DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold);
    expect(FRAME_GATE_LIVE_OPTIONS).toBe(recordBefore);
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(moved);
  });

  test("reset puts every threshold back on the gate", () => {
    render(<FrameGateHud surface="composer" />);
    judge("composer", "novel", true);
    act(() => {
      useCameraGateDebugStore.getState().setOverride("minDetail", 30);
    });
    expect(FRAME_GATE_LIVE_OPTIONS.minDetail).toBe(30);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    });

    expect(useCameraGateDebugStore.getState().overrides).toEqual(
      defaultFrameGateOverrides(),
    );
    expect({ ...FRAME_GATE_LIVE_OPTIONS }).toEqual({
      ...DEFAULT_FRAME_GATE_OPTIONS,
    });
  });
});
