/**
 * Who sees the tuning readout, which presentation they get, what it says about
 * the frame the gate just judged, and what a slider does to the gate
 * underneath it.
 *
 * The slider is the property the whole design turns on: moving a threshold
 * writes into the options record the running gate already holds. If a change
 * replaced that record instead, the gate would have to be rebuilt, and a fresh
 * gate keeps the next frame it sees, which on these surfaces is an upload and
 * a persisted message nobody asked for.
 *
 * The narrow window is driven through the shared signal rather than a viewport
 * stub, since that signal is what the component reads and what the rest of the
 * app agrees on.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  type Mock,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import type * as UseIsMobileModule from "@/hooks/use-is-mobile";
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

/** Whether the window is narrow enough to have no room for the card. */
const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", (): typeof UseIsMobileModule => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { FrameGateHud } = await import("@/domains/chat/frame-gate-hud");

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
  isMobileRef.value = false;
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
      "forced",
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
      "forced",
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
      "forced",
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

const card = () => screen.queryByTestId("frame-gate-hud");
const strip = () => screen.queryByTestId("frame-gate-hud-strip");
const sheet = () => screen.queryByTestId("frame-gate-hud-sheet");
const backdrop = () => screen.queryByTestId("frame-gate-hud-backdrop");

/** Put a decision on the record and render a mount that may stand down. */
function renderCollapsible(): void {
  render(<FrameGateHud surface="composer" collapsible />);
  judge("composer", "novel", true);
}

/** Render the collapsible mount on a narrow window and open its sheet. */
function openSheet(): void {
  isMobileRef.value = true;
  renderCollapsible();
  act(() => {
    fireEvent.click(strip()!);
  });
}

/**
 * The shape the room puts around the readout: one drag surface carrying a
 * React `onPointerDown`, with the readout and some bare chrome inside it.
 *
 * `voice-room.tsx` hands that press to `dragControls.start`. Here it is a spy,
 * because what the sheet has to be sure of is only which presses the room is
 * asked to open a drag from.
 */
function RoomHarness({ onRoomPress }: { onRoomPress: () => void }) {
  return (
    <div data-testid="room" onPointerDown={onRoomPress}>
      <div data-testid="bare-chrome" />
      <FrameGateHud surface="composer" collapsible />
    </div>
  );
}

/** Render the readout inside the room's shape. Hands back the room's spy. */
function renderRoom(): Mock<() => void> {
  const roomPress = mock(() => {});
  render(<RoomHarness onRoomPress={roomPress} />);
  judge("composer", "novel", true);
  return roomPress;
}

/** The same, on a narrow window and with the sheet already open. */
function openSheetInRoom(): Mock<() => void> {
  isMobileRef.value = true;
  const roomPress = renderRoom();
  act(() => {
    fireEvent.click(strip()!);
  });
  roomPress.mockClear();
  return roomPress;
}

/** The element a slider reads a press against: Radix's own root. */
function sliderSurface(key: string): HTMLElement {
  const surface = screen
    .getByTestId(`frame-gate-hud-slider-${key}`)
    .querySelector("[data-owns-horizontal-drag]");
  if (!(surface instanceof HTMLElement)) {
    throw new Error(`no slider surface for ${key}`);
  }
  return surface;
}

/** A 200px track starting at the origin, so a press at 100 is the midpoint. */
const TRACK_RECT = {
  x: 0,
  y: 0,
  left: 0,
  top: 0,
  right: 200,
  bottom: 20,
  width: 200,
  height: 20,
  toJSON: () => ({}),
} as DOMRect;

/**
 * Which presentation a mount gets.
 *
 * Two terms, and both matter. The window has to be short of room, which is the
 * shared narrow-window signal rather than the pointer or the platform; and the
 * mount has to have said its slot can stand a strip, since the composer's
 * corner tile is a layout the room knows nothing about.
 */
describe("FrameGateHud presentation", () => {
  test("a collapsible mount on a narrow window is a strip, not a card", () => {
    isMobileRef.value = true;
    renderCollapsible();

    expect(strip()).not.toBeNull();
    expect(card()).toBeNull();
  });

  test("a mount that has not opted in keeps the card on a narrow window", () => {
    isMobileRef.value = true;
    render(<FrameGateHud surface="composer" />);
    judge("composer", "novel", true);

    expect(card()).not.toBeNull();
    expect(strip()).toBeNull();
  });

  test("a collapsible mount on a roomy window is still the card", () => {
    renderCollapsible();

    expect(card()).not.toBeNull();
    expect(strip()).toBeNull();
  });

  test("the strip is absent for a session with the readout switched off", () => {
    isMobileRef.value = true;
    judge("composer", "novel", true);
    act(() => {
      useCameraGateDebugStore.getState().setHudEnabled(false);
    });

    render(<FrameGateHud surface="composer" collapsible />);

    expect(strip()).toBeNull();
    expect(card()).toBeNull();
  });
});

describe("FrameGateHud strip", () => {
  test("carries the verdict and the three meters, and nothing to tune", () => {
    isMobileRef.value = true;
    renderCollapsible();

    expect(within(strip()!).getByText("Keep")).toBeTruthy();
    for (const meter of ["motion", "novelty", "detail"]) {
      expect(
        within(strip()!).getByTestId(`frame-gate-hud-mini-${meter}`),
      ).toBeTruthy();
    }
    // Everything with a number or a control on it waits behind the tap, which
    // is what keeps the standing form off the viewfinder.
    expect(
      screen.queryByTestId("frame-gate-hud-slider-noveltyThreshold"),
    ).toBeNull();
    expect(screen.queryByText("Decision order")).toBeNull();
  });

  test("the verdict follows the newest frame", () => {
    isMobileRef.value = true;
    renderCollapsible();
    expect(within(strip()!).getByText("Keep")).toBeTruthy();

    judge("composer", "rate-floor", false);

    expect(within(strip()!).getByText("Skip")).toBeTruthy();
  });

  test("names the act it performs, and reports the state it is in", () => {
    isMobileRef.value = true;
    renderCollapsible();

    expect(strip()?.getAttribute("aria-label")).toBe(
      "Show the frame gate readout",
    );
    expect(strip()?.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      fireEvent.click(strip()!);
    });

    expect(strip()?.getAttribute("aria-label")).toBe(
      "Hide the frame gate readout",
    );
    expect(strip()?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("FrameGateHud sheet", () => {
  test("a tap on the strip brings up the whole readout", () => {
    openSheet();

    expect(sheet()).not.toBeNull();
    expect(within(sheet()!).getByText("Decision order")).toBeTruthy();
    expect(within(sheet()!).getByText("Recent frames")).toBeTruthy();
    expect(within(sheet()!).getByText("Recent keeps")).toBeTruthy();
    expect(
      within(sheet()!).getByTestId("frame-gate-hud-slider-noveltyThreshold"),
    ).toBeTruthy();
    expect(
      within(sheet()!).getByRole("button", { name: "Reset" }),
    ).toBeTruthy();
  });

  test("the strip stays up beside it, so the live meters never leave", () => {
    openSheet();

    expect(strip()).not.toBeNull();
  });

  test("a slider in the sheet reaches the running gate", () => {
    openSheet();
    const noveltySlider = within(
      screen.getByTestId("frame-gate-hud-slider-noveltyThreshold"),
    ).getByRole("slider");

    act(() => {
      fireEvent.keyDown(noveltySlider, { key: "ArrowRight" });
    });

    const moved = useCameraGateDebugStore.getState().overrides.noveltyThreshold;
    expect(moved).toBeGreaterThan(DEFAULT_FRAME_GATE_OPTIONS.noveltyThreshold);
    expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(moved);
  });

  test("the affordance that says it can be closed closes it", () => {
    openSheet();

    // The grabber sits inside the sheet, whose surface takes every press out
    // of the room's reach. The dismissal rides the tap that follows rather
    // than the press, so taking the press costs it nothing.
    act(() => {
      fireEvent.click(screen.getByTestId("frame-gate-hud-collapse"));
    });

    expect(sheet()).toBeNull();
    expect(strip()).not.toBeNull();
  });

  /**
   * Dismissal by tap, which nothing else here delivers: a document-level
   * `click` listener would never hear a tap on the bare viewfinder this opens
   * over, since WebKit synthesizes no click for a noninteractive target.
   */
  describe("the backdrop", () => {
    test("is absent while the readout is a strip, so it swallows nothing", () => {
      isMobileRef.value = true;
      renderCollapsible();

      expect(backdrop()).toBeNull();
    });

    test("carries its own click handler rather than leaving it to the document", () => {
      openSheet();

      expect(backdrop()?.onclick).toBeTruthy();
    });

    test("closes the sheet on a tap, and goes with it", () => {
      openSheet();
      expect(backdrop()).not.toBeNull();

      act(() => {
        fireEvent.click(backdrop()!);
      });

      // Gone as well as closed: the shutter underneath is the press this must
      // not go on intercepting.
      expect(sheet()).toBeNull();
      expect(backdrop()).toBeNull();
    });

    test("is painted under the sheet, so a press inside the sheet is the sheet's", () => {
      openSheet();

      // One tier for both, since the pair is one surface over the room; what
      // settles a tie at one tier is document order, and the sheet is second.
      expect(backdrop()?.className).toContain("z-30");
      expect(sheet()?.className).toContain("z-30");
      expect(
        backdrop()!.compareDocumentPosition(sheet()!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeGreaterThan(0);
    });
  });

  /**
   * The room the sheet opens in is dragged down to minimize the call, and
   * `voice-room.tsx` starts that drag from a React `onPointerDown` on the
   * room's own element rather than from Motion's own listener, exactly so a
   * surface inside the room can decline to pass a press on. A swipe down the
   * readout is the same gesture as a pull on the room, so the sheet has to be
   * the one that keeps it.
   *
   * The gesture loop itself needs a layout engine, so what these render is the
   * room's shape rather than the room: one drag surface carrying the press
   * handler the room carries, with the readout mounted inside it. What is
   * asserted is the thing the loop turns on, which presses the room is asked to
   * start a drag from.
   */
  describe("the room's drag", () => {
    test("is never asked to start from a press inside the sheet", () => {
      const roomPress = openSheetInRoom();

      fireEvent.pointerDown(screen.getByRole("button", { name: "Reset" }));

      expect(roomPress).not.toHaveBeenCalled();
    });

    test("is never asked to start from a press on the backdrop", () => {
      const roomPress = openSheetInRoom();

      // A press there is aimed at dismissing the readout. Letting it open a
      // drag would answer a tap that missed by a few pixels by pulling the
      // whole call toward a minimize.
      fireEvent.pointerDown(backdrop()!);
      expect(roomPress).not.toHaveBeenCalled();

      // And the dismissal it was aimed at still happens, since only the press
      // was kept and the tap rides on.
      act(() => {
        fireEvent.click(backdrop()!);
      });
      expect(sheet()).toBeNull();
    });

    test("is asked to start from everything the readout has not covered", () => {
      isMobileRef.value = true;
      const roomPress = renderRoom();

      fireEvent.pointerDown(screen.getByTestId("bare-chrome"));
      expect(roomPress).toHaveBeenCalledTimes(1);

      // The strip included: it is chrome over the feed, not a surface with a
      // gesture of its own.
      fireEvent.pointerDown(strip()!);
      expect(roomPress).toHaveBeenCalledTimes(2);
    });

    test("a threshold slider inside the open sheet still moves the gate", () => {
      const roomPress = openSheetInRoom();
      const slider = sliderSurface("noveltyThreshold");
      // The gate reads a fraction of the track, and happy-dom lays nothing
      // out, so the track is given a width to be a fraction of.
      slider.getBoundingClientRect = () => TRACK_RECT;

      act(() => {
        fireEvent.pointerDown(slider, { clientX: 100, pointerId: 1 });
      });

      // The end of the whole argument: React hands its delegated press to the
      // slider's own handler even though the sheet keeps the press from the
      // room, so the control the sheet exists to expose actually works, and the
      // room was never asked to drag while it happened.
      const moved =
        useCameraGateDebugStore.getState().overrides.noveltyThreshold;
      expect(moved).toBe(1);
      expect(FRAME_GATE_LIVE_OPTIONS.noveltyThreshold).toBe(1);
      expect(roomPress).not.toHaveBeenCalled();
    });

    test("the sheet asks the browser back for the vertical pan", () => {
      openSheet();

      // The room carries `pan-x` for as long as it is draggable, which is how
      // it stops the browser scrolling under the gesture it owns. Keeping the
      // press does not give that back; the sheet has to say so.
      expect(sheet()?.style.touchAction).toBe("pan-y");
    });
  });
});
