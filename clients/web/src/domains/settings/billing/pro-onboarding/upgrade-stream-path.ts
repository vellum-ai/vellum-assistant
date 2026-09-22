/**
 * The geometry under the upgrade takeover's character stream: a centerline
 * authored as control points relative to the box it fills, smoothed into a
 * curve, and indexed by arc length so a character can be placed at "this far
 * along" and moved by "this much further" without the caller knowing where
 * the bends are.
 *
 * Pure, so the layout can be tested without a canvas.
 */

/**
 * A control point authored against the box, the way the welcome wave's wrap
 * ribbon is: `fx`/`fy` as fractions of the box's width and height, and `fs`,
 * the character size here, as a fraction of its height. Outside 0-1 is off
 * screen, which is where the stream enters and leaves.
 */
export interface StreamPoint {
  fx: number;
  fy: number;
  fs: number;
}

/** A place on the stream, in box pixels. */
export interface StreamSample {
  x: number;
  y: number;
  /**
   * Unit tangent, pointing the way the path is authored (head to tail),
   * and continuous along it, so an offset taken along the normal does not
   * step as the path is walked.
   */
  tx: number;
  ty: number;
  /** Character size here. */
  size: number;
}

/**
 * The stream's centerline, resolved against one box. `length` is its arc
 * length, and `at` reads the point, tangent, and size a given distance along
 * it, clamped to the ends.
 */
export interface StreamPath {
  length: number;
  at: (distance: number) => StreamSample;
}

/** Samples per control-point span. Enough that the bends read as curves. */
const SAMPLES_PER_SPAN = 48;

/** Catmull-Rom between p1 and p2, with p0 and p3 as the neighbours. */
function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Resolve the control points against a box and build the arc-length index.
 * The position is smoothed through the points; the size is interpolated
 * along each span, which is enough for a ramp that only ever grows.
 */
export function buildStreamPath(
  points: StreamPoint[],
  width: number,
  height: number,
): StreamPath {
  const px = points.map((p) => ({
    x: p.fx * width,
    y: p.fy * height,
    size: p.fs * height,
  }));
  const xs: number[] = [];
  const ys: number[] = [];
  const sizes: number[] = [];
  const cum: number[] = [];
  /** Unit tangent at each sample, smoothed across the sample's neighbours. */
  const txs: number[] = [];
  const tys: number[] = [];

  let total = 0;
  for (let i = 0; i < px.length - 1; i++) {
    const p0 = px[Math.max(0, i - 1)]!;
    const p1 = px[i]!;
    const p2 = px[i + 1]!;
    const p3 = px[Math.min(px.length - 1, i + 2)]!;
    const last = i === px.length - 2;
    const steps = last ? SAMPLES_PER_SPAN + 1 : SAMPLES_PER_SPAN;
    for (let k = 0; k < steps; k++) {
      const t = k / SAMPLES_PER_SPAN;
      const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      if (xs.length > 0) {
        total += Math.hypot(x - xs[xs.length - 1]!, y - ys[ys.length - 1]!);
      }
      xs.push(x);
      ys.push(y);
      sizes.push(p1.size + (p2.size - p1.size) * t);
      cum.push(total);
    }
  }

  // A character sits off the centerline by a lateral offset along the
  // normal, so a normal that turned at every sample would step it sideways
  // each time it crossed one: the tick of a polyline. Averaging each
  // sample's tangent over its neighbours, and interpolating between samples
  // below, turns the normal continuously.
  for (let i = 0; i < xs.length; i++) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(xs.length - 1, i + 1);
    const dx = xs[next]! - xs[prev]!;
    const dy = ys[next]! - ys[prev]!;
    const len = Math.hypot(dx, dy) || 1;
    txs.push(dx / len);
    tys.push(dy / len);
  }

  const at = (distance: number): StreamSample => {
    const d = Math.min(total, Math.max(0, distance));
    // Binary search for the sample just past `d`.
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < d) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const j = Math.max(1, lo);
    const i = j - 1;
    const span = cum[j]! - cum[i]! || 1;
    const t = (d - cum[i]!) / span;
    const tx = txs[i]! + (txs[j]! - txs[i]!) * t;
    const ty = tys[i]! + (tys[j]! - tys[i]!) * t;
    const tlen = Math.hypot(tx, ty) || 1;
    return {
      x: xs[i]! + (xs[j]! - xs[i]!) * t,
      y: ys[i]! + (ys[j]! - ys[i]!) * t,
      tx: tx / tlen,
      ty: ty / tlen,
      size: sizes[i]! + (sizes[j]! - sizes[i]!) * t,
    };
  };

  return { length: total, at };
}

/**
 * Wrap a distance onto the path so a character that runs off one end comes
 * back in at the other: the stream is a loop whose far half is off screen.
 */
export function wrapDistance(distance: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  const d = distance % length;
  return d < 0 ? d + length : d;
}

/**
 * Rows of seats along the path, packed the way the crowd moves: a row every
 * `rowGap` of the local size, so the spacing a row is given at the head is
 * the spacing it keeps as it grows toward the tail.
 *
 * The characters move at a speed proportional to their size (see the
 * stream), so the time between rows is what is conserved as they flow, and
 * that is what this packing holds constant.
 */
export function seatRows(path: StreamPath, rowGap: number): number[] {
  const rows: number[] = [];
  let d = 0;
  while (d < path.length) {
    rows.push(d);
    d += Math.max(1, path.at(d).size * rowGap);
  }
  return rows;
}
