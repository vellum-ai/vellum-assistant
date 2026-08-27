import {
  companionGapFor,
  companionNearEdgeFor,
  companionScaleFor,
} from "@vellumai/ipc-contract";
import type {
  CompanionCardGrowth,
  CompanionGrowth,
} from "@vellumai/ipc-contract";
import type { CSSProperties } from "react";

/**
 * How far the bob lifts the creature off its baseline, at the base size.
 *
 * The animation itself is `companion-avatar-bob` in `index.css` and the lift is
 * written there as a literal. It is stated here as well because the host
 * hit-tests the avatar against a rect the DOM box does not include: the
 * artwork rides above its own box for most of the cycle, and a pointer on the
 * drawn creature has to count as a pointer on the creature.
 */
export const COMPANION_BOB_LIFT = 3;

/** As much of a rect as hit-testing a point against it needs. */
export type SurfaceRect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

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
     * row is one base box tall and the page's wrapper is scaled by that box.
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
 * The numbers everything on the companion surface is placed by, in points.
 *
 * Points because that is what the contract's helpers answer in and what main
 * sizes the window with. {@link CompanionLayout.inUnits} does the one
 * conversion at the end, so what reaches CSS is as exact as the arithmetic
 * behind it.
 */
export interface CompanionLayout {
  /** The creature's own scale, the page's wrapper having spent the options box already. */
  avatarRel: number;
  /** Half the creature's box, which is what everything beside it steps off from. */
  avatarHalf: number;
  /** The room the creature keeps from anything drawn beside it. */
  gap: number;
  /** The creature's centre to the canvas edge it is near, which is what main places the window by. */
  nearEdge: number;
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
   * Its own distance rather than the pill's, because the pill is bottom-flush
   * with the creature rather than centred on it: a card stepped off the
   * creature alone lands inside a pill that stands taller than the creature.
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
  const gap = companionGapFor(avatarBox, optionsBox);
  const nearEdge = companionNearEdgeFor(avatarBox, optionsBox);
  const inUnits = (points: number): number => points / scale;
  // What is drawn beside the creature, measured from the creature's centre.
  // The pill is bottom-flush with the avatar, so downward the two stop on the
  // same line and upward the pill reaches a whole options box back past it,
  // which stands above a creature smaller than the pill.
  const reachUp = Math.max(avatarHalf, optionsBox - avatarHalf);
  const reachDown = avatarHalf;
  return {
    avatarRel: avatarBox / optionsBox,
    avatarHalf,
    gap,
    nearEdge,
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
