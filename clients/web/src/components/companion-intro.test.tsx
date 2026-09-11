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
  jest,
  mock,
  test,
} from "bun:test";

import {
  COMPANION_BASE_AVATAR_BOX,
  type FnKeyState,
} from "@vellumai/ipc-contract";

import type * as SystemPermissions from "@/runtime/system-permissions";
import { __resetInputMonitoringAskForTests } from "@/utils/input-monitoring-ask";
import { writeVoiceKey } from "@/utils/voice-key";
import { VOICE_KEY_ARRIVAL_TIMEOUT_MS } from "@/utils/voice-key-arrival";

import { CompanionSurface } from "./companion-surface";

/**
 * The host, mocked at the runtime-wrapper seam: `system-permissions` answers
 * the Input Monitoring ask, `hotkey` reads the macOS keyboard settings and
 * opens the pane, and `fn-claimants` says which claimants are running.
 * Follows single-file `bun test` isolation.
 */
let inputMonitoringStatus: string | null = "granted";
let answer: () => Promise<{ status: string }> = async () => ({
  status: "granted",
});
const requestSystemPermission = mock((_kind: string) => answer());
const permissionsState = () =>
  inputMonitoringStatus === null
    ? null
    : { inputMonitoring: { status: inputMonitoringStatus } };
mock.module(
  "@/runtime/system-permissions",
  (): Partial<typeof SystemPermissions> => ({
    getSystemPermissionsState: async () =>
      permissionsState() as unknown as Awaited<
        ReturnType<typeof SystemPermissions.getSystemPermissionsState>
      >,
    requestSystemPermission:
      requestSystemPermission as unknown as typeof SystemPermissions.requestSystemPermission,
    useSystemPermissionsState: () =>
      ({
        state: permissionsState(),
        loading: false,
        error: null,
        supported: inputMonitoringStatus !== null,
        refresh: async () => null,
      }) as unknown as ReturnType<
        typeof SystemPermissions.useSystemPermissionsState
      >,
  }),
);

let fnKeyState: FnKeyState | null = null;
const openKeyboardSettings = mock(async () => {});
mock.module("@/runtime/hotkey", () => ({
  supportsModifierHold: () => true,
  subscribeToHotkeyEvents: () => () => {},
  readFnKeyState: async () => fnKeyState,
  openKeyboardSettings,
}));

let running: string[] = [];
mock.module("@/runtime/fn-claimants", () => ({
  runningFnClaimantNames: async () => running,
}));

const { CompanionIntro } = await import("./companion-intro");

beforeEach(() => {
  inputMonitoringStatus = "granted";
  answer = async () => ({ status: "granted" });
  requestSystemPermission.mockClear();
  fnKeyState = null;
  openKeyboardSettings.mockClear();
  running = [];
  __resetInputMonitoringAskForTests();
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  window.localStorage.clear();
});

/** The card's controls, in reading order, by their labels. */
const buttonsOf = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll("button"));

const labelsOf = (container: HTMLElement): string[] =>
  buttonsOf(container).map((button) => button.textContent ?? "");

const press = (container: HTMLElement, label: string): void => {
  const button = buttonsOf(container).find(
    (each) => each.textContent === label,
  );
  if (!button) {
    throw new Error(`Expected a control labelled ${label}`);
  }
  fireEvent.click(button);
};

/** The introduction's card, which hangs off the avatar rather than the pill. */
const cardOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>("[role='group']");
  if (!found) {
    throw new Error("Expected the introduction's card to render");
  }
  return found;
};

/**
 * Let the Input Monitoring ask and what follows it settle. The ask is a few
 * awaits over already-resolved promises, and under fake timers nothing else
 * can be waited on, so the microtask queue is drained by hand.
 */
const settleAsks = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve();
    }
  });
};

/** How far a `calc(100% - Npx)` anchor holds its element off the canvas's bottom. */
const offCanvasBottom = (top: string): number => {
  const found = /^calc\(100% - ([\d.]+)px\)$/.exec(top);
  if (!found?.[1]) {
    throw new Error(`Expected an anchor off the canvas's bottom, got ${top}`);
  }
  return Number(found[1]);
};

/**
 * Where the introduction's card lands beside the surface it is describing.
 *
 * Every beat but the first holds the pill open, so the card and the pill are on
 * screen together, and the pill stands on the creature's visible bottom rather
 * than being centred on it. A card that only cleared the creature would be
 * drawn over the controls it is captioning wherever the pill is the taller of
 * the two.
 */
describe("the companion introduction's clearance", () => {
  /**
   * A small creature under a large pill, which is the pair that separates the
   * two rules: the creature's box reaches 22 points above its centre and the
   * pill 96, so a step off the creature alone lands the card inside the pill.
   */
  test("clears a pill that stands taller than the creature", () => {
    const { container: surface } = render(
      <CompanionSurface phase="hover" avatarBox={44} optionsBox={110} />,
    );
    const { container: intro } = render(
      <CompanionIntro beat="talk" avatarBox={44} optionsBox={110} />,
    );

    // The pill is the one element on the surface whose width animates. It
    // hangs off its own line by a whole row, so its top edge is that much
    // further off the canvas's bottom edge than its anchor.
    const pill = surface.querySelector<HTMLElement>(".transition-\\[width\\]");
    if (!pill) {
      throw new Error("Expected the surface to render");
    }
    const pillTop = offCanvasBottom(pill.style.top) + COMPANION_BASE_AVATAR_BOX;

    // How far the card is then stepped up off its own anchor.
    const card = cardOf(intro);
    const step = /^translateY\(calc\(-100% - ([\d.]+)px\)\)$/.exec(
      card.style.transform,
    );
    if (!step?.[1]) {
      throw new Error(
        `Expected a step up off the anchor, got ${card.style.transform}`,
      );
    }
    const cardBottom = offCanvasBottom(card.style.top) + Number(step[1]);

    expect(cardBottom).toBeGreaterThan(pillTop);
  });

  /**
   * How far the card steps off the creature is `companionLayoutFor`'s to say,
   * and `companion-layout.test.ts` states it. What the card owns is being
   * placed by that distance, converted into the units the wrapper's scale
   * leaves the canvas in.
   */
  test("places the card at the layout's step off the creature", () => {
    const { container } = render(
      <CompanionIntro
        beat="talk"
        cardGrowth="down"
        avatarBox={44}
        optionsBox={110}
      />,
    );

    // The step down for 44 under 110 is the creature's own box below the
    // baseline, so its half box plus the gap: 22 + 12 points, over the 2.5
    // scale the options box leaves the canvas at.
    expect(cardOf(container).style.transform).toBe("translateY(13.6px)");
  });
});

/**
 * The hold beat is the one beat a press does not walk past. The key does, from
 * the app's window, so what the card owns is the ask, the wait, and what it
 * says when the wait runs out.
 */
describe("the companion introduction's hold beat", () => {
  test("asks for the key by name and offers no way past it but the key", async () => {
    const { container } = render(<CompanionIntro beat="hold" />);

    const card = cardOf(container);
    expect(card.textContent).toContain("Hold Fn to dictate");
    await waitFor(() => {
      expect(card.textContent).toContain("Try it now");
    });
    expect(labelsOf(container)).toEqual(["Skip"]);
    // The grant was already given, so nothing was asked.
    expect(requestSystemPermission).not.toHaveBeenCalled();
  });

  test("names a custom key the same way", async () => {
    writeVoiceKey({ kind: "modifierOnly", modifiers: ["control", "option"] });
    const { container } = render(<CompanionIntro beat="hold" />);

    expect(cardOf(container).textContent).toContain("Hold Ctrl+Alt to dictate");
  });

  /**
   * The system prompt names the app and nothing else, so the card says what
   * the grant is for while macOS is asking, and invites the hold only once
   * the answer is in: a hold before the grant reaches nothing.
   */
  test("says why macOS is about to ask, then invites the hold once it is allowed", async () => {
    inputMonitoringStatus = "not-determined";
    let allow: (item: { status: string }) => void = () => {};
    answer = () =>
      new Promise((resolve) => {
        allow = resolve;
      });
    const { container } = render(<CompanionIntro beat="hold" />);

    const card = cardOf(container);
    await waitFor(() => {
      expect(card.textContent).toContain("Input Monitoring");
    });
    expect(card.textContent).not.toContain("Try it now");
    expect(requestSystemPermission).toHaveBeenCalledWith("inputMonitoring");

    inputMonitoringStatus = "granted";
    await act(async () => {
      allow({ status: "granted" });
    });
    await waitFor(() => {
      expect(card.textContent).toContain("Try it now");
    });
    expect(labelsOf(container)).toEqual(["Skip"]);
  });

  // No edge can come without the grant, so there is nothing to wait for: the
  // card goes straight to saying the key never reached it.
  test("a refusal skips the wait and goes straight to the causes", async () => {
    inputMonitoringStatus = "not-determined";
    answer = async () => ({ status: "denied" });
    const { container } = render(<CompanionIntro beat="hold" />);

    const card = cardOf(container);
    await waitFor(() => {
      expect(card.textContent).toContain("Fn never reached me");
    });
    await waitFor(() => {
      expect(card.textContent).toContain("Input Monitoring is off");
    });
    expect(labelsOf(container)).toEqual([
      "Open Keyboard Settings",
      "Skip",
      "Try again",
    ]);

    press(container, "Open Keyboard Settings");
    expect(openKeyboardSettings).toHaveBeenCalledTimes(1);
  });

  // Nothing could prove a key on a host with no helper, or a key that is
  // switched off, so the beat is not a wait: it walks itself past, and main
  // resolves the press against its own beat so a stale one moves nothing else.
  test("walks past itself on a host with nothing to ask for", async () => {
    inputMonitoringStatus = null;
    const onAdvance = mock((_action: string) => {});
    render(<CompanionIntro beat="hold" onAdvance={onAdvance} />);

    await waitFor(() => {
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });
    expect(onAdvance).toHaveBeenCalledWith("next");
  });

  test("walks past itself when the key is off", () => {
    writeVoiceKey({ kind: "off" });
    const onAdvance = mock((_action: string) => {});
    render(<CompanionIntro beat="hold" onAdvance={onAdvance} />);

    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith("next");
  });

  test("says the key never came once the wait runs out, and offers another wait", async () => {
    jest.useFakeTimers();
    const { container } = render(<CompanionIntro beat="hold" />);
    await settleAsks();

    const card = cardOf(container);
    expect(card.textContent).toContain("Try it now");
    act(() => {
      jest.advanceTimersByTime(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
    });
    jest.useRealTimers();

    expect(card.textContent).toContain("Fn never reached me");
    await waitFor(() => {
      expect(card.textContent).toContain("Remapped, claimed by another app");
    });
    expect(labelsOf(container)).toEqual([
      "Open Keyboard Settings",
      "Skip",
      "Try again",
    ]);

    // Another wait is the same ask again, and it runs out the same way.
    jest.useFakeTimers();
    press(container, "Try again");
    await settleAsks();
    expect(card.textContent).toContain("Hold Fn to dictate");
    expect(card.textContent).toContain("Try it now");
    expect(labelsOf(container)).toEqual(["Skip"]);

    act(() => {
      jest.advanceTimersByTime(VOICE_KEY_ARRIVAL_TIMEOUT_MS);
    });
    expect(card.textContent).toContain("Fn never reached me");
  });

  test("every other beat still walks on a press", () => {
    const onAdvance = mock((_action: string) => {});
    const { container } = render(
      <CompanionIntro beat="talk" onAdvance={onAdvance} />,
    );

    expect(labelsOf(container)).toEqual(["Skip", "Next"]);
    press(container, "Next");
    expect(onAdvance).toHaveBeenCalledWith("next");
  });
});

/**
 * What the card says once the key never came, narrowed by what the host can
 * read: a Globe key sent to No Action first, since the driver drops it before
 * anything else gets a look; then the claimants running; then a Fn set to
 * start dictation, which is a mention rather than a cause; else every cause
 * at once. Reached through a refusal, which is the shortest way there.
 */
describe("the hold beat's troubleshooting reading", () => {
  const renderUnreached = async (): Promise<HTMLElement> => {
    inputMonitoringStatus = "not-determined";
    answer = async () => ({ status: "denied" });
    const { container } = render(<CompanionIntro beat="hold" />);
    const card = cardOf(container);
    await waitFor(() => {
      expect(card.textContent).toContain("never reached me");
    });
    return card;
  };

  test("a Globe key sent to No Action comes before everything else", async () => {
    fnKeyState = {
      fnRemappedToNoAction: true,
      fnRemappedTo: null,
      fnUsageType: 3,
    };
    running = ["Raycast"];
    const card = await renderUnreached();

    await waitFor(() => {
      expect(card.textContent).toContain(
        "Fn is set to No Action under Modifier Keys",
      );
    });
    expect(card.textContent).not.toContain("Raycast");
  });

  test("names the claimants running, ahead of the dictation setting", async () => {
    fnKeyState = {
      fnRemappedToNoAction: false,
      fnRemappedTo: null,
      fnUsageType: 3,
    };
    running = ["Raycast", "Karabiner-Elements"];
    const card = await renderUnreached();

    await waitFor(() => {
      expect(card.textContent).toContain(
        "Raycast and Karabiner-Elements may be taking it first.",
      );
    });
    expect(card.textContent).not.toContain("Dictation");
  });

  test("mentions a Fn set to start dictation when nothing else is known", async () => {
    fnKeyState = {
      fnRemappedToNoAction: false,
      fnRemappedTo: null,
      fnUsageType: 3,
    };
    const card = await renderUnreached();

    await waitFor(() => {
      expect(card.textContent).toContain("starts macOS Dictation");
    });
  });

  // The Globe key's settings say nothing about a key of the user's own.
  test("reads the Globe key's settings only when the key is Fn", async () => {
    writeVoiceKey({ kind: "modifierOnly", modifiers: ["control", "option"] });
    fnKeyState = {
      fnRemappedToNoAction: true,
      fnRemappedTo: null,
      fnUsageType: 3,
    };
    const card = await renderUnreached();

    await waitFor(() => {
      expect(card.textContent).toContain("Remapped, claimed by another app");
    });
    expect(card.textContent).not.toContain("No Action");
  });
});
