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
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const segments = d.match(SEGMENTS) ?? [];
  for (const seg of segments) {
    const code = seg[0]!;
    const upper = code.toUpperCase();
    if (upper === "Z") continue;
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

  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBBox(boxes: BBox[]): BBox {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
