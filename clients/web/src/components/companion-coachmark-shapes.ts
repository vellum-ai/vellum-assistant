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
 * A loop around `box`, drawn the way someone circles a thing on a page.
 *
 * Slightly larger than what it encloses and rounder than it, because a loop
 * traced tight to a rectangle is a rectangle. It also overshoots its start a
 * little: a closed ellipse reads as a shape drawn by a machine, and the small
 * crossing where the line comes back past itself is most of what reads as a
 * hand.
 *
 * `padding` is how far outside the bounds the loop sits, in the same pixels.
 * The bounds themselves stay untouched, so whatever is being pointed at is
 * exactly as visible as it was before anything was drawn on it.
 */
export function enclosurePath(
  box: { width: number; height: number },
  options: { strength: number; seed: number; padding?: number },
): string {
  const padding = options.padding ?? 8;
  const rx = box.width / 2 + padding;
  const ry = box.height / 2 + padding;
  const cx = box.width / 2;
  const cy = box.height / 2;
  const wobble = hand(options.strength);
  const random = noise(options.seed);

  // Enough points to read as a curve and few enough that each one's wander is
  // visible as intent rather than as noise.
  const steps = 13;
  // Started off-axis so the crossing does not land at the top, where it reads
  // as a gap rather than as an overlap.
  const from = -Math.PI * 0.62;
  // Past a full turn, which is the overshoot.
  const sweep = Math.PI * 2.11;

  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + (sweep * i) / steps;
    // The wander is radial, so the loop stays a loop: pushing points sideways
    // as well makes it wobble across its own path and read as a scribble.
    const drift = 1 + (random() - 0.5) * 2 * wobble;
    points.push({
      x: cx + Math.cos(angle) * rx * drift,
      y: cy + Math.sin(angle) * ry * drift,
    });
  }
  return through(points, false);
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
