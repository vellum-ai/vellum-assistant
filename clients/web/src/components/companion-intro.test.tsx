import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, jest, mock, test } from "bun:test";

import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";

import { HOLD_PROOF_WINDOW_MS } from "@/hooks/use-hold-proof-deadline";
import { writeVoiceKey } from "@/utils/voice-key";

import { CompanionIntro } from "./companion-intro";
import { CompanionSurface } from "./companion-surface";

afterEach(() => {
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
  test("asks for the key by name and offers no way past it but the key", () => {
    const { container } = render(<CompanionIntro beat="hold" />);

    expect(cardOf(container).textContent).toContain("Hold Fn to dictate");
    expect(labelsOf(container)).toEqual(["Skip"]);
  });

  test("names a custom key the same way", () => {
    writeVoiceKey({ kind: "modifierOnly", modifiers: ["control", "option"] });
    const { container } = render(<CompanionIntro beat="hold" />);

    expect(cardOf(container).textContent).toContain("Hold Ctrl+Alt to dictate");
  });

  test("says the key never came once the wait runs out, and offers the settings and another wait", () => {
    const onOpenKeyboardSettings = mock(() => {});
    jest.useFakeTimers();
    try {
      const { container } = render(
        <CompanionIntro
          beat="hold"
          onOpenKeyboardSettings={onOpenKeyboardSettings}
        />,
      );
      act(() => {
        jest.advanceTimersByTime(HOLD_PROOF_WINDOW_MS + 1);
      });

      const card = cardOf(container);
      expect(card.textContent).toContain("Fn never reached me");
      expect(card.textContent).toContain("Input Monitoring");
      expect(labelsOf(container)).toEqual([
        "Open Keyboard settings",
        "Skip",
        "Try again",
      ]);

      press(container, "Open Keyboard settings");
      expect(onOpenKeyboardSettings).toHaveBeenCalledTimes(1);

      // Another wait is the same ask again, and it runs out the same way.
      press(container, "Try again");
      expect(cardOf(container).textContent).toContain("Hold Fn to dictate");
      expect(labelsOf(container)).toEqual(["Skip"]);

      act(() => {
        jest.advanceTimersByTime(HOLD_PROOF_WINDOW_MS + 1);
      });
      expect(cardOf(container).textContent).toContain("Fn never reached me");
    } finally {
      jest.useRealTimers();
    }
  });

  // Nothing could prove a key that is switched off, so the beat is not a
  // wait: it walks itself past, and main resolves the press against its own
  // beat so a stale one moves nothing else.
  test("walks past itself when the key is off", () => {
    writeVoiceKey({ kind: "off" });
    const onAdvance = mock((_action: string) => {});
    render(<CompanionIntro beat="hold" onAdvance={onAdvance} />);

    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith("next");
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
