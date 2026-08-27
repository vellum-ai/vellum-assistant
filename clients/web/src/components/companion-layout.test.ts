import { describe, expect, test } from "bun:test";

import {
  bridgeRect,
  companionLayoutFor,
  onCompanionSurface,
} from "./companion-layout";

/**
 * The one derivation the pill and the introduction card are both placed by.
 *
 * What is worth stating is the pair the layout is authored at coming out as the
 * numbers the layout is written in, a mixed pair holding the same rules in the
 * pill's units, and the conversion landing on the numbers CSS is handed rather
 * than on their floating-point neighbours.
 */
describe("companionLayoutFor", () => {
  /**
   * The authored pair. Every length on the surface is stated at this size, so
   * the layout has to reduce to itself here: the creature carries no difference
   * of its own, and the distances are the points they were written as.
   */
  test("hands back the authored numbers when the two boxes agree", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.scale).toBe(1);
    expect(layout.avatarRel).toBe(1);
    expect(layout.avatarHalf).toBe(22);
    // The artwork is 28 inside that 44 box, so it stops 14 short of the
    // centre where the box runs 22.
    expect(layout.baseline).toBe(14);
    expect(layout.gap).toBe(12);
    expect(layout.inUnits(34)).toBe(34);
  });

  /**
   * A small creature beside a large pill, read in the pill's units. The gap is
   * the smaller box's, the creature is drawn at the ratio between the two, and
   * every point distance is divided by the scale the wrapper has already
   * applied.
   *
   * The conversion divides by that scale rather than multiplying by the base
   * box over the pill's, because these numbers are written straight into CSS.
   * The other order comes out a float's width away, and `calc(50% +
   * 13.600000000000001px)` is what the user would read in the inspector.
   */
  test("states a mixed pair in the pill's units", () => {
    const layout = companionLayoutFor(44, 110);
    expect(layout.scale).toBe(2.5);
    expect(layout.avatarRel).toBe(0.4);
    expect(layout.avatarHalf).toBe(22);
    expect(layout.baseline).toBe(14);
    expect(layout.gap).toBe(12);
    expect(`${layout.inUnits(34)}`).toBe("13.6");
    expect(`${layout.inUnits(148)}`).toBe("59.2");
  });

  /**
   * The same rules the other way round: a creature larger than the pill keeps
   * the smaller box's gap, and the canvas holds the creature's own half box
   * plus a pad sized by the larger of the two.
   */
  /**
   * The options box alone drives the surface's own scale, so a creature grown
   * on its own leaves it at the identity and carries the whole difference in
   * `avatarRel`.
   */
  test("keeps the smaller box's gap when the creature is the larger", () => {
    const layout = companionLayoutFor(110, 44);
    expect(layout.scale).toBe(1);
    expect(layout.avatarRel).toBe(2.5);
    expect(layout.avatarHalf).toBe(55);
    // The baseline scales with the creature the same way its box does.
    expect(layout.baseline).toBe(35);
    expect(layout.gap).toBe(12);
    expect(layout.inUnits(67)).toBe(67);
  });

  /**
   * The canvas is anchored to whichever edge the card does not grow into, so a
   * line is named from that edge and `100%` covers the other without this side
   * knowing how tall main made the window.
   */
  test("names a line from the canvas edge the avatar is near", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.lineAt("up", 0)).toBe("calc(100% - 54px)");
    expect(layout.lineAt("up", 22)).toBe("calc(100% - 32px)");
    expect(layout.lineAt("down", 0)).toBe("54px");
    expect(layout.lineAt("down", 22)).toBe("76px");
  });

  /** A flip anchors the other edge and moves nothing else. */
  test("anchors the edge the surface grows from", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.edgeAt("right", 34)).toEqual({ left: "calc(50% + 34px)" });
    expect(layout.edgeAt("left", 34)).toEqual({ right: "calc(50% + 34px)" });
  });

  /** Back towards the avatar's own edge, which the introduction's card hangs on. */
  test("states a step back across the centre as a subtraction", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.edgeAt("right", -22)).toEqual({ left: "calc(50% - 22px)" });
  });
});

/**
 * How far the introduction's card starts from the avatar's centre.
 *
 * Its own distance rather than the pill's, because the pill stands on the
 * creature's baseline rather than being centred on it. Every beat but the first
 * holds the pill open, so a card that only cleared the creature would be drawn
 * over the thing it is describing.
 */
describe("the introduction's step off the creature", () => {
  /**
   * Even at the authored pair the pill is the taller thing upward: its bottom
   * is 14 above the centre and it is a whole box tall, so its top stands 30 up
   * where the creature's box reaches 22. Downward that baseline is inside the
   * creature's box, so the creature is what has to be cleared.
   */
  test("clears whichever reaches further when the two boxes agree", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.introStepOff("up")).toBe(42);
    expect(layout.introStepOff("down")).toBe(34);
  });

  /**
   * A small creature under a large pill: standing on the baseline puts the
   * pill's top 96 points above the avatar's centre where the creature reaches
   * only 22, so the card has to start past the pill.
   */
  test("clears a pill that stands taller than the creature", () => {
    const layout = companionLayoutFor(44, 110);
    const pillTop = 110 - 14;
    expect(layout.introStepOff("up")).toBe(pillTop + 12);
    expect(layout.introStepOff("up")).toBeGreaterThan(pillTop);
  });

  /**
   * Downward there is nothing to clear but the creature: the pill's bottom edge
   * is the creature's baseline, which sits inside the creature's own box
   * whatever the pill's size.
   */
  test("takes the creature's own bottom growing downward", () => {
    expect(companionLayoutFor(44, 110).introStepOff("down")).toBe(34);
    expect(companionLayoutFor(110, 44).introStepOff("down")).toBe(67);
  });
});

/**
 * The strip between the avatar and the pill, as arithmetic. The rects it is
 * handed come from the DOM, so these are about the shape it makes of them:
 * between the facing edges, and no taller than the composer row.
 */
const AVATAR = { left: 100, right: 144, top: 100, bottom: 144 };
const ROW = { rowHeight: 44, cardGrowth: "up" } as const;

describe("bridgeRect", () => {
  test("spans the facing edges when the pill grows rightward", () => {
    const pill = { left: 156, right: 356, top: 100, bottom: 144 };
    expect(bridgeRect(AVATAR, pill, ROW)).toEqual({
      left: 144,
      right: 156,
      top: 100,
      bottom: 144,
    });
  });

  test("spans them the other way when it grows leftward", () => {
    const pill = { left: -100, right: 88, top: 100, bottom: 144 };
    expect(bridgeRect(AVATAR, pill, ROW)).toEqual({
      left: 88,
      right: 100,
      top: 100,
      bottom: 144,
    });
  });

  /**
   * The pill's height, never the avatar's. A strip as tall as a larger creature
   * would claim the dead corners beside it, which is the bounding box this
   * exists instead of.
   */
  test("takes the pill's height rather than a taller avatar's", () => {
    const tall = { left: 100, right: 200, top: 40, bottom: 200 };
    const pill = { left: 212, right: 412, top: 156, bottom: 200 };
    expect(bridgeRect(tall, pill, ROW)).toEqual({
      left: 200,
      right: 212,
      top: 156,
      bottom: 200,
    });
  });

  /**
   * The card is the one state that is not its own row. A strip drawn to its
   * full height would hand the window a column of empty canvas beside the card
   * to swallow desktop presses in, so it stops at the composer row: the card's
   * last child growing up, and its first growing down.
   */
  test("covers only the composer row of a card growing up", () => {
    const card = { left: 156, right: 472, top: -146, bottom: 144 };
    expect(bridgeRect(AVATAR, card, ROW)).toEqual({
      left: 144,
      right: 156,
      top: 100,
      bottom: 144,
    });
  });

  test("covers only the composer row of a card growing down", () => {
    const card = { left: 156, right: 472, top: 100, bottom: 390 };
    expect(
      bridgeRect(AVATAR, card, { rowHeight: 44, cardGrowth: "down" }),
    ).toEqual({
      left: 144,
      right: 156,
      top: 100,
      bottom: 144,
    });
  });

  /** Overlapping rects have no gap between them, and an empty strip says so. */
  test("is empty when the two overlap", () => {
    const overlapping = { left: 120, right: 320, top: 100, bottom: 144 };
    const bridge = bridgeRect(AVATAR, overlapping, ROW);
    expect(bridge.left).toBeGreaterThan(bridge.right);
  });
});

/**
 * The union the window is armed by, which is the one answer the renderer and
 * the `Interactive` story both hit-test with.
 */
describe("onCompanionSurface", () => {
  const PILL = { left: 156, right: 356, top: 100, bottom: 144 };
  const at = (x: number, y: number, pill: typeof PILL | null = null): boolean =>
    onCompanionSurface({ x, y }, { avatar: AVATAR, pill, ...ROW });

  test("is the creature alone when there is no pill", () => {
    expect(at(120, 120)).toBe(true);
    expect(at(200, 120)).toBe(false);
  });

  /**
   * The creature's box and nothing above it. The artwork is inset inside that
   * box and the bob stays within the inset, so a rect reaching past the top
   * would arm the window over empty canvas and swallow the presses meant for
   * whatever is behind it.
   */
  test("leaves the canvas above the creature to the desktop", () => {
    expect(at(120, AVATAR.top)).toBe(true);
    expect(at(120, AVATAR.top - 2)).toBe(false);
  });

  test("carries the pointer across the gap to the pill", () => {
    expect(at(150, 120, PILL)).toBe(true);
    expect(at(200, 120, PILL)).toBe(true);
  });

  /**
   * The gap is a strip, not a column. Above the row it is desktop, or the
   * window swallows presses in the empty canvas beside a card.
   */
  test("does not claim the canvas above the gap", () => {
    expect(at(150, 90, PILL)).toBe(false);
  });
});
