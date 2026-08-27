import {
  companionGapFor,
  companionNearEdgeFor,
  companionScaleFor,
} from "@vellumai/ipc-contract";

/** The numbers everything on the companion surface is placed by. */
export interface CompanionLayout {
  /** The pill's box over the size the layout is authored at. */
  scale: number;
  /**
   * What the creature carries itself: the difference between the two boxes,
   * since the wrapper has spent the options one already.
   */
  avatarRel: number;
  /** The creature's half box, in points. */
  avatarHalf: number;
  /** The room between the creature's edge and anything beside it, in points. */
  gap: number;
  /**
   * How far the creature's centre sits from the canvas edge it is near, in
   * points.
   */
  nearEdge: number;
  /**
   * A distance in points, in the units the layout is stated in.
   *
   * The one conversion, and the reason the distances above are held in points:
   * the page's wrapper has already scaled the whole canvas by the options size,
   * and the contract answers in points because that is what main sizes the
   * window in. Dividing once at the end keeps the numbers that reach CSS as
   * exact as the arithmetic that made them.
   */
  inUnits: (points: number) => number;
}

/**
 * The surface's geometry for one pair of boxes.
 *
 * Derived here rather than in each component, because the pill and the
 * introduction card both hang off the creature by these same distances:
 * `CompanionSurface` steps the pill off the avatar's edge across the gap, and
 * `CompanionIntro` steps its card off the same edge by the same amount. Two
 * copies of this arithmetic drifting is a card placed somewhere other than
 * beside the pill it describes.
 */
export function companionLayoutFor(
  avatarBox: number,
  optionsBox: number,
): CompanionLayout {
  const scale = companionScaleFor(optionsBox);
  return {
    scale,
    avatarRel: avatarBox / optionsBox,
    avatarHalf: avatarBox / 2,
    gap: companionGapFor(avatarBox, optionsBox),
    nearEdge: companionNearEdgeFor(avatarBox, optionsBox),
    inUnits: (points: number): number => points / scale,
  };
}
