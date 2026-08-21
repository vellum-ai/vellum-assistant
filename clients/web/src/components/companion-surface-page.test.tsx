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
  STATE.working = false;
  STATE.call = null;
  delete STATE.watching;
  delete STATE.captureCount;
  STATE.watchEnabled = true;
  STATE.intro = null;
  STATE.assistantName = "Ziggy";
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
      expect(container.querySelector(".companion-working-ring")).not.toBeNull();
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
      'button[aria-label="Teach"]',
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
    // Well clear of the pill's box in `pinPill`, so a pointer on one is
    // provably not on the other.
    card.getBoundingClientRect = () =>
      ({
        left: 300,
        right: 544,
        top: 300,
        bottom: 380,
        x: 300,
        y: 300,
        width: 244,
        height: 80,
        toJSON: () => ({}),
      }) as DOMRect;
    return card;
  };

  test("draws nothing while no run is due", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinPill(container);
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
    await pinPill(container);
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
    const pill = await pinPill(container);
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
    await pinPill(container);
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
    await pinPill(container);
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
    await pinPill(container);
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
    await pinPill(container);
    fireEvent.mouseMove(canvasOf(container), { clientX: 120, clientY: 120 });
    await waitFor(() => {
      if (!container.querySelector('button[aria-label="Talk"]')) {
        throw new Error("Expected the pill to open");
      }
    });
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
    await pinPill(container);
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
  test("a right-click asks main to open it", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const pill = await pinPill(container);

    fireEvent.contextMenu(pill);

    expect(contextMenuMock).toHaveBeenCalled();
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
    const pill = await pinPill(container);

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
    const pill = await pinPill(container);
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
