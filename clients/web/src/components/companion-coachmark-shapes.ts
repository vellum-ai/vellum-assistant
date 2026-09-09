/**
 * The paths a mark is drawn with, in the companion's own hand.
 *
 * **Nothing here is told what to draw; it is told where and from which side.**
 * A place and an approach are the two things that can be known exactly: the
 * accessibility tree gives a control's frame, and the room around it gives the
 * side with space in it. Everything about the shape itself is worked out from
 * those, so the assistant is never asked for a coordinate it would have to
 * estimate off a picture that has been scaled and compressed on its way to it.
 *
 * The hand is deterministic. Every wobble comes from a seed derived from the
 * anchor, so a mark redrawn on the same control is the same mark: pointing at
 * one thing twice in a conversation must not shimmer, and a test can pin a
 * path rather than a shape of a path.
 *
 * Paths are built in the pixels they will be drawn at rather than in fractions
 * of the surface. A head shaped by percentages of a screen is a different
 * shape on every screen, and the one thing a mark has to stay is recognisable.
 */

import {
  noise,
  round,
  through,
  type Point,
} from "@/components/companion-coachmark-path";

/** Which side of the point a mark's tail hangs from. */
export type Approach = "above" | "below";

/**
 * How much the hand wanders, as a fraction of the shape's own size.
 *
 * Zero is a drafting machine. Past the top of this range it stops reading as a
 * person being careful and starts reading as a mistake, which over someone
 * else's work is the wrong note entirely.
 */
export const HAND_MIN = 0;
export const HAND_MAX = 0.09;

/**
 * The hands the marks are actually drawn with, chosen in the lab.
 *
 * **Two numbers rather than one, because a shaft shows deviation far more
 * than a closed loop does.** At a single setting the loop reads flat or the
 * arrow picks up a dogleg near its tail, where the stroke stops reading as a
 * lean and starts reading as an unsteady line. Held apart, each is at the
 * setting it looks deliberate at.
 *
 * Not knobs. A mark drawn one way in one place and another way in another is
 * two marks, and the user learns neither.
 */
export const HAND_ENCLOSURE = 0.05;
export const HAND_ARROW = 0.028;

/** `value`, held inside the range a hand is allowed to wander. */
function hand(strength: number): number {
  return Math.min(Math.max(strength, HAND_MIN), HAND_MAX);
}

/**
 * How round the corners of a loop are, as a multiple of its standoff.
 *
 * The loop holds a rectangle without crossing it, and a rounded corner is the
 * one place that is not free. An arc of radius `r` standing `p` off the edges
 * passes `r - sqrt(2) * (r - p)` from the corner it rounds, which falls as
 * the arc opens out and reaches zero at `(1 + sqrt(2)) * p`: past that the
 * box's own corner is outside the loop. At one and a half, the corner keeps
 * four fifths of the standoff, which is what leaves room for half the stroke
 * drawn on the line as well. Small controls are capped by the box instead and
 * come out circled rather than boxed.
 */
const CORNER_ROUNDNESS = 1.5;

/**
 * The least of `padding` that survives at a corner, from the arithmetic
 * above. Exported so a caller standing a loop off can work out whether its
 * own stroke clears the bounds, rather than assuming the standoff holds all
 * the way round.
 */
export const CORNER_CLEARANCE =
  CORNER_ROUNDNESS - Math.SQRT2 * (CORNER_ROUNDNESS - 1);

/** Where `t` of the way round `outline` falls, with `t` past 1 wrapping. */
type Outline = (t: number) => Point;

/**
 * The line a loop is drawn on: `box` grown by `padding`, cornered by arcs.
 *
 * **Every point of it is at least `padding` from the box, which is the whole
 * reason it is not an ellipse.** An ellipse through the midpoints of a
 * rectangle's sides passes inside its corners, so a ring around a wide region
 * would cut across the thing it encloses at all four of them. The straight
 * runs here sit exactly `padding` off each edge and the arcs turn the corners
 * outside them.
 *
 * Walked by perimeter rather than by angle, so the samples are spread evenly
 * along the line instead of bunching where a ray from the middle happens to
 * cross it.
 */
function outlineOf(
  box: { width: number; height: number },
  padding: number,
): { at: Outline; length: number } {
  const radius = Math.min(
    padding * CORNER_ROUNDNESS,
    Math.min(box.width, box.height) / 2 + padding,
  );
  // Where the arcs turn, which is the box inset by however much of the corner
  // radius reaches beyond the standoff.
  const inset = radius - padding;
  const left = inset;
  const right = box.width - inset;
  const top = inset;
  const bottom = box.height - inset;
  const run = { x: Math.max(right - left, 0), y: Math.max(bottom - top, 0) };
  const quarter = (Math.PI * radius) / 2;
  // Clockwise from the top left arc: across the top, down the right, and so
  // on, an arc between each pair of runs.
  const legs = [quarter, run.x, quarter, run.y, quarter, run.x, quarter, run.y];
  const length = legs.reduce((total, leg) => total + leg, 0);

  const corners: Array<{ centre: Point; from: number }> = [
    { centre: { x: left, y: top }, from: Math.PI },
    { centre: { x: right, y: top }, from: -Math.PI / 2 },
    { centre: { x: right, y: bottom }, from: 0 },
    { centre: { x: left, y: bottom }, from: Math.PI / 2 },
  ];

  const at: Outline = (t) => {
    let along = (t % 1) * length;
    if (along < 0) {
      along += length;
    }
    for (let leg = 0; leg < legs.length; leg += 1) {
      const span = legs[leg] as number;
      if (along > span && leg < legs.length - 1) {
        along -= span;
        continue;
      }
      const part = span === 0 ? 0 : Math.min(along / span, 1);
      const corner = corners[leg / 2] as { centre: Point; from: number };
      if (leg % 2 === 0) {
        const angle = corner.from + (Math.PI / 2) * part;
        return {
          x: corner.centre.x + Math.cos(angle) * radius,
          y: corner.centre.y + Math.sin(angle) * radius,
        };
      }
      // The straight runs, each one `padding` off its edge.
      const edges: Array<[Point, Point]> = [
        [
          { x: left, y: top - radius },
          { x: right, y: top - radius },
        ],
        [
          { x: right + radius, y: top },
          { x: right + radius, y: bottom },
        ],
        [
          { x: right, y: bottom + radius },
          { x: left, y: bottom + radius },
        ],
        [
          { x: left - radius, y: bottom },
          { x: left - radius, y: top },
        ],
      ];
      const [from, to] = edges[(leg - 1) / 2] as [Point, Point];
      return {
        x: from.x + (to.x - from.x) * part,
        y: from.y + (to.y - from.y) * part,
      };
    }
    return { x: 0, y: 0 };
  };
  return { at, length };
}

/**
 * The points a loop around `box` is drawn through.
 *
 * Slightly larger than what it encloses and rounder than it, because a loop
 * traced tight to a rectangle is a rectangle. It also overshoots its start a
 * little: a closed line reads as a shape drawn by a machine, and the small
 * crossing where it comes back past itself is most of what reads as a hand.
 *
 * **The wander only ever pushes outward.** The bounds are the thing being
 * pointed at, and a hand that wandered inward would put the stroke across it:
 * the promise a mark makes is that whatever it encloses is exactly as visible
 * as it was before anything was drawn on it. Outward-only costs nothing,
 * since which side of the line a wobble falls on is not what reads as a hand.
 *
 * `padding` is how far outside the bounds the line sits, in the same pixels.
 * Half the stroke drawn on it hangs inside that, so a caller stroking widely
 * has to stand the loop off far enough to keep its own ink clear.
 */
export function enclosureOutline(
  box: { width: number; height: number },
  options: { strength: number; seed: number; padding?: number },
): Point[] {
  const padding = options.padding ?? 8;
  const centre = { x: box.width / 2, y: box.height / 2 };
  const outline = outlineOf(box, padding);
  const wobble = hand(options.strength);
  const random = noise(options.seed);

  // Enough points to read as a curve and few enough that each one's wander is
  // visible as intent rather than as noise.
  const steps = 13;
  // Started off a corner so the crossing does not land on one, where it reads
  // as a shape that failed to close rather than as an overlap.
  const from = 0.18;
  // Past a full turn, which is the overshoot.
  const sweep = 1.055;

  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const place = outline.at(from + (sweep * i) / steps);
    // Away from the middle. The box is convex and the line is already outside
    // it, so a push along that ray cannot land back on the thing however far
    // it goes.
    const away = {
      x: place.x - centre.x,
      y: place.y - centre.y,
    };
    const reach = Math.hypot(away.x, away.y) || 1;
    const drift = random() * wobble * reach;
    points.push({
      x: place.x + (away.x / reach) * drift,
      y: place.y + (away.y / reach) * drift,
    });
  }
  return points;
}

/**
 * A loop around `box`, drawn the way someone circles a thing on a page.
 *
 * See {@link enclosureOutline} for what the line is and why none of it lands
 * on what it encloses.
 */
export function enclosurePath(
  box: { width: number; height: number },
  options: { strength: number; seed: number; padding?: number },
): string {
  return through(enclosureOutline(box, options), false);
}

/**
 * A stroke that arrives at the point from `approach`, with a head on the end.
 *
 * The tip stops short of the point rather than landing on it, for the reason
 * the loop sits outside its bounds: what someone is being sent to has to stay
 * visible. A person pointing at a screen does not touch it either.
 *
 * The bow is what makes it a gesture rather than a measurement. It leans the
 * same way every time for a given anchor, and the head is turned to sit on the
 * end of the curve rather than on the axis, so the arrow points where the line
 * was actually going.
 */
export function arrowPath(options: {
  length: number;
  approach: Approach;
  strength: number;
  seed: number;
  gap?: number;
}): { shaft: string; head: string; width: number; height: number } {
  const gap = options.gap ?? 10;
  const wobble = hand(options.strength);
  const random = noise(options.seed);
  const height = options.length + gap;
  // Room for the bow to lean into, on both sides of the shaft.
  const width = Math.max(28, options.length * 0.55);
  const mid = width / 2;

  // Drawn pointing up, from the tail at the bottom to the tip at the top, and
  // turned by the caller when the tail hangs above instead. One geometry, so
  // the two directions cannot drift apart.
  const tail: Point = { x: mid, y: height };
  const tip: Point = { x: mid, y: gap };
  // Which way it leans. The lean is a choice about this anchor; how far it
  // leans is not, because a curve that varies with the wobble reads as an
  // unsteady line rather than as a gesture. Held shallow: past about a fifth
  // of the width the shaft stops arriving at the point and starts hooking
  // round to it.
  const lean = random() < 0.5 ? -1 : 1;
  const bow = width * 0.17 * lean;

  const along = (t: number): Point => ({
    // A single arc: two control points would let the line change its mind,
    // which is a squiggle rather than a stroke.
    x:
      (1 - t) * (1 - t) * tail.x +
      2 * (1 - t) * t * (mid + bow) +
      t * t * tip.x,
    y:
      (1 - t) * (1 - t) * tail.y +
      2 * (1 - t) * t * ((tail.y + tip.y) / 2) +
      t * t * tip.y,
  });

  const steps = 9;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const point = along(t);
    // The hand steadies as it arrives: the wander is scaled down towards the
    // tip so the end of the stroke lands where it means to. Squared, so the
    // steadying happens over most of the stroke rather than only at the end.
    const settle = (1 - t) * (1 - t);
    const drift = (random() - 0.5) * 2 * wobble * width * settle;
    points.push({ x: point.x + drift, y: point.y });
  }

  // The head sits on the direction the curve is travelling as it arrives.
  const before = along(1 - 1 / steps);
  const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
  // Big enough to read as a head at a glance, which is the whole of what
  // makes the stroke an arrow rather than a line.
  const barb = Math.max(11, options.length * 0.3);
  const spread = 0.42;
  const head =
    `M ${round(tip.x + Math.cos(angle - Math.PI + spread) * barb)} ` +
    `${round(tip.y + Math.sin(angle - Math.PI + spread) * barb)} ` +
    `L ${round(tip.x)} ${round(tip.y)} ` +
    `L ${round(tip.x + Math.cos(angle - Math.PI - spread) * barb)} ` +
    `${round(tip.y + Math.sin(angle - Math.PI - spread) * barb)}`;

  return { shaft: through(points, false), head, width, height };
}
