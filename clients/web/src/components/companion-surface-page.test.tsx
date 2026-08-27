import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

const moveByMock = mock((_dx: number, _dy: number) => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);
const activateMock = mock(() => undefined);
const toggleWatchMock = mock(() => undefined);
const answerRetroMock = mock((_open: boolean) => undefined);
const advanceIntroMock = mock((_action: string) => undefined);
const contextMenuMock = mock(() => undefined);

const STATE: CompanionSurfaceState = {
  growth: "right",
  cardGrowth: "up",
  avatarBox: 44,
  optionsBox: 44,
  call: null,
  assistantName: "Ziggy",
  turns: [],
  working: false,
  // Watch offered, which is what every case below except the flag's own is
  // about. The flag is main's answer and arrives on the state like everything
  // else here; the cases that care about it being absent say so.
  watchEnabled: true,
  intro: null,
};

/** Reset between cases, since `STATE` is what the mocked bridge hands back. */
const resetState = () => {
  STATE.avatarBox = 44;
  STATE.optionsBox = 44;
  STATE.working = false;
  STATE.call = null;
  delete STATE.watching;
  delete STATE.captureCount;
  STATE.watchEnabled = true;
  STATE.intro = null;
  STATE.assistantName = "Ziggy";
  delete STATE.character;
};

/**
 * The page's subscribers, so a case can push a second state the way main does.
 *
 * The state main hands back on mount is what this window inherits, and some of
 * what the page draws is a difference between that and what arrives after, so
 * a bridge that only ever answers once cannot express it.
 */
const listeners = new Set<(state: CompanionSurfaceState) => void>();

/**
 * Push a state to the mounted page, inside `act` so React settles.
 *
 * With no argument it publishes the current `STATE`, which is how the cases
 * that mutate that object drive a change; with one it pushes exactly what it
 * was handed, which is how the cases about the difference between two states
 * drive theirs.
 */
const pushState = (state: CompanionSurfaceState = { ...STATE }) => {
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
  setCompanionInteractive: setInteractiveMock,
  moveCompanionBy: moveByMock,
  activateCompanionApp: activateMock,
  startCompanionVoice: () => undefined,
  toggleCompanionWatch: toggleWatchMock,
  // Stubbed rather than omitted: the page statically imports it, and a
  // missing export is a load-time failure for the whole file.
  answerCompanionWatchRetro: answerRetroMock,
  submitCompanionMessage: () => undefined,
  setCompanionComposing: () => undefined,
  setCompanionContext: () => undefined,
  advanceCompanionIntro: advanceIntroMock,
  showCompanionContextMenu: contextMenuMock,
  openCompanionLink: () => undefined,
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
  advanceIntroMock.mockClear();
  contextMenuMock.mockClear();
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
 * Whether the pill is open, read off the collapsed body's `inert`: the controls
 * stay mounted at rest so they can be measured, so their presence says nothing
 * and their being out of the tree says everything.
 */
const closed = (container: HTMLElement): boolean =>
  container.querySelector("[inert]") !== null;

/** Open the surface by putting the pointer on the creature. */
const open = async (container: HTMLElement): Promise<HTMLElement> => {
  const canvas = canvasOf(container);
  fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
  await waitFor(() => {
    if (closed(container)) {
      throw new Error("Expected the pill to open");
    }
  });
  return canvas;
};

/** A box the hit-test can read, which jsdom otherwise reports as all zeroes. */
type Box = { left: number; right: number; top: number; bottom: number };

const pin = (element: HTMLElement, box: Box): void => {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      toJSON: () => ({}),
    }) as DOMRect;
};

/**
 * The avatar and the pill, pinned somewhere the hit-test can find them.
 *
 * The surface measures itself live and nothing lays out in the test DOM, so
 * every rect would otherwise be zero and the pointer would never be over any of
 * it. Pinned by default as the surface draws them at the pair the layout is
 * authored at: the avatar's 44pt box, and the pill bottom-flush across a 12pt
 * gap to its right. A case drawing another pair hands in its own boxes.
 */
const pinSurface = async (
  container: HTMLElement,
  boxes: { avatar: Box; pill: Box } = {
    avatar: { left: 100, right: 144, top: 100, bottom: 144 },
    pill: { left: 156, right: 356, top: 100, bottom: 144 },
  },
): Promise<{ avatar: HTMLElement; pill: HTMLElement }> => {
  const found = await waitFor(() => {
    const avatar = container.querySelector<HTMLElement>(".size-11");
    const pill = container.querySelector<HTMLElement>(
      ".transition-\\[width\\]",
    );
    if (!avatar || !pill) {
      throw new Error("Expected the surface to render");
    }
    return { avatar, pill };
  });
  pin(found.avatar, boxes.avatar);
  pin(found.pill, boxes.pill);
  return found;
};

/**
 * The surface is a union of rects, and this is the one nothing draws into.
 *
 * The avatar and the pill are separate elements with a gap between them, and
 * the pointer crosses that gap on the way from the creature to the controls. A
 * window that went click-through halfway would drop the press the user was
 * travelling to make, and one that claimed the whole box around the pair would
 * swallow desktop presses in the empty canvas above and below it.
 */
describe("the gap between the avatar and the pill", () => {
  test("keeps the window clickable and the pill open as it is crossed", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    const canvas = await open(container);

    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 122 });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);
    expect(closed(container)).toBe(false);
  });

  test("carries the pointer on to the pill itself", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    const canvas = await open(container);

    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 122 });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);
    expect(closed(container)).toBe(false);
  });

  /**
   * The bridge runs the pill's own height and no further, so a press aimed past
   * it lands on whatever the user actually has behind the surface.
   */
  test("gives the desktop back above and below it", async () => {
    for (const clientY of [90, 160]) {
      const { container } = render(<CompanionSurfacePage />);
      await pinSurface(container);
      const canvas = await open(container);

      fireEvent.mouseMove(canvas, { clientX: 150, clientY });

      expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
      cleanup();
      setInteractiveMock.mockClear();
    }
  });

  /** At rest the pill's box is nothing, so there is nothing to bridge to. */
  test("is not part of the surface while the pill is closed", async () => {
    const { container } = render(<CompanionSurfacePage />);
    // The collapsed pill as the surface draws it: across the gap from the
    // creature at no width at all.
    await pinSurface(container, {
      avatar: { left: 100, right: 144, top: 100, bottom: 144 },
      pill: { left: 156, right: 156, top: 100, bottom: 144 },
    });

    fireEvent.mouseMove(canvasOf(container), { clientX: 150, clientY: 122 });

    expect(setInteractiveMock).not.toHaveBeenCalledWith(true);
    expect(closed(container)).toBe(true);
  });
});

/**
 * The pill outlives the phase that opened it.
 *
 * The pointer leaving puts the phase back to resting at once, and the pill
 * spends the next 300ms giving its width back. A window that stopped
 * hit-testing it there would be click-through over controls that are still on
 * screen, and a press aimed at one of them would land in whatever application
 * is behind the surface. So the measured width is what decides, and a pointer
 * that comes back finds the pill and re-opens it.
 */
describe("the pill while it is collapsing", () => {
  test("is still part of the surface under a returning pointer", async () => {
    const { container } = render(<CompanionSurfacePage />);
    // Resting, with the pill still drawn at a width it has not finished giving
    // back: the state the surface holds for the length of the transition.
    await pinSurface(container);

    fireEvent.mouseMove(canvasOf(container), { clientX: 200, clientY: 122 });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);
    await waitFor(() => {
      if (closed(container)) {
        throw new Error("Expected the pill to open again");
      }
    });
  });

  test("gives the desktop back once that width is gone", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container, {
      avatar: { left: 100, right: 144, top: 100, bottom: 144 },
      pill: { left: 156, right: 156, top: 100, bottom: 144 },
    });

    fireEvent.mouseMove(canvasOf(container), { clientX: 200, clientY: 122 });

    expect(setInteractiveMock).not.toHaveBeenCalledWith(true);
    expect(closed(container)).toBe(true);
  });
});

/**
 * The two sizes, which are one choice each.
 *
 * The page holds no dimensions of its own: it hands the surface both boxes and
 * the surface scales its own outermost element by the options one. What is
 * worth holding here is that the surface is what fills the canvas and that the
 * sizes main pushes reach it. The hit-test needs nothing new for either, since
 * it reads rects off the DOM after the transforms, and the case that proves it
 * is the dead corner beside a creature far taller than the pill beside it.
 */
describe("the companion surface at two sizes", () => {
  /**
   * The surface's own outermost element, which the page draws straight into the
   * canvas rather than inside a scaled box of its own.
   */
  const wrapperOf = (container: HTMLElement): HTMLElement => {
    const found = canvasOf(container).firstElementChild;
    if (!(found instanceof HTMLElement)) {
      throw new Error("Expected the surface to render inside the canvas");
    }
    if (!found.className.includes("origin-top-left")) {
      throw new Error("Expected the surface's scaled box to be that element");
    }
    return found;
  };

  test("draws the surface itself into the canvas at the pushed options size", async () => {
    STATE.avatarBox = 44;
    STATE.optionsBox = 110;
    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(wrapperOf(container).style.transform).toBe("scale(2.5)");
    });
    // Nothing of the page's own between the canvas and the surface.
    expect(canvasOf(container).children).toHaveLength(1);
  });

  /**
   * A shell that predates the second axis publishes one box for the surface.
   * Falling back to the authored size instead would draw a 44pt pill beside a
   * creature the user had sized well past it.
   */
  test("sizes the pill by the creature when the state carries one box", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => {
      expect(wrapperOf(container).style.transform).toBe("scale(1)");
    });

    pushState({
      ...STATE,
      avatarBox: 110,
      optionsBox: undefined,
    });

    await waitFor(() => {
      expect(wrapperOf(container).style.transform).toBe("scale(2.5)");
    });
  });

  test("leaves that scale alone when only the creature grows", async () => {
    STATE.avatarBox = 220;
    STATE.optionsBox = 44;
    const { container } = render(<CompanionSurfacePage />);

    // The creature's own node is where the change lands, so waiting on it is
    // waiting for the state to have arrived at all.
    await waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(".size-11")?.style.transform,
      ).toBe("translate(-50%, -50%) scale(5)");
    });
    expect(wrapperOf(container).style.transform).toBe("scale(1)");
  });

  /**
   * The dead corner: outside the creature's own box, above everything the pill
   * occupies, and well inside the box drawn around the pair. A window that
   * claimed it would swallow the presses meant for whatever the user actually
   * has behind the surface, which is the failure every note in this file is
   * about.
   */
  test("gives the desktop back beside a creature taller than the pill", async () => {
    STATE.avatarBox = 110;
    STATE.optionsBox = 44;
    const { container } = render(<CompanionSurfacePage />);
    // As the surface draws them at this pair: a 110pt creature, and the pill
    // bottom-flush across the gap, 44pt tall in the creature's lower portion.
    await pinSurface(container, {
      avatar: { left: 100, right: 210, top: 100, bottom: 210 },
      pill: { left: 222, right: 422, top: 166, bottom: 210 },
    });

    // Open it from the creature, which is the only part drawn at rest.
    const canvas = await open(container);
    setInteractiveMock.mockClear();

    fireEvent.mouseMove(canvas, { clientX: 216, clientY: 120 });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });
});

describe("dragging the companion surface", () => {
  /**
   * Both drawn halves are handles. The drag is a window move, so whichever the
   * hand happens to land on takes the whole surface with it, and a creature
   * that could not be grabbed would be the part users reach for first.
   */
  test("moves the window by the pointer's travel, from either half", async () => {
    for (const half of ["avatar", "pill"] as const) {
      const { container } = render(<CompanionSurfacePage />);
      const pinned = await pinSurface(container);
      const canvas = canvasOf(container);

      fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
      fireEvent.mouseDown(pinned[half], { screenX: 500, screenY: 500 });
      fireEvent.mouseMove(canvas, {
        clientX: 120,
        clientY: 120,
        screenX: 530,
        screenY: 520,
        buttons: 1,
      });

      expect(moveByMock.mock.calls).toEqual([[30, 20]]);
      cleanup();
      moveByMock.mockClear();
    }
  });

  /**
   * The brick: a release this window never saw used to leave the press running
   * forever, so the surface chased a pointer with no button held and the window
   * stayed clickable across the whole canvas.
   */
  test("ends a drag whose release landed outside the window", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
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
    const { pill } = await pinSurface(container);
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
    const { avatar, pill } = await pinSurface(container);
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
    fireEvent.click(avatar);

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("a press that held still still goes back to Vellum", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { avatar, pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.mouseDown(pill, { screenX: 500, screenY: 500 });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatar);

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
      expect(container.querySelector(".companion-working-ring")).not.toBeNull();
    });
  });

  test("stays dark when nothing is running", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

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
      'button[aria-label="Teach"]',
    );
    if (!found) {
      throw new Error("Expected Watch to render");
    }
    return found;
  };

  test("hands the press back to the window holding the session", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
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
    STATE.captureCount = 3;
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => {
      expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
    });

    pushState({ ...STATE, captureCount: 4 });

    expect(container.querySelector(".companion-capture-pulse")).not.toBeNull();
  });

  /**
   * This window is recreated on every reload, and main answers the new one
   * with the total it has been keeping. That number stands for reads taken
   * before this window existed, so drawing it would present the last of them
   * as one happening now.
   */
  test("does not draw a capture it only inherited from main", async () => {
    STATE.watching = true;
    STATE.captureCount = 3;
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => {
      expect(watchOf(container).getAttribute("aria-pressed")).toBe("true");
    });

    expect(container.querySelector(".companion-capture-pulse")).toBeNull();
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
    await pinSurface(container);
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
    await pinSurface(container);
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
        'button[aria-label="Stop teaching"]',
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

/**
 * The one-time introduction, which is the only thing this surface ever draws
 * that the user did not ask for. Main decides whether a run is due and holds
 * the beat; these are about what the page does with the one it is handed.
 */
describe("the companion's introduction", () => {
  /** The introduction's card, pinned somewhere the hit-test can find it. */
  const pinCard = async (container: HTMLElement): Promise<HTMLElement> => {
    const card = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[role="group"]');
      if (!found) {
        throw new Error("Expected the introduction card to render");
      }
      return found;
    });
    // Well clear of the boxes `pinSurface` gives the avatar and the pill, so a
    // pointer on one is provably not on the other.
    pin(card, { left: 300, right: 544, top: 300, bottom: 380 });
    return card;
  };

  test("draws nothing while no run is due", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  test("draws the beat main is holding", async () => {
    STATE.intro = "meet";
    const { container } = render(<CompanionSurfacePage />);
    const card = await pinCard(container);
    // The creature introduces itself by name. The surface is the one place it
    // appears with none of the app around it to say whose it is.
    expect(card.textContent).toContain("I’m Ziggy");
  });

  /**
   * A cold launch reaches the surface before the app's window has published a
   * name, and the first beat is the one most likely to be on screen when it
   * does. The unnamed version is a different sentence rather than the same one
   * with a hole where the name goes.
   */
  test("introduces the creature unnamed until a name arrives", async () => {
    STATE.intro = "meet";
    STATE.assistantName = "";
    const { container } = render(<CompanionSurfacePage />);
    const card = await pinCard(container);
    expect(card.textContent).toContain("This is me");
  });

  test("a press asks main to move the run on", async () => {
    STATE.intro = "meet";
    const { container } = render(<CompanionSurfacePage />);
    const card = await pinCard(container);
    const next = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent === "Next",
    );
    fireEvent.click(next as HTMLElement);
    expect(advanceIntroMock.mock.calls).toEqual([["next"]]);
  });

  test("Skip ends the run rather than advancing it", async () => {
    STATE.intro = "meet";
    const { container } = render(<CompanionSurfacePage />);
    const card = await pinCard(container);
    const skip = Array.from(card.querySelectorAll("button")).find(
      (button) => button.textContent === "Skip",
    );
    fireEvent.click(skip as HTMLElement);
    expect(advanceIntroMock.mock.calls).toEqual([["dismiss"]]);
  });

  /**
   * The window is click-through everywhere it has not been told otherwise, so a
   * card that did not make it interactive would put Next and Skip on screen
   * with every press on them landing in whatever app is behind.
   */
  test("makes the window clickable while the pointer is on the card", async () => {
    STATE.intro = "meet";
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    await pinCard(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 320, clientY: 320 });

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);
  });

  /**
   * Hover is the creature noticing a hand on itself. A pointer resting on a
   * paragraph beside it is not that, and widening the eyes for it would be the
   * surface reacting to the wrong thing.
   */
  test("does not read a pointer on the card as hovering the avatar", async () => {
    STATE.intro = "meet";
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    await pinCard(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 320, clientY: 320 });

    // At rest the pill is the avatar's own box. Expanded it is wider, so the
    // class the resting state carries is what says hover was not taken.
    expect(pill.className).toContain("h-11");
  });

  /**
   * The card is hit-tested as part of the surface, so a pointer resting on it
   * has left the window clickable. Ending the run removes the card from under
   * that pointer without a mouse-move, and left alone the window stays
   * clickable across a canvas many times the size of the pill, swallowing
   * presses meant for whatever the user was working in.
   */
  test("gives the desktop back when the run ends under the pointer", async () => {
    STATE.intro = "menu";
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    await pinCard(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 320, clientY: 320 });
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([true]);

    // "Got it": main records the run and pushes a state with no beat left.
    STATE.intro = null;
    pushState();

    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  /**
   * A run still going when the user takes a call is a caption over something
   * they are in the middle of. The session outranks it, the way it outranks the
   * pointer.
   */
  test("gives way to a running call", async () => {
    STATE.intro = "talk";
    STATE.call = {
      phase: "listening",
      label: "Listening",
      accentHex: "#5eead4",
      muted: false,
      outputMuted: false,
      detail: "",
      approvalRequestId: "",
      assistantName: "Ziggy",
    };
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  /**
   * Withdrawn rather than ended, so main still holds the beat: a call that
   * interrupted the run must not cost the user the rest of it.
   */
  test("comes back once the call is over", async () => {
    STATE.intro = "talk";
    STATE.call = {
      phase: "listening",
      label: "Listening",
      accentHex: "#5eead4",
      muted: false,
      outputMuted: false,
      detail: "",
      approvalRequestId: "",
      assistantName: "Ziggy",
    };
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(container.querySelector('[role="group"]')).toBeNull();

    STATE.call = null;
    pushState();

    expect(container.querySelector('[role="group"]')).not.toBeNull();
  });
});

/**
 * The Watch flag, which this window cannot evaluate for itself.
 *
 * The route is standalone: no auth, no `RootLayout`, and so no flag store that
 * ever settles. Main reads the evaluation the app's window wrote into settings
 * and pushes it here, and this page's whole job is to believe only a positive
 * answer.
 */
describe("the Watch flag on the companion surface", () => {
  const watchButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Teach"]');

  /** Open the pill, which is where the way into a session would be drawn. */
  const openPill = async (container: HTMLElement): Promise<void> => {
    await pinSurface(container);
    await open(container);
  };

  test("draws no way in when the pushed state says nothing about it", async () => {
    delete STATE.watchEnabled;
    const { container } = render(<CompanionSurfacePage />);
    await openPill(container);

    expect(watchButton(container)).toBeNull();
  });

  test("draws no way in when the pushed state says no", async () => {
    STATE.watchEnabled = false;
    const { container } = render(<CompanionSurfacePage />);
    await openPill(container);

    expect(watchButton(container)).toBeNull();
  });

  test("draws the way in when the pushed state says yes", async () => {
    STATE.watchEnabled = true;
    const { container } = render(<CompanionSurfacePage />);
    await openPill(container);

    expect(watchButton(container)).not.toBeNull();
  });

  /**
   * The flag hides the door and never the exit. A session that outlives the
   * answer is still reading the screen, and a capture the user cannot end is
   * the one thing this surface exists to prevent.
   */
  test("keeps a way out of a session the flag no longer offers", async () => {
    STATE.watchEnabled = false;
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.mouseMove(canvasOf(container), { clientX: 120, clientY: 120 });

    const stop = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop teaching"]',
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

/**
 * The surface's own menu. The tray is the only other way to resize or hide the
 * companion, and it names a menu-bar icon rather than the thing on screen, so a
 * press on the object itself is where a user reaches first.
 */
describe("the companion's own menu", () => {
  /**
   * On the creature as much as on the pill: a user reaching for "make this go
   * away" should not have to find the one of the two that carries the menu.
   */
  test("a right-click on either half asks main to open it", async () => {
    for (const half of ["avatar", "pill"] as const) {
      const { container } = render(<CompanionSurfacePage />);
      const pinned = await pinSurface(container);

      fireEvent.contextMenu(pinned[half]);

      expect(contextMenuMock).toHaveBeenCalled();
      cleanup();
      contextMenuMock.mockClear();
    }
  });

  /**
   * A right-click must not arm the drag. The menu takes the pointer for as long
   * as it is open, so the `mouseup` that ends a press never reaches this
   * window: the surface would follow the pointer afterwards with no button
   * held, which is the stuck-drag bug with a different trigger.
   */
  /**
   * The card carries a composer and selectable prose, and the host's own text
   * menu is the only way to copy either. Replacing it with "Small / Medium /
   * Large" would take Cut, Copy, Paste and the spelling suggestions away.
   */
  test("leaves the native text menu alone inside the composer", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);

    // Open the composer, which is what puts a field on the card.
    const type = Array.from(pill.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Type",
    );
    fireEvent.click(type as HTMLElement);
    const field = await waitFor(() => {
      const found = container.querySelector("input");
      if (!found) {
        throw new Error("Expected the composer field to render");
      }
      return found;
    });

    fireEvent.contextMenu(field);

    expect(contextMenuMock).not.toHaveBeenCalled();
  });

  test("a right-press does not start a drag", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    // button 2 is the right button; the drag arms only on the left.
    fireEvent.mouseDown(pill, { button: 2, screenX: 500, screenY: 500 });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 560,
      screenY: 540,
      buttons: 2,
    });

    expect(moveByMock).not.toHaveBeenCalled();
  });
});

/**
 * The glow is the assistant's own light, not the surface's: an idle companion
 * with no call running glows its character's accent, and a running call's
 * accent wins over it.
 */
describe("the companion's accent colour", () => {
  const CHARACTER = {
    bodyShape: "blob",
    eyeStyle: "curious",
    color: "orange",
  } as const;

  /** A call running, carrying whatever accent the case is about. */
  const listening = (accentHex: string): CompanionSurfaceState["call"] => ({
    phase: "listening",
    label: "Listening",
    accentHex,
    muted: false,
    outputMuted: false,
    detail: "",
    approvalRequestId: "",
    assistantName: "Ziggy",
  });

  /**
   * The glow is the only thing on the surface painted in the accent, so it is
   * where the resolved colour is read back from.
   *
   * Awaited, because the state the colour comes from arrives after mount, so
   * the first render is always the default.
   */
  const expectGlow = async (
    container: HTMLElement,
    hex: string,
  ): Promise<void> => {
    await waitFor(() => {
      const glow = container.querySelector<HTMLElement>(".companion-glow");
      if (!glow) {
        throw new Error("Expected the glow to render");
      }
      expect(glow.style.background.trim().toLowerCase()).toContain(hex);
    });
  };

  test("resolves the character's palette colour with no call running", async () => {
    STATE.character = { ...CHARACTER };
    const { container } = render(<CompanionSurfacePage />);

    await expectGlow(container, "#e9642f");
  });

  test("lets a running call's accent win", async () => {
    STATE.character = { ...CHARACTER };
    STATE.call = listening("#123456");
    const { container } = render(<CompanionSurfacePage />);

    await expectGlow(container, "#123456");
  });

  /**
   * The contract makes no promise the call's hex parses, and CSS drops an
   * invalid custom property silently, so an unusable accent falls through to
   * the character rather than being handed on.
   */
  test("ignores a call accent that is not a hex", async () => {
    STATE.character = { ...CHARACTER };
    STATE.call = listening("");
    const { container } = render(<CompanionSurfacePage />);

    await expectGlow(container, "#e9642f");
  });

  /**
   * An uploaded image has no palette colour to resolve, so the component's own
   * default is the last word rather than a colour guessed from nothing.
   */
  test("falls back to the component default without a character", async () => {
    const { container } = render(<CompanionSurfacePage />);

    await expectGlow(container, "#5eead4");
  });
});
