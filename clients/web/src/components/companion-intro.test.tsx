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

/** The pill, which is the one element on the surface whose width animates. */
const pillOf = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector<HTMLElement>(".transition-\\[width\\]");
  if (!found) {
    throw new Error("Expected the surface to render");
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

/** How far the card is then stepped up off that anchor. */
const steppedUp = (transform: string): number => {
  const found = /^translateY\(calc\(-100% - ([\d.]+)px\)\)$/.exec(transform);
  if (!found?.[1]) {
    throw new Error(`Expected a step up off the anchor, got ${transform}`);
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

    // The pill hangs off its own line by a whole row, so its top edge is that
    // much further off the canvas's bottom edge than its anchor.
    const pillTop =
      offCanvasBottom(pillOf(surface).style.top) + COMPANION_BASE_AVATAR_BOX;
    const cardBottom =
      offCanvasBottom(cardOf(intro).style.top) +
      steppedUp(cardOf(intro).style.transform);

    expect(cardBottom).toBeGreaterThan(pillTop);
  });

  /**
   * The pair the layout is authored at, where the creature and the pill reach
   * the same line: the card steps off the creature's own half box and the gap,
   * exactly as the pill does.
   */
  test("steps off the creature itself when the two boxes agree", () => {
    const { container } = render(<CompanionIntro beat="talk" />);

    expect(cardOf(container).style.transform).toBe(
      "translateY(calc(-100% - 34px))",
    );
  });

  /**
   * Growing downward there is nothing above the creature's own bottom to
   * clear, since that line is the pill's bottom too whichever is larger.
   */
  test("takes the creature's own bottom growing downward", () => {
    const { container } = render(
      <CompanionIntro
        beat="talk"
        cardGrowth="down"
        avatarBox={44}
        optionsBox={110}
      />,
    );

    // 34 points at a scale of two and a half.
    expect(cardOf(container).style.transform).toBe("translateY(13.6px)");
  });
});
