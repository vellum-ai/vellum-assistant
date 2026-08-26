/**
 * Bounding-box helpers for avatar eye art.
 *
 * The peeking/motion eye components (onboarding's bottom eyes, the voice
 * room's eyes) size and frame an avatar's eye art
 * from the union bounding box of its SVG paths. This parser walks the path
 * command-by-command, tracking the current point, so single-coordinate commands
 * — `H`/`V` (horizontal/vertical lineto) — update one axis while every other
 * command extends the box by full (x, y) pairs. Pairing every number as (x, y)
 * without tracking commands would desync on the lone `H`/`V` value; the `grumpy`
 * eye style is the only one that uses `H`, so correct handling matters for it.
 */

export type BBox = { x: number; y: number; w: number; h: number };

/** A point in path space, used for curve control points and endpoints. */
type Point = { x: number; y: number };

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
// One command letter plus the run of numbers that follows it.
const SEGMENTS = /[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g;

/**
 * Tight bounding box of a path's geometry. Tracks the current point so
 * single-axis commands (`H`/`V`) extend the box on the correct axis without
 * desyncing the rest of the path. For every multi-coordinate command the values
 * are treated as (x, y) pairs and each pair extends the box — including curve
 * control points, matching the original parser so the existing eye styles size
 * identically. The arc command (`A`) extends by its endpoint only (its leading
 * radii/flags aren't points); no eye style uses it today.
 */
export function pathBBox(d: string): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;

  const extend = (x: number, y: number) => {
    if (x < minX) {
      minX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y > maxY) {
      maxY = y;
    }
  };

  const segments = d.match(SEGMENTS) ?? [];
  for (const seg of segments) {
    const code = seg[0]!;
    const upper = code.toUpperCase();
    if (upper === "Z") {
      continue;
    }
    const relative = code !== upper;
    const nums = (seg.slice(1).match(NUM) ?? []).map(Number);

    if (upper === "H") {
      for (const n of nums) {
        cx = relative ? cx + n : n;
        extend(cx, cy);
      }
    } else if (upper === "V") {
      for (const n of nums) {
        cy = relative ? cy + n : n;
        extend(cx, cy);
      }
    } else if (upper === "A") {
      // rx ry rot large sweep x y — only the trailing (x, y) is a point.
      for (let i = 0; i + 7 <= nums.length; i += 7) {
        const ex = nums[i + 5]!;
        const ey = nums[i + 6]!;
        cx = relative ? cx + ex : ex;
        cy = relative ? cy + ey : ey;
        extend(cx, cy);
      }
    } else {
      // M/L/T/C/S/Q: extend by every (x, y) pair (control points included).
      // For relative curves the control points are measured from the segment's
      // start point; the current point only advances at the final pair.
      const startX = cx;
      const startY = cy;
      for (let i = 0; i + 2 <= nums.length; i += 2) {
        const px = relative ? startX + nums[i]! : nums[i]!;
        const py = relative ? startY + nums[i + 1]! : nums[i + 1]!;
        extend(px, py);
        // Advance the current point to the last pair of the segment.
        if (i + 2 >= nums.length - (nums.length % 2)) {
          cx = px;
          cy = py;
        }
      }
    }
  }

  if (minX === Infinity) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Bounding box of the geometry a path actually draws, curves solved rather
 * than approximated by their control polygon.
 *
 * {@link pathBBox} extends its box by every control point. The peeking and
 * voice-room eyes intentionally frame against that control-point box, but
 * the box can sit well outside the ink: the `angry`
 * eye style is drawn with control points nowhere near the curve, which makes
 * that box 72% taller than the artwork and drops its center by roughly a third
 * of the eye height.
 *
 * A surface that has to line up with an independently measured version of the
 * same artwork needs the box the curves reach instead. The iOS app icon
 * generator measures its eyes by rasterizing them, so the app icon preview
 * frames against this function to land the eyes where the shipped PNG has
 * them.
 *
 * Curve segments (`C`/`S`/`Q`/`T`) contribute their endpoints plus their
 * per-axis extrema. `A` (arc) contributes its endpoint only, as in
 * `pathBBox`; no eye style uses it today.
 */
export function tightPathBBox(d: string): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // The last curve's trailing control point, which `S`/`T` reflect. Null after
  // any other command, where the spec reflects the current point instead.
  let cubicControl: Point | null = null;
  let quadControl: Point | null = null;

  const extend = (x: number, y: number) => {
    if (x < minX) {
      minX = x;
    }
    if (y < minY) {
      minY = y;
    }
    if (x > maxX) {
      maxX = x;
    }
    if (y > maxY) {
      maxY = y;
    }
  };

  /**
   * Extend by one curve's extrema on both axes. Each axis is solved on its
   * own, and the opposite coordinate passed in is the segment's start point,
   * which is already inside the box, so an extremum only ever widens the axis
   * it was solved for.
   */
  const extendCubic = (c1: Point, c2: Point, end: Point) => {
    for (const value of cubicExtrema(cx, c1.x, c2.x, end.x)) {
      extend(value, cy);
    }
    for (const value of cubicExtrema(cy, c1.y, c2.y, end.y)) {
      extend(cx, value);
    }
  };

  const extendQuadratic = (c1: Point, end: Point) => {
    for (const value of quadraticExtrema(cx, c1.x, end.x)) {
      extend(value, cy);
    }
    for (const value of quadraticExtrema(cy, c1.y, end.y)) {
      extend(cx, value);
    }
  };

  const segments = d.match(SEGMENTS) ?? [];
  for (const seg of segments) {
    const code = seg[0]!;
    const upper = code.toUpperCase();
    const relative = code !== upper;
    const nums = (seg.slice(1).match(NUM) ?? []).map(Number);
    // Relative coordinates are measured from the current point, which advances
    // once per sub-command, so these read the live values rather than a copy.
    const absX = (value: number) => (relative ? cx + value : value);
    const absY = (value: number) => (relative ? cy + value : value);

    if (upper === "Z") {
      cx = startX;
      cy = startY;
      cubicControl = null;
      quadControl = null;
      continue;
    }

    if (upper === "M") {
      for (let i = 0; i + 2 <= nums.length; i += 2) {
        cx = absX(nums[i]!);
        cy = absY(nums[i + 1]!);
        if (i === 0) {
          startX = cx;
          startY = cy;
        }
        extend(cx, cy);
      }
      cubicControl = null;
      quadControl = null;
    } else if (upper === "L") {
      for (let i = 0; i + 2 <= nums.length; i += 2) {
        cx = absX(nums[i]!);
        cy = absY(nums[i + 1]!);
        extend(cx, cy);
      }
      cubicControl = null;
      quadControl = null;
    } else if (upper === "H") {
      for (const n of nums) {
        cx = relative ? cx + n : n;
        extend(cx, cy);
      }
      cubicControl = null;
      quadControl = null;
    } else if (upper === "V") {
      for (const n of nums) {
        cy = relative ? cy + n : n;
        extend(cx, cy);
      }
      cubicControl = null;
      quadControl = null;
    } else if (upper === "C") {
      for (let i = 0; i + 6 <= nums.length; i += 6) {
        const c1: Point = { x: absX(nums[i]!), y: absY(nums[i + 1]!) };
        const c2: Point = { x: absX(nums[i + 2]!), y: absY(nums[i + 3]!) };
        const end: Point = { x: absX(nums[i + 4]!), y: absY(nums[i + 5]!) };
        extendCubic(c1, c2, end);
        cubicControl = c2;
        cx = end.x;
        cy = end.y;
        extend(cx, cy);
      }
      quadControl = null;
    } else if (upper === "S") {
      for (let i = 0; i + 4 <= nums.length; i += 4) {
        const c1: Point = {
          x: 2 * cx - (cubicControl?.x ?? cx),
          y: 2 * cy - (cubicControl?.y ?? cy),
        };
        const c2: Point = { x: absX(nums[i]!), y: absY(nums[i + 1]!) };
        const end: Point = { x: absX(nums[i + 2]!), y: absY(nums[i + 3]!) };
        extendCubic(c1, c2, end);
        cubicControl = c2;
        cx = end.x;
        cy = end.y;
        extend(cx, cy);
      }
      quadControl = null;
    } else if (upper === "Q") {
      for (let i = 0; i + 4 <= nums.length; i += 4) {
        const c1: Point = { x: absX(nums[i]!), y: absY(nums[i + 1]!) };
        const end: Point = { x: absX(nums[i + 2]!), y: absY(nums[i + 3]!) };
        extendQuadratic(c1, end);
        quadControl = c1;
        cx = end.x;
        cy = end.y;
        extend(cx, cy);
      }
      cubicControl = null;
    } else if (upper === "T") {
      for (let i = 0; i + 2 <= nums.length; i += 2) {
        const c1: Point = {
          x: 2 * cx - (quadControl?.x ?? cx),
          y: 2 * cy - (quadControl?.y ?? cy),
        };
        const end: Point = { x: absX(nums[i]!), y: absY(nums[i + 1]!) };
        extendQuadratic(c1, end);
        quadControl = c1;
        cx = end.x;
        cy = end.y;
        extend(cx, cy);
      }
      cubicControl = null;
    } else if (upper === "A") {
      for (let i = 0; i + 7 <= nums.length; i += 7) {
        cx = absX(nums[i + 5]!);
        cy = absY(nums[i + 6]!);
        extend(cx, cy);
      }
      cubicControl = null;
      quadControl = null;
    }
  }

  if (minX === Infinity) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Values a cubic reaches at the interior roots of its derivative. */
function cubicExtrema(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number[] {
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  return quadraticRootsInUnit(a, b, c).map((t) => {
    const mt = 1 - t;
    return (
      mt * mt * mt * p0 +
      3 * mt * mt * t * p1 +
      3 * mt * t * t * p2 +
      t * t * t * p3
    );
  });
}

/** Value a quadratic reaches at the interior root of its derivative. */
function quadraticExtrema(p0: number, p1: number, p2: number): number[] {
  const denominator = p0 - 2 * p1 + p2;
  if (denominator === 0) {
    return [];
  }
  const t = (p0 - p1) / denominator;
  if (t <= 0 || t >= 1) {
    return [];
  }
  const mt = 1 - t;
  return [mt * mt * p0 + 2 * mt * t * p1 + t * t * p2];
}

/** Roots of `a t^2 + b t + c` that fall strictly inside the segment. */
function quadraticRootsInUnit(a: number, b: number, c: number): number[] {
  const inUnit = (t: number) => t > 0 && t < 1;
  if (a === 0) {
    if (b === 0) {
      return [];
    }
    const t = -c / b;
    return inUnit(t) ? [t] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return [];
  }
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter(inUnit);
}

export function unionBBox(boxes: BBox[]): BBox {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
