import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

const moveByMock = mock((_dx: number, _dy: number) => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);
const activateMock = mock(() => undefined);
const toggleWatchMock = mock(() => undefined);

const STATE: CompanionSurfaceState = {
  growth: "right",
  cardGrowth: "up",
  avatarBox: 44,
  call: null,
  assistantName: "Ziggy",
  turns: [],
  working: false,
};

/** Reset between cases, since `STATE` is what the mocked bridge hands back. */
const resetState = () => {
  STATE.working = false;
  STATE.call = null;
  delete STATE.watching;
  delete STATE.captureCount;
};

mock.module("@/runtime/companion-surface", () => ({
  getCompanionState: async () => STATE,
  subscribeCompanionState: () => () => undefined,
  setCompanionInteractive: setInteractiveMock,
  moveCompanionBy: moveByMock,
  activateCompanionApp: activateMock,
  startCompanionVoice: () => undefined,
  toggleCompanionWatch: toggleWatchMock,
  submitCompanionMessage: () => undefined,
  setCompanionComposing: () => undefined,
  setCompanionContext: () => undefined,
}));

mock.module("@/runtime/desktop-voice-activity", () => ({
  sendVoiceActivityControl: () => undefined,
}));

const { CompanionSurfacePage } = await import("./companion-surface-page");

afterEach(() => {
  cleanup();
  resetState();
  moveByMock.mockClear();
  setInteractiveMock.mockClear();
  activateMock.mockClear();
  toggleWatchMock.mockClear();
});

/** The canvas the page fills, which is where the pointer handlers live. */
const canvasOf = (container: HTMLElement): HTMLElement => {
  const canvas = container.firstElementChild;
  if (!(canvas instanceof HTMLElement)) {
    throw new Error("Expected the canvas root to render");
  }
  return canvas;
};

/**
 * The pill, pinned somewhere the hit-test can find it.
 *
 * The surface measures itself live, and nothing lays out in the test DOM, so
 * every rect would otherwise be zero and the pointer would never be over the
 * pill at all.
 */
const pinPill = async (container: HTMLElement): Promise<HTMLElement> => {
  const pill = await waitFor(() => {
    const found = container.querySelector<HTMLElement>(".cursor-grab");
    if (!found) {
      throw new Error("Expected the pill to render");
    }
    return found;
  });
  pill.getBoundingClientRect = () =>
    ({
      left: 100,
      right: 144,
      top: 100,
      bottom: 144,
      x: 100,
      y: 100,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    }) as DOMRect;
  return pill;
};

/** The avatar inside the pill, which is what a press "goes back to Vellum". */
const avatarOf = (container: HTMLElement): HTMLElement => {
  const avatar = container.querySelector<HTMLElement>(".place-items-center");
  if (!avatar) {
    throw new Error("Expected the avatar to render");
  }
  return avatar;
};

describe("dragging the companion surface", () => {
  test("moves the window by the pointer's travel", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 530,
      screenY: 520,
      buttons: 1,
    });

    expect(moveByMock.mock.calls).toEqual([[30, 20]]);
  });

  /**
   * The brick: a release this window never saw used to leave the press running
   * forever, so the surface chased a pointer with no button held and the window
   * stayed clickable across the whole canvas.
   */
  test("ends a drag whose release landed outside the window", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 520,
      screenY: 500,
      buttons: 1,
    });
    moveByMock.mockClear();

    // The button came up over another app, so no `mouseup` and no `mouseleave`
    // ever reached this window. The pointer comes back a long way away.
    fireEvent.mouseMove(canvas, {
      clientX: 900,
      clientY: 900,
      screenX: 1300,
      screenY: 1200,
      buttons: 0,
    });

    expect(moveByMock).not.toHaveBeenCalled();
  });

  test("hit-tests again once the abandoned drag is dropped", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 520,
      screenY: 500,
      buttons: 1,
    });

    // Off the pill with the button already released: the window has to go back
    // to click-through, or it swallows every press on this corner of the
    // desktop until the app is relaunched.
    fireEvent.mouseMove(canvas, {
      clientX: 900,
      clientY: 900,
      screenX: 1300,
      screenY: 1200,
      buttons: 0,
    });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  test("a press that travelled is not a click on the avatar", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 540,
      screenY: 500,
      buttons: 1,
    });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatarOf(container));

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("a press that held still still goes back to Vellum", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatarOf(container));

    expect(activateMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The working ring is fed by two independent things: a live call's own phase,
 * and the flag the window owning the conversation publishes. A typed turn has
 * no call behind it, so it rides entirely on the flag, and these cover that it
 * survives the trip through main rather than only through the component.
 */
describe("the working ring on the page", () => {
  test("lights for a typed turn, with no call running", async () => {
    STATE.working = true;

    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(
        container.querySelector(".companion-working-ring"),
      ).not.toBeNull();
    });
  });

  test("stays dark when nothing is running", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinPill(container);

    expect(container.querySelector(".companion-working-ring")).toBeNull();
  });
});

/**
 * The session is not this window's: main holds it and pushes it down with the
 * rest of the state, and the press goes back out the same way. What this page
 * owns is passing both halves through, which are two props rather than one
 * because the phase a running session opens is outranked by a half-typed
 * sentence and by a call, and the indicator is not.
 */
describe("the watch session on the companion surface", () => {
  const watchOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Watch"]',
    );
    if (!found) {
      throw new Error("Expected Watch to render");
    }
    return found;
  };

  test("hands the press back to the window holding the session", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinPill(container);
    const canvas = canvasOf(container);
    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });

    fireEvent.click(watchOf(container));

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
  });

  test("holds the pill open while a session runs, hand or no hand", async () => {
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(container.querySelector("[inert]")).toBeNull();
    });
  });

  test("draws the session as running", async () => {
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
    });
  });

  /**
   * The session's screen reads reach this window the same way the flag does,
   * and they are the half nothing else can stand in for: the flag says a
   * session is open and only the count says the screen has actually been read.
   */
  test("draws a capture the session reported", async () => {
    STATE.watching = true;
    STATE.captureCount = 1;
    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(
        container.querySelector(".companion-capture-pulse"),
      ).not.toBeNull();
    });
  });

  /**
   * A state that cannot say how many reads a session has taken has not
   * established that it took any, the same bargain the flag itself is given.
   */
  test("reads a state that says nothing about captures as none", async () => {
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => {
      expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
    });

    expect(container.querySelector(".companion-capture-pulse")).toBeNull();
  });

  /**
   * Absence is not a session, so a state pushed by a main process that tracks
   * none at all reads as nothing running. The alternative is a capture
   * indicator over a machine nobody is reading.
   */
  test("reads a state that says nothing about it as no session", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinPill(container);
    fireEvent.mouseMove(canvasOf(container), { clientX: 120, clientY: 120 });

    await waitFor(() => {
      expect(watchOf(container).getAttribute("aria-pressed")).toBe("false");
    });
  });

  /**
   * The stop control has to reach as far as the indicator does, and the
   * indicator outlives the phase: a session still running under a half-typed
   * sentence that the user cannot end is worse than no indicator at all.
   */
  test("keeps a way out of the session while the composer is open", async () => {
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinPill(container);
    fireEvent.mouseMove(canvasOf(container), { clientX: 120, clientY: 120 });
    fireEvent.click(
      await waitFor(() => {
        const type = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Type"]',
        );
        if (!type) {
          throw new Error("Expected Type to render");
        }
        return type;
      }),
    );

    const stop = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop watching"]',
      );
      if (!found) {
        throw new Error("Expected the stop control to render");
      }
      return found;
    });
    fireEvent.click(stop);

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
  });
});
