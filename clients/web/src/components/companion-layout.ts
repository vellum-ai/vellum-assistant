import {
  companionBaselineFor,
  companionGapFor,
  companionNearEdgeFor,
  companionScaleFor,
} from "@vellumai/ipc-contract";
import type {
  CompanionCardGrowth,
  CompanionGrowth,
} from "@vellumai/ipc-contract";
import type { CSSProperties } from "react";

/** As much of a rect as hit-testing a point against it needs. */
type SurfaceRect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/**
 * Whether a point is on a rect, its edges included.
 *
 * Inclusive because the surface is a union of touching rects: a pointer exactly
 * on the line where the gap meets the pill is on the surface, and an exclusive
 * test would drop it into the desktop for one pixel of travel.
 */
export const containsPoint = (
  rect: SurfaceRect,
  x: number,
  y: number,
): boolean =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/**
 * The gap between the avatar and the pill, as a rect of its own.
 *
 * **The surface is a union of rects, never the box around them.** The avatar
 * and the pill are separate elements, and a bounding box over the pair would
 * claim the empty canvas above and below the gap as well: a click-through
 * window told it is interactive there swallows the presses meant for whatever
 * is behind it. So the gap is tested as exactly what it is, a strip between the
 * two facing edges.
 *
 * It has to be part of the surface at all because the pointer crosses it on the
 * way from the creature to the controls. A window that went click-through
 * halfway would drop the press the user was travelling to make.
 *
 * **Vertically it is the composer row and nothing above it.** Every phase but
 * `typing` draws a pill that is that row, so `rowHeight` costs those nothing;
 * the card stands a whole panel higher, and a strip drawn to its full height
 * would hand the window a column of empty canvas beside it to swallow presses
 * in.
 *
 * Degenerate when the two overlap, which reads as no bridge at all: the strip's
 * left edge lands past its right, and no point is inside it.
 */
export const bridgeRect = (
  avatar: SurfaceRect,
  pill: SurfaceRect,
  {
    rowHeight,
    cardGrowth,
  }: {
    /**
     * The composer row's height in screen pixels, which is the options box: the
     * row is one base box tall and the surface is drawn scaled by that box.
     */
    rowHeight: number;
    cardGrowth: CompanionCardGrowth;
  },
): SurfaceRect => {
  // The row holds the avatar's line either way: it is the card's last child
  // growing up and its first growing down.
  const top = cardGrowth === "up" ? pill.bottom - rowHeight : pill.top;
  const row = { top, bottom: top + rowHeight };
  return pill.left >= avatar.right
    ? { left: avatar.right, right: pill.left, ...row }
    : { left: pill.right, right: avatar.left, ...row };
};

/**
 * Whether a point is on the companion surface.
 *
 * **The surface is a union of rects, never the box around them:** the creature,
 * the pill beside it, and the strip of gap the pointer crosses between the two.
 * See {@link bridgeRect} for why the box around the pair is the wrong shape.
 *
 * The creature's rect is its own box as measured. The bob rides inside that
 * box: the artwork is inset well short of the top and the lift is smaller than
 * the slack, so a rect stretched to meet the raised creature would only claim
 * empty canvas above it, which is the click-through window swallowing presses
 * meant for whatever is behind it.
 *
 * The renderer hit-tests this way and so does the `Interactive` story, and one
 * answer for both is what keeps the story honest about where the real window
 * arms and where the desktop is left alone.
 */
export const onCompanionSurface = (
  point: { x: number; y: number },
  {
    avatar,
    pill,
    rowHeight,
    cardGrowth,
  }: {
    avatar: SurfaceRect;
    /**
     * The pill's rect, or null when there is no pill. At rest its box is
     * nothing, and a rect of nothing beside the avatar is not somewhere a
     * pointer can be.
     */
    pill: SurfaceRect | null;
    /** The composer row's height in screen pixels. See {@link bridgeRect}. */
    rowHeight: number;
    cardGrowth: CompanionCardGrowth;
  },
): boolean => {
  const inside = (rect: SurfaceRect): boolean =>
    containsPoint(rect, point.x, point.y);
  if (inside(avatar)) {
    return true;
  }
  if (pill === null) {
    return false;
  }
  return (
    inside(pill) || inside(bridgeRect(avatar, pill, { rowHeight, cardGrowth }))
  );
};

/**
 * The numbers everything on the companion surface is placed by, in points.
 *
 * Points because that is what the contract's helpers answer in and what main
 * sizes the window with. {@link CompanionLayout.inUnits} does the one
 * conversion at the end, so what reaches CSS is as exact as the arithmetic
 * behind it.
 */
export interface CompanionLayout {
  /** The scale the whole surface is drawn at, which is the options box over the authored one. */
  scale: number;
  /** The creature's own scale, on top of the options scale the surface already carries. */
  avatarRel: number;
  /** Half the creature's box, which is what everything beside it steps off from. */
  avatarHalf: number;
  /**
   * How far below the creature's centre its artwork stops, which is the line
   * the pill's bottom sits on.
   *
   * Shorter than {@link CompanionLayout.avatarHalf}: the box runs past the
   * drawing to hold the glow and the bob's slack, and it is the drawing the eye
   * lines the pill up with.
   */
  baseline: number;
  /** The room the creature keeps from anything drawn beside it. */
  gap: number;
  /** The one conversion into the units the layout is stated in. */
  inUnits: (points: number) => number;
  /**
   * A line in the canvas, given how far in points it sits from the avatar's
   * centre.
   *
   * The canvas is *not* symmetric about the avatar: the card's height is
   * reserved on whichever side it grows into, so the avatar sits the near edge
   * from the other one, and that edge is the one worth anchoring to. `100%`
   * names the canvas without this side having to know how tall main made it.
   */
  lineAt: (cardGrowth: CompanionCardGrowth, offset: number) => string;
  /**
   * The horizontal anchor for something hanging that far off the avatar's
   * centre, as the CSS edge `growth` runs from.
   *
   * The avatar holds one spot in the canvas and the pill and the card hang off
   * one side of it, so a flip is the anchored edge changing rather than the
   * creature moving.
   */
  edgeAt: (growth: CompanionGrowth, offset: number) => CSSProperties;
  /**
   * How far past the avatar's centre the introduction's card starts, in points.
   *
   * Its own distance rather than the pill's, because the pill stands on the
   * creature's baseline rather than being centred on it: a card stepped off the
   * creature alone lands inside a pill that reaches past the creature's box.
   */
  introStepOff: (cardGrowth: CompanionCardGrowth) => number;
}

/**
 * The surface's geometry for one pair of boxes.
 *
 * Derived here rather than in each component, because the pill and the
 * introduction card both hang off the creature by these same distances:
 * `CompanionSurface` steps the pill off the avatar's edge across the gap, and
 * `CompanionIntro` clears whatever that leaves standing on its side. Two copies
 * of this arithmetic drifting is a card placed somewhere other than beside the
 * pill it describes.
 */
export function companionLayoutFor(
  avatarBox: number,
  optionsBox: number,
): CompanionLayout {
  const scale = companionScaleFor(optionsBox);
  const avatarHalf = avatarBox / 2;
  const baseline = companionBaselineFor(avatarBox);
  const gap = companionGapFor(avatarBox, optionsBox);
  const nearEdge = companionNearEdgeFor(avatarBox, optionsBox);
  const inUnits = (points: number): number => points / scale;
  // One rule read on each side: whichever of the creature's box and the pill
  // reaches further from the centre. The pill's bottom is the creature's
  // baseline, so downward it reaches that baseline and upward it reaches a
  // whole options box back past it, and the creature's own half box is what
  // stands there when the creature is the larger.
  const reachUp = Math.max(avatarHalf, optionsBox - baseline);
  const reachDown = Math.max(avatarHalf, baseline);
  return {
    scale,
    avatarRel: avatarBox / optionsBox,
    avatarHalf,
    baseline,
    gap,
    inUnits,
    lineAt: (cardGrowth, offset) =>
      cardGrowth === "up"
        ? `calc(100% - ${inUnits(nearEdge - offset)}px)`
        : `${inUnits(nearEdge + offset)}px`,
    edgeAt: (growth, offset) => {
      const units = inUnits(offset);
      const line =
        units < 0 ? `calc(50% - ${-units}px)` : `calc(50% + ${units}px)`;
      return growth === "left" ? { right: line } : { left: line };
    },
    introStepOff: (cardGrowth) =>
      (cardGrowth === "up" ? reachUp : reachDown) + gap,
  };
}
