import { describe, expect, test } from "bun:test";

import { companionLayoutFor } from "./companion-layout";

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
   * the layout has to reduce to itself here: the scale is one, the creature
   * carries no difference of its own, and the distances are the points they
   * were written as.
   */
  test("hands back the authored numbers when the two boxes agree", () => {
    const layout = companionLayoutFor(44, 44);
    expect(layout.scale).toBe(1);
    expect(layout.avatarRel).toBe(1);
    expect(layout.avatarHalf).toBe(22);
    expect(layout.gap).toBe(12);
    expect(layout.nearEdge).toBe(46);
    expect(layout.inUnits(34)).toBe(34);
  });

  /**
   * A small creature beside a large pill, read in the pill's units. The gap is
   * the smaller box's, the creature is drawn at the ratio between the two, and
   * every point distance is divided by the scale the wrapper has already
   * applied.
   */
  test("states a mixed pair in the pill's units", () => {
    const layout = companionLayoutFor(44, 110);
    expect(layout.scale).toBe(2.5);
    expect(layout.avatarRel).toBe(0.4);
    expect(layout.avatarHalf).toBe(22);
    expect(layout.gap).toBe(12);
    expect(layout.nearEdge).toBe(148);
    expect(layout.inUnits(34)).toBe(13.6);
    expect(layout.inUnits(148)).toBe(59.2);
  });

  /**
   * The conversion divides by the scale rather than multiplying by the base box
   * over the pill's, because the numbers here are written straight into CSS.
   * The other order comes out a float's width away, and `calc(50% +
   * 13.600000000000001px)` is what the user would read in the inspector.
   */
  test("converts to the exact numbers CSS is handed", () => {
    const layout = companionLayoutFor(44, 110);
    expect(`${layout.inUnits(34)}`).toBe("13.6");
    expect(`${layout.inUnits(148)}`).toBe("59.2");
  });

  /**
   * The same rules the other way round: a creature larger than the pill keeps
   * the smaller box's gap, and the canvas holds the creature's own half box
   * plus a pad sized by the larger of the two.
   */
  test("keeps the smaller box's gap when the creature is the larger", () => {
    const layout = companionLayoutFor(110, 44);
    expect(layout.scale).toBe(1);
    expect(layout.avatarRel).toBe(2.5);
    expect(layout.avatarHalf).toBe(55);
    expect(layout.gap).toBe(12);
    expect(layout.nearEdge).toBe(115);
    expect(layout.inUnits(67)).toBe(67);
  });
});
