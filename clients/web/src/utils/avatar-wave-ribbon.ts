/**
 * Layout generator for the welcome screen's avatar wave.
 *
 * A ribbon is a centerline of control points, each carrying the ribbon's
 * width and the avatar size at that point. Walking it with arc-length steps
 * and laying a row of avatars across the perpendicular at each step packs a
 * crowd that flows along the path and grows toward its tail.
 *
 * Everything is deterministic for a given seed so a re-layout (resize,
 * orientation change) reproduces the same composition instead of reshuffling
 * the crowd under the user.
 */

/** Centerline control point: position, ribbon width, and avatar size here. */
export interface RibbonPoint {
  x: number;
  y: number;
  w: number;
  s: number;
}

/** One placed avatar in design coordinates (center point). */
export interface WaveItem {
  x: number;
  y: number;
  size: number;
  rotate: number;
}

/**
 * Centerline control point authored relative to the box the ribbon fills,
 * rather than in a fixed design box scaled to cover it.
 *
 * A ribbon that has to hold a composition against the content on top of it
 * (clearing a heading, returning below a pair of buttons) can't be authored
 * once and scaled: covering a shorter viewport pushes the head off the top,
 * and containing a wider one pulls the loop's excursion back on screen, which
 * is the one part that has to stay off it. Expressing each point against the
 * box keeps both ends anchored at any aspect ratio.
 *
 * The two axes are deliberately measured against different sides. `fx`/`fw`
 * are widths, so the crowd spans the box and the loop leaves it whichever way
 * the box is proportioned; `fy`/`fs` are heights, so the avatars keep their
 * size relative to the run of screen they have to fill.
 */
export interface RelativeRibbonPoint {
  /** Centerline x, as a fraction of the box width. Outside 0–1 is off screen. */
  fx: number;
  /** Centerline y, as a fraction of the box height. */
  fy: number;
  /** Ribbon width, as a fraction of the box width. */
  fw: number;
  /** Avatar size here, as a fraction of the box height. */
  fs: number;
}

/**
 * Resolve a relative ribbon against a box, in pixels. The result feeds
 * {@link buildRibbonWave} directly, so the placements come back in the same
 * pixels and need no further scaling.
 */
export function resolveRibbon(
  points: RelativeRibbonPoint[],
  width: number,
  height: number,
): RibbonPoint[] {
  return points.map((p) => ({
    x: p.fx * width,
    y: p.fy * height,
    w: p.fw * width,
    s: p.fs * height,
  }));
}

/** mulberry32 — small deterministic PRNG for layout jitter. */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pack avatars along `ribbon`. Push order follows the path, so callers can
 * use the index as the reveal order and get a head-to-tail pour.
 *
 * `maxSize` caps the post-jitter avatar size so a ribbon can keep widening
 * toward its tail without any single avatar outgrowing its container.
 */
export function buildRibbonWave(
  ribbon: RibbonPoint[],
  seed: number,
  maxSize = Infinity,
): WaveItem[] {
  const rng = mulberry32(seed);
  const jitter = (amount: number) => (rng() * 2 - 1) * amount;
  const items: WaveItem[] = [];

  for (let seg = 0; seg < ribbon.length - 1; seg++) {
    const a = ribbon[seg];
    const b = ribbon[seg + 1];
    if (!a || !b) {
      continue;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      continue;
    }
    const perpX = dy / len;
    const perpY = -dx / len;

    let dist = 0;
    let row = 0;
    while (dist < len) {
      const t = dist / len;
      const cx = a.x + dx * t;
      const cy = a.y + dy * t;
      const width = a.w + (b.w - a.w) * t;
      const size = a.s + (b.s - a.s) * t;

      const count = Math.max(1, Math.round(width / (size * 0.95)));
      const spacing = width / count;
      // Alternate rows shift half a slot across the ribbon so the packing
      // nests organically instead of forming parallel strands.
      const rowShift = row % 2 === 0 ? 0 : spacing * 0.5;
      for (let k = 0; k < count; k++) {
        const offset =
          (k - (count - 1) / 2) * spacing + rowShift + jitter(size * 0.12);
        items.push({
          x: cx + perpX * offset + jitter(size * 0.08),
          y: cy + perpY * offset + jitter(size * 0.08),
          size: Math.min(maxSize, size * (0.85 + rng() * 0.3)),
          rotate: jitter(10),
        });
      }
      dist += size * 0.85 + 4;
      row++;
    }
  }

  return items;
}
