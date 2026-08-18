import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

const moveByMock = mock((_dx: number, _dy: number) => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);
const activateMock = mock(() => undefined);

const STATE: CompanionSurfaceState = {
  growth: "right",
  call: null,
  assistantName: "Ziggy",
  turns: [],
  working: false,
};

/** Reset between cases, since `STATE` is what the mocked bridge hands back. */
const resetState = () => {
  STATE.working = false;
  STATE.call = null;
};

mock.module("@/runtime/companion-surface", () => ({
  getCompanionState: async () => STATE,
  subscribeCompanionState: () => () => undefined,
  setCompanionInteractive: setInteractiveMock,
  moveCompanionBy: moveByMock,
  activateCompanionApp: activateMock,
  startCompanionVoice: () => undefined,
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
