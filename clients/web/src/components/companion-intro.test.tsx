import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { COMPANION_BASE_AVATAR_BOX } from "@vellumai/ipc-contract";

import { CompanionIntro } from "./companion-intro";
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
 * screen together, and the pill is bottom-flush with the creature rather than
 * centred on it. A card that only cleared the creature would be drawn over the
 * controls it is captioning wherever the pill is the taller of the two.
 */
describe("the companion introduction's clearance", () => {
  /**
   * A small creature under a large pill, which is the pair that separates the
   * two rules: the creature reaches 22 points above its centre and the pill
   * 88, so a step off the creature alone lands the card inside the pill.
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

    // The step down for 44 under 110 is the creature's half box plus the gap,
    // 22 + 12 points, over the 2.5 scale the options box leaves the canvas at.
    expect(cardOf(container).style.transform).toBe("translateY(13.6px)");
  });
});
