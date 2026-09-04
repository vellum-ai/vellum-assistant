import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { CompanionSurfaceState } from "@vellumai/ipc-contract";

const moveByMock = mock((_dx: number, _dy: number) => undefined);
const setInteractiveMock = mock((_interactive: boolean) => undefined);
const activateMock = mock(() => undefined);
const startVoiceMock = mock(() => undefined);
const toggleWatchMock = mock((_pick?: unknown) => undefined);
const setScreenShareMock = mock((_pick?: unknown) => undefined);
/**
 * What the shell lists for the picker. Null is a shell with no picker to
 * offer, which is what a bridge that predates it answers.
 */
let captureSources: {
  displays: {
    kind: "display";
    displayId: number;
    index: number;
    primary: boolean;
  }[];
  tabs: {
    kind: "tab";
    chromeWindowId: number;
    tabIndex: number;
    title: string;
  }[];
  windows: { kind: "window"; windowId: number; title: string; app: string }[];
} | null = null;
const listSourcesMock = mock(async () => captureSources);
const answerRetroMock = mock((_open: boolean) => undefined);
const answerOfferMock = mock((_answer: string, _offerId: string) => undefined);
const advanceIntroMock = mock((_action: string) => undefined);
const contextMenuMock = mock(() => undefined);
const sendControlMock = mock((_control: { action: string }) => undefined);

const STATE: CompanionSurfaceState = {
  growth: "right",
  cardGrowth: "up",
  avatarBox: 44,
  optionsBox: 44,
  call: null,
  assistantName: "Ziggy",
  working: false,
  // Watch offered, which is what every case below except the flag's own is
  // about. The flag is main's answer and arrives on the state like everything
  // else here; the cases that care about it being absent say so.
  watchEnabled: true,
  intro: null,
};

/** The ordinary middle of a call, which is where the call row is drawn. */
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

/** Reset between cases, since `STATE` is what the mocked bridge hands back. */
const resetState = () => {
  STATE.avatarBox = 44;
  STATE.optionsBox = 44;
  STATE.working = false;
  STATE.call = null;
  delete STATE.dialing;
  delete STATE.watching;
  delete STATE.captureCount;
  delete STATE.watchTargets;
  delete STATE.captureTarget;
  delete STATE.screenShare;
  delete STATE.screenShareEnabled;
  STATE.watchEnabled = true;
  STATE.intro = null;
  STATE.assistantName = "Ziggy";
  delete STATE.character;
  delete STATE.dictationOffer;
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
  startCompanionVoice: startVoiceMock,
  toggleCompanionWatch: toggleWatchMock,
  setCompanionScreenShare: setScreenShareMock,
  listCompanionCaptureSources: listSourcesMock,
  // Stubbed rather than omitted: the page statically imports it, and a
  // missing export is a load-time failure for the whole file.
  answerCompanionWatchRetro: answerRetroMock,
  answerCompanionDictationOffer: answerOfferMock,
  setCompanionContext: () => undefined,
  advanceCompanionIntro: advanceIntroMock,
  showCompanionContextMenu: contextMenuMock,
}));

mock.module("@/runtime/desktop-voice-activity", () => ({
  sendVoiceActivityControl: sendControlMock,
}));

const { CompanionSurfacePage } = await import("./companion-surface-page");

afterEach(() => {
  cleanup();
  resetState();
  moveByMock.mockClear();
  setInteractiveMock.mockClear();
  activateMock.mockClear();
  startVoiceMock.mockClear();
  toggleWatchMock.mockClear();
  setScreenShareMock.mockClear();
  listSourcesMock.mockClear();
  captureSources = null;
  answerOfferMock.mockClear();
  advanceIntroMock.mockClear();
  contextMenuMock.mockClear();
  sendControlMock.mockClear();
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

/**
 * Open the pill and put the pointer on the creature.
 *
 * Hover alone opens nothing now that the creature is the call button, so the
 * pill is opened the way every open pill is: by a state the user is in. A
 * session reading the screen is the smallest of those, one control wide.
 */
const open = async (container: HTMLElement): Promise<HTMLElement> => {
  const canvas = canvasOf(container);
  pushState({ ...STATE, watching: true });
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
 * The pill outlives the state that opened it.
 *
 * The session ending shuts the pill at once, and it spends the next 300ms
 * giving its width back. A window that stopped hit-testing it there would be
 * click-through over controls that are still on screen, and a press aimed at
 * one of them would land in whatever application is behind the surface. So
 * the measured width is what decides, and a pointer that comes back finds
 * the pill still drawn and keeps the window clickable for it.
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
      if (!closed(container)) {
        throw new Error("Expected the pill to stay shut for a hover alone");
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
      fireEvent.pointerDown(pinned[half], {
        button: 0,
        pointerId: 1,
        screenX: 500,
        screenY: 500,
      });
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
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
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
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
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
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
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

  test("a press that held still starts a call", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { avatar, pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatar);

    expect(startVoiceMock).toHaveBeenCalledTimes(1);
    expect(activateMock).not.toHaveBeenCalled();
  });

  /**
   * The creature is the call button when there is no call. On one, the press
   * goes back to Vellum instead, which is where the room and the transcript
   * are, and the same holds for a dial still waiting on its session.
   */
  test("a press that held still on a call goes back to Vellum", async () => {
    STATE.call = LISTENING_CALL;
    const { container } = render(<CompanionSurfacePage />);
    const { avatar, pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatar);

    expect(activateMock).toHaveBeenCalledTimes(1);
    expect(startVoiceMock).not.toHaveBeenCalled();
  });

  test("a press that held still on a dial goes back to Vellum too", async () => {
    STATE.dialing = true;
    const { container } = render(<CompanionSurfacePage />);
    const { avatar, pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseUp(canvas);
    fireEvent.click(avatar);

    expect(activateMock).toHaveBeenCalledTimes(1);
    expect(startVoiceMock).not.toHaveBeenCalled();
  });

  /**
   * The window is moved a message at a time, so it trails the hand, and a flick
   * outruns it far enough to carry the pointer past the canvas edge, which sits
   * a pad's width off the creature on the side the card does not grow into.
   * Handing the desktop back there would drop the grab under a button that is
   * still down.
   */
  test("keeps the drag alive when the pointer leaves the canvas mid-press", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 520,
      screenY: 500,
      buttons: 1,
    });
    expect(moveByMock.mock.calls).toEqual([[20, 0]]);
    moveByMock.mockClear();
    setInteractiveMock.mockClear();

    fireEvent.mouseLeave(canvas);

    expect(setInteractiveMock).not.toHaveBeenCalledWith(false);
    expect(moveByMock).not.toHaveBeenCalled();

    // Still the same grab, so the next frame moves the window by its own travel
    // rather than starting over from wherever the pointer reappeared.
    fireEvent.mouseMove(canvas, {
      clientX: 900,
      clientY: 900,
      screenX: 560,
      screenY: 530,
      buttons: 1,
    });

    expect(moveByMock.mock.calls).toEqual([[40, 30]]);
  });

  test("takes pointer capture on a left press and not on a right-click", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);
    const capture = spyOn(pill, "setPointerCapture").mockImplementation(
      () => undefined,
    );

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 7,
      screenX: 500,
      screenY: 500,
    });

    expect(capture.mock.calls).toEqual([[7]]);

    // A right-press opens the menu, which takes the pointer for as long as it
    // is up. Capturing it here would hold a grab nothing ever releases.
    fireEvent.pointerDown(pill, {
      button: 2,
      pointerId: 8,
      screenX: 500,
      screenY: 500,
    });

    expect(capture.mock.calls).toEqual([[7]]);
  });

  test("still hands the desktop back on a leave that follows the release", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 540,
      screenY: 500,
      buttons: 1,
    });
    fireEvent.mouseUp(canvas);
    fireEvent.mouseLeave(canvas);

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);
  });

  /**
   * The host can take the pointer away mid-drag, which releases the capture and
   * sends no `mouseup` after it. Nothing else reports that press: a leave that
   * came while the drag was live deferred to it and does not come again, so
   * the cancel has to end the drag and hand the desktop back by itself.
   */
  test("ends the drag and gives the desktop back when the host takes the pointer away", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(pill, {
      button: 0,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
    fireEvent.mouseMove(canvas, {
      clientX: 120,
      clientY: 120,
      screenX: 520,
      screenY: 500,
      buttons: 1,
    });
    expect(moveByMock.mock.calls).toEqual([[20, 0]]);
    moveByMock.mockClear();
    setInteractiveMock.mockClear();

    // The pointer is off the canvas with the button down, so the leave defers
    // to the drag and the window stays clickable for it.
    fireEvent.mouseLeave(canvas);
    expect(setInteractiveMock).not.toHaveBeenCalledWith(false);

    fireEvent.pointerCancel(canvas);

    expect(setInteractiveMock.mock.calls.at(-1)).toEqual([false]);

    fireEvent.mouseMove(canvas, {
      clientX: 900,
      clientY: 900,
      screenX: 560,
      screenY: 530,
      buttons: 1,
    });

    expect(moveByMock).not.toHaveBeenCalled();
  });
});

/**
 * The creature's working pose is fed by two independent things: a live call's
 * own phase, and the flag the window owning the conversation publishes. A
 * typed turn has no call behind it, so it rides entirely on the flag, and
 * these cover that it survives the trip through main rather than only through
 * the component.
 */
describe("the working pose on the page", () => {
  const CREATURE = { bodyShape: "burst", eyeStyle: "curious", color: "orange" };

  test("is held for a typed turn, with no call running", async () => {
    STATE.working = true;
    STATE.character = CREATURE;

    const { container } = render(<CompanionSurfacePage />);

    await waitFor(() => {
      expect(container.querySelector('[data-busy="true"]')).not.toBeNull();
    });
  });

  test("is dropped when nothing is running", async () => {
    STATE.character = CREATURE;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    expect(container.querySelector('[data-busy="true"]')).toBeNull();
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
  /** The way in, which is on the call row. */
  const watchOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Teach"]',
    );
    if (!found) {
      throw new Error("Expected Watch to render");
    }
    return found;
  };
  /**
   * The way out, which is what the idle pill draws for a running session and
   * so the one thing on it that says the screen is being read.
   */
  const stopOf = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop teaching"]',
    );

  test("hands the press back to the window holding the session", async () => {
    // From the call row, which is where Teach lives: the idle pill's one way
    // in is Talk.
    STATE.call = LISTENING_CALL;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

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
      expect(stopOf(container)).not.toBeNull();
    });
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
      expect(stopOf(container)).toBeNull();
    });
  });
});

/**
 * The picker Teach opens, when the window holding the session says it can be
 * told what to read. The choice is this page's; the pick leaves it the way
 * every press does.
 */
describe("the picker behind Teach", () => {
  const teachOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Teach"]',
    );
    if (!found) {
      throw new Error("Expected Teach to render");
    }
    return found;
  };
  const pickerOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>("[data-companion-capture-picker]");

  const SOURCES = {
    displays: [
      { kind: "display" as const, displayId: 1, index: 0, primary: true },
    ],
    tabs: [
      { kind: "tab" as const, chromeWindowId: 5, tabIndex: 2, title: "Docs" },
    ],
    windows: [
      {
        kind: "window" as const,
        windowId: 9,
        title: "Groceries",
        app: "Notes",
      },
    ],
  };

  beforeEach(() => {
    STATE.call = LISTENING_CALL;
    STATE.watchTargets = true;
    captureSources = SOURCES;
  });

  test("opens on Teach with what the shell lists, and holds Teach down", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    fireEvent.click(teachOf(container));

    await waitFor(() => {
      expect(pickerOf(container)).not.toBeNull();
      expect(
        container.querySelector('button[aria-label="Screen 1"]'),
      ).not.toBeNull();
    });
    expect(teachOf(container).getAttribute("aria-pressed")).toBe("true");
    expect(toggleWatchMock).not.toHaveBeenCalled();
  });

  test("a pick leaves as the toggle, and closes the picker", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Groceries (Notes)"]',
      );
      if (!found) {
        throw new Error("Expected the window row");
      }
      return found;
    });

    fireEvent.click(row);

    expect(toggleWatchMock).toHaveBeenCalledWith({
      kind: "window",
      windowId: 9,
    });
    expect(pickerOf(container)).toBeNull();
  });

  test("gives the desktop back when a pick removes the card under the pointer", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const canvas = canvasOf(container);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    const card = await waitFor(() => {
      const found = pickerOf(container);
      if (!found) {
        throw new Error("Expected the picker");
      }
      return found;
    });
    pin(card, { left: 100, right: 360, top: 400, bottom: 600 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 500 });
    expect(setInteractiveMock).toHaveBeenLastCalledWith(true);

    fireEvent.click(container.querySelector('button[aria-label="Screen 1"]')!);

    expect(setInteractiveMock).toHaveBeenLastCalledWith(false);
  });

  test("a second press of Teach closes it unanswered", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    await waitFor(() => {
      expect(pickerOf(container)).not.toBeNull();
    });

    fireEvent.click(teachOf(container));

    expect(pickerOf(container)).toBeNull();
    expect(toggleWatchMock).not.toHaveBeenCalled();
  });

  test("closes once a session starts, whoever started it", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    await waitFor(() => {
      expect(pickerOf(container)).not.toBeNull();
    });

    pushState({ ...STATE, watching: true });

    expect(pickerOf(container)).toBeNull();
  });

  test("closes with the call it sits over", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    await waitFor(() => {
      expect(pickerOf(container)).not.toBeNull();
    });

    pushState({ ...STATE, call: null });

    expect(pickerOf(container)).toBeNull();
  });

  /**
   * The window holding the session has not said its assistant can be told
   * what to read, so the press is what it always was: the whole screen.
   */
  test("is not offered where a session cannot be aimed", async () => {
    STATE.watchTargets = false;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    fireEvent.click(teachOf(container));

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
    expect(toggleWatchMock).toHaveBeenCalledWith();
    expect(pickerOf(container)).toBeNull();
    expect(listSourcesMock).not.toHaveBeenCalled();
  });

  /**
   * The list arrives after a round trip. A picker the user closed in the
   * meantime is not answered by it, least of all with the whole-screen
   * session a shell with nothing to list would otherwise start.
   */
  test("ignores a list that arrives after the picker was closed", async () => {
    let answer: ((listed: typeof captureSources) => void) | null = null;
    listSourcesMock.mockImplementationOnce(
      () =>
        new Promise<typeof captureSources>((resolve) => {
          answer = resolve;
        }),
    );
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    await waitFor(() => {
      expect(pickerOf(container)).not.toBeNull();
    });
    fireEvent.click(teachOf(container));
    expect(pickerOf(container)).toBeNull();

    await act(async () => {
      answer?.(null);
      await Promise.resolve();
    });

    expect(toggleWatchMock).not.toHaveBeenCalled();
    expect(pickerOf(container)).toBeNull();
  });

  test("starts the whole-screen session on a shell with nothing to list", async () => {
    captureSources = null;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    fireEvent.click(teachOf(container));

    await waitFor(() => {
      expect(toggleWatchMock).toHaveBeenCalledWith();
    });
    expect(pickerOf(container)).toBeNull();
  });

  test("makes the window clickable while the pointer is on the card", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const canvas = canvasOf(container);
    await pinSurface(container);
    fireEvent.click(teachOf(container));
    const card = await waitFor(() => {
      const found = pickerOf(container);
      if (!found) {
        throw new Error("Expected the picker");
      }
      return found;
    });
    pin(card, { left: 100, right: 360, top: 400, bottom: 600 });
    setInteractiveMock.mockClear();

    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 500 });

    expect(setInteractiveMock).toHaveBeenLastCalledWith(true);
  });

  test("the stop is never a question", async () => {
    STATE.watching = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    fireEvent.click(teachOf(container));

    expect(toggleWatchMock).toHaveBeenCalledWith();
    expect(pickerOf(container)).toBeNull();
  });
});

/**
 * The card holding out a dictation's words. This page owns neither the words
 * nor the pasteboard, so all it does with a press is name what was pressed
 * and which offer it was drawn against.
 */
describe("the offer of a dictation's words", () => {
  const offerCardOf = (container: HTMLElement): HTMLElement =>
    container.querySelector<HTMLElement>("[data-companion-dictation-offer]") ??
    (() => {
      throw new Error("Expected the offer card to render");
    })();

  const answerOf = (container: HTMLElement, label: string): HTMLButtonElement =>
    Array.from(offerCardOf(container).querySelectorAll("button")).find(
      (button) => button.textContent === label,
    ) ??
    (() => {
      throw new Error(`Expected a ${label} answer`);
    })();

  test("draws nothing while no words are waiting", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    expect(
      container.querySelector("[data-companion-dictation-offer]"),
    ).toBeNull();
  });

  /**
   * The offer is named on the way out. The surface can be a frame behind the
   * window holding the words, and an answer that named nothing would act on
   * whichever offer had arrived by then.
   */
  test("an answer names the offer the card was drawn against", async () => {
    STATE.dictationOffer = {
      reason: "no-text-field",
      id: "offer-7",
      text: "onions, tomatoes, and a bag of rice",
    };
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => offerCardOf(container));

    fireEvent.click(answerOf(container, "Copy"));

    expect(answerOfferMock).toHaveBeenCalledWith("copy", "offer-7");
  });

  test("a discard travels the same way", async () => {
    STATE.dictationOffer = {
      reason: "no-text-field",
      id: "offer-7",
      text: "onions, tomatoes, and a bag of rice",
    };
    const { container } = render(<CompanionSurfacePage />);
    await waitFor(() => offerCardOf(container));

    fireEvent.click(answerOf(container, "Discard"));

    expect(answerOfferMock).toHaveBeenCalledWith("dismiss", "offer-7");
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
 * The dial, which is main's from the press until a session answers it.
 *
 * The press leaves this window the moment it is made, so the pill's answer to
 * it has to arrive the way the call does: on the pushed state.
 */
describe("the dial on the companion surface", () => {
  test("holds the pill open with the pointer nowhere near it", async () => {
    STATE.dialing = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(closed(container)).toBe(false);
    expect(container.textContent).toContain("Calling Ziggy…");
  });

  test("closes the pill once main says the dial is over", async () => {
    STATE.dialing = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    STATE.dialing = false;
    pushState();

    expect(closed(container)).toBe(true);
  });

  test("hands the end back through main, the way the call's controls go", async () => {
    STATE.dialing = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    const end = container.querySelector<HTMLButtonElement>(
      'button[aria-label="End session"]',
    );
    if (!end) {
      throw new Error("Expected the end control to render");
    }
    fireEvent.click(end);

    expect(sendControlMock).toHaveBeenCalledWith({ action: "endSession" });
  });

  test("reads a state that says nothing about it as not dialing", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(closed(container)).toBe(true);
  });

  test("withdraws the introduction's card, as a call does", async () => {
    STATE.intro = "talk";
    STATE.dialing = true;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(container.querySelector('[role="group"]')).toBeNull();
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

  /**
   * Open the call row, which is where the way into a session would be drawn:
   * a call holds the pill open on its own.
   */
  const openPill = async (container: HTMLElement): Promise<void> => {
    await pinSurface(container);
    await open(container);
  };

  beforeEach(() => {
    STATE.call = LISTENING_CALL;
  });

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
  test("a right-press does not start a drag", async () => {
    const { container } = render(<CompanionSurfacePage />);
    const { pill } = await pinSurface(container);
    const canvas = canvasOf(container);

    fireEvent.mouseMove(canvas, { clientX: 120, clientY: 120 });
    // button 2 is the right button; the drag arms only on the left.
    fireEvent.pointerDown(pill, {
      button: 2,
      pointerId: 1,
      screenX: 500,
      screenY: 500,
    });
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
 * The capsule is the assistant's own colour, not the surface's: an idle
 * companion with no call running wears its character's accent, and a running
 * call's accent wins over it.
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
   * The resting capsule is painted whole in the accent and is always mounted,
   * so it is where the resolved colour is read back from.
   *
   * Awaited, because the state the colour comes from arrives after mount, so
   * the first render is always the default.
   */
  const expectAccent = async (
    container: HTMLElement,
    hex: string,
  ): Promise<void> => {
    await waitFor(() => {
      const capsule =
        container.querySelector<HTMLElement>(".companion-capsule");
      if (!capsule) {
        throw new Error("Expected the capsule to render");
      }
      expect(capsule.style.background.trim().toLowerCase()).toContain(hex);
    });
  };

  test("resolves the character's palette colour with no call running", async () => {
    STATE.character = { ...CHARACTER };
    const { container } = render(<CompanionSurfacePage />);

    await expectAccent(container, "#e9642f");
  });

  test("lets a running call's accent win", async () => {
    STATE.character = { ...CHARACTER };
    STATE.call = listening("#123456");
    const { container } = render(<CompanionSurfacePage />);

    await expectAccent(container, "#123456");
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

    await expectAccent(container, "#e9642f");
  });

  /**
   * The accent the app's window published is the colour every other surface
   * paints with, so it is the capsule's too: an uploaded image lights the
   * surface in its own colour without a character to resolve one from.
   */
  test("lights an uploaded image in the accent the app published", async () => {
    STATE.accentHex = "#c81e1e";
    const { container } = render(<CompanionSurfacePage />);

    await expectAccent(container, "#c81e1e");
  });

  test("lets the published accent win over the character's palette colour", async () => {
    STATE.character = { ...CHARACTER };
    STATE.accentHex = "#12ab34";
    const { container } = render(<CompanionSurfacePage />);

    await expectAccent(container, "#12ab34");
  });

  /**
   * With neither a published accent nor a character (an uploaded image on a
   * shell that predates the accent), the component's own default is the last
   * word rather than a colour guessed from nothing.
   */
  test("falls back to the component default without a character", async () => {
    const { container } = render(<CompanionSurfacePage />);

    await expectAccent(container, "#5eead4");
  });
});

/**
 * Share opens the same picker Teach does, and its pick leaves as the share
 * rather than as the toggle. The two pickers are one card with two questions,
 * and each closes on its own answer.
 */
describe("the picker behind Share", () => {
  const shareOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Share"]',
    );
    if (!found) {
      throw new Error("Expected Share to render");
    }
    return found;
  };
  const teachOf = (container: HTMLElement): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Teach"]',
    );
    if (!found) {
      throw new Error("Expected Teach to render");
    }
    return found;
  };
  const pickerOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>("[data-companion-capture-picker]");
  const rowOf = (container: HTMLElement) =>
    waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Groceries (Notes)"]',
      );
      if (!found) {
        throw new Error("Expected the window row");
      }
      return found;
    });

  const SOURCES = {
    displays: [
      { kind: "display" as const, displayId: 1, index: 0, primary: true },
    ],
    tabs: [],
    windows: [
      {
        kind: "window" as const,
        windowId: 9,
        title: "Groceries",
        app: "Notes",
      },
    ],
  };

  beforeEach(() => {
    STATE.call = LISTENING_CALL;
    STATE.watchTargets = true;
    STATE.screenShareEnabled = true;
    captureSources = SOURCES;
  });

  test("opens on Share, named for the share, and holds Share down", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);

    fireEvent.click(shareOf(container));

    await waitFor(() => {
      expect(pickerOf(container)?.getAttribute("aria-label")).toBe(
        "What to share",
      );
    });
    expect(shareOf(container).getAttribute("aria-pressed")).toBe("true");
    expect(teachOf(container).getAttribute("aria-pressed")).toBe("false");
    expect(setScreenShareMock).not.toHaveBeenCalled();
  });

  test("a pick leaves as the share, not the toggle, and closes the picker", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(shareOf(container));
    const row = await rowOf(container);

    fireEvent.click(row);

    expect(setScreenShareMock).toHaveBeenCalledWith({
      kind: "window",
      windowId: 9,
    });
    expect(toggleWatchMock).not.toHaveBeenCalled();
    expect(pickerOf(container)).toBeNull();
  });

  test("a press while sharing is the stop, carrying nothing", async () => {
    STATE.screenShare = { kind: "window", windowId: 9 };
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(shareOf(container).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(shareOf(container));

    expect(setScreenShareMock.mock.calls).toEqual([[]]);
    expect(pickerOf(container)).toBeNull();
  });

  test("closes when the share starts, and leaves Teach's picker alone", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(shareOf(container));
    await rowOf(container);

    pushState({ ...STATE, screenShare: { kind: "window", windowId: 9 } });
    expect(pickerOf(container)).toBeNull();

    fireEvent.click(teachOf(container));
    await rowOf(container);
    pushState({ ...STATE, screenShare: undefined });
    expect(pickerOf(container)).not.toBeNull();
    expect(pickerOf(container)?.getAttribute("aria-label")).toBe(
      "What to teach from",
    );
  });

  test("a Teach press replaces Share's question with its own", async () => {
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    fireEvent.click(shareOf(container));
    await rowOf(container);

    fireEvent.click(teachOf(container));

    await waitFor(() => {
      expect(pickerOf(container)?.getAttribute("aria-label")).toBe(
        "What to teach from",
      );
    });
    expect(shareOf(container).getAttribute("aria-pressed")).toBe("false");
    expect(teachOf(container).getAttribute("aria-pressed")).toBe("true");
  });

  test("is absent when the call cannot be shown anything", async () => {
    STATE.screenShareEnabled = false;
    const { container } = render(<CompanionSurfacePage />);
    await pinSurface(container);
    expect(container.querySelector('button[aria-label="Share"]')).toBeNull();
  });
});
