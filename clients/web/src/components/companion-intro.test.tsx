import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_INTRO_BEATS,
  type CompanionIntroBeat,
} from "@vellumai/ipc-contract";

import { CompanionIntro, introSpotlight } from "./companion-intro";
import { CompanionSurface } from "./companion-surface";

afterEach(cleanup);

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

  /**
   * On the beats about one control the creature hops up onto that control,
   * which puts its whole box above the pill. A card placed for the pill alone
   * was drawn on top of it, and the walk is the part worth watching.
   *
   * Only those beats: the extra distance is most of a creature, and spending it
   * on the opening cards, which have nothing between them and the creature,
   * strands them up the canvas for a beat three presses away.
   */
  test("clears the perched creature on the beats that walk it", () => {
    const stepFor = (beat: CompanionIntroBeat): number => {
      const { container } = render(
        <CompanionIntro beat={beat} avatarBox={44} optionsBox={44} />,
      );
      const found = /translateY\(calc\(-100% - ([\d.]+)px\)\)/.exec(
        cardOf(container).style.transform,
      );
      if (!found?.[1]) {
        throw new Error(`Expected a step up on ${beat}`);
      }
      return Number(found[1]);
    };

    // A beat with nothing between the card and the creature clears the pill and
    // the gap, which is `companionLayoutFor`'s own answer: 30 + 12 here.
    expect(
      COMPANION_INTRO_BEATS.filter(
        (beat) => introSpotlight(beat) === undefined,
      ).map(stepFor),
    ).toEqual([42, 42, 42, 42, 42]);

    // A beat that walks the creature clears where it stands: its own step off
    // the line (22 + 12), the hop over the bar (22), its half box (22), and
    // then the room left over its head (6).
    expect(
      COMPANION_INTRO_BEATS.filter(
        (beat) => introSpotlight(beat) !== undefined,
      ).map(stepFor),
    ).toEqual([84, 84, 84]);
  });
});

/**
 * The card is one box for the whole run.
 *
 * The beats say different amounts, and a card sized to each of them would
 * resize under the reader on every press and move the way on to a new place
 * each time. This is one run about one surface, not five panels.
 */
describe("the introduction's card box", () => {
  test("holds one size on every beat", () => {
    const boxes = COMPANION_INTRO_BEATS.map((beat) => {
      const { container } = render(<CompanionIntro beat={beat} />);
      const { width, height } = cardOf(container).style;
      return `${width}x${height}`;
    });

    expect(new Set(boxes).size).toBe(1);
  });

  /**
   * Back exists because prose gets reread, and it is held out of the first
   * beat, where a press on it could only do nothing.
   */
  test("offers a way back on every beat but the first", () => {
    const backOn = (beat: CompanionIntroBeat): boolean => {
      const { container } = render(
        <CompanionIntro beat={beat} onAdvance={() => undefined} />,
      );
      return [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Back",
      );
    };

    expect(backOn("idle")).toBe(false);
    expect(backOn("meet")).toBe(true);
    expect(backOn("try")).toBe(true);
  });

  test("a press on it asks main to walk the run back", () => {
    const asked: string[] = [];
    const { container } = render(
      <CompanionIntro
        beat="share"
        onAdvance={(action) => {
          asked.push(action);
        }}
      />,
    );
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    if (!back) {
      throw new Error("Expected a way back");
    }
    back.click();

    expect(asked).toEqual(["back"]);
  });
});
