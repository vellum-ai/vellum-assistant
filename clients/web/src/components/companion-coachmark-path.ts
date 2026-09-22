/**
 * The primitives a drawn mark is built from: a seeded wobble, a smooth curve
 * through points, and the rounding both are written out at.
 *
 * **Their own module because what draws with them and what judges the result
 * are different things.** The shapes a mark is built from are in
 * `companion-coachmark-shapes.ts`, and the lab beside it draws them at
 * settings the product never uses. Neither has to export its internals for
 * the other to work, and a wobble that differed between them would make the
 * bench a bench for something else.
 */

/** One point, in the local pixels a path is built in. */
export interface Point {
  x: number;
  y: number;
}

/**
 * A small deterministic generator, so a seed gives one sequence forever.
 *
 * Mulberry32: short, no dependency, and good enough for a wobble. Nothing here
 * is cryptographic and nothing should be.
 */
export function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seed from where the mark is, so the same control draws the same hand.
 *
 * Rounded before it is mixed: an anchor arrives as a fraction and the tail of
 * that changes with the window's size, which would redraw the wobble every
 * time the user resized something.
 */
export function seedFor(x: number, y: number): number {
  return (Math.round(x * 1000) * 73856093) ^ (Math.round(y * 1000) * 19349663);
}

/**
 * A cubic through `points`, smoothed so the seams between segments do not
 * show.
 *
 * Catmull-Rom converted to bezier: the control points are read off the
 * neighbours, which is what keeps a wandering line looking drawn in one
 * motion rather than assembled from arcs.
 */
export function through(points: readonly Point[], closed: boolean): string {
  if (points.length < 2) {
    return "";
  }
  const at = (i: number): Point => {
    if (closed) {
      return points[(i + points.length) % points.length] as Point;
    }
    return points[Math.min(Math.max(i, 0), points.length - 1)] as Point;
  };
  const first = at(0);
  let d = `M ${round(first.x)} ${round(first.y)}`;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(p2.x)} ${round(p2.y)}`;
  }
  return closed ? `${d} Z` : d;
}

/** Two decimals, which is under a pixel and keeps a path readable in a test. */
export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
