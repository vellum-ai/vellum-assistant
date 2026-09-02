import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/**
 * The bristle: the resting capsule stirring, in the silhouette of the creature
 * that is tucked inside it.
 *
 * At rest the companion is a thin capsule in the assistant's colour and nothing
 * else (see `RESTING_HEIGHT` in `companion-surface.tsx`). That is the right
 * thing to leave on a desktop all day, and it is also a shape with no
 * character in it: a capsule for an urchin is the capsule for a cloud. Every
 * few seconds the capsule bristles, and what grows out of it is the creature's
 * own outline. An urchin's capsule sprouts its spines, a star its points, a
 * ninja its blades, a cloud its puffs, and each settles back into the plain
 * capsule a moment later. The marker stays a marker, and once in a while it
 * says whose marker it is.
 *
 * **The creature's actual artwork, wrapped around the whole pill.** The body
 * shape's path from the catalog is sampled as a radial profile, how far its
 * outline stands from its centre at each angle, and that profile is laid
 * around the capsule's perimeter by arc length: the creature's right side
 * lands on the pill's right end, its top on the pill's top, and everything in
 * between in order. The pill's outline then stands off its edge by the
 * profile, so the silhouette is the creature's own, stretched to the pill.
 * Nothing is authored per shape, and a shape added to the catalog bristles the
 * day it lands.
 *
 * **Under the capsule, never over it.** The outline is drawn behind the
 * capsule and at rest coincides with its edge, hidden under the rim. It grows
 * outward from there, which is what makes it read as the capsule's own edge
 * moving rather than as a second shape appearing behind it, and it leaves the
 * rim and the working ring exactly as they are.
 *
 * **Only for a composed creature.** A custom uploaded image has no body shape
 * to bristle in, so the surface passes nothing here and the capsule stays
 * still. The same is true of a body shape the catalog does not know: an
 * unknown id is a fallback, not an exception.
 *
 * **Random, inside a stated range.** A fixed period reads as a machine ticking;
 * a random one inside {@link BRISTLE_INTERVAL_SECONDS} reads as a creature
 * shifting in its sleep. Each bristle schedules the next, so the gaps are
 * independent draws rather than a phase-shifted clock.
 */

/**
 * The gap between one bristle and the next, in seconds, as a range the actual
 * delay is drawn from uniformly.
 *
 * Low enough to be seen by someone who glances at the marker now and then, high
 * enough that it is not a thing happening in the corner of the eye all day.
 */
export const BRISTLE_INTERVAL_SECONDS = { min: 3, max: 10 };

export interface BristleInterval {
  /** The shortest gap, in seconds. */
  min: number;
  /** The longest gap, in seconds. */
  max: number;
}

/**
 * How far the outline may stand past the capsule's rim at full stretch, in
 * points.
 *
 * One number because it is what sizes the canvas, and because the capsule
 * sits inside a fixed 44 point box the host hit-tests the pointer against:
 * the capsule's rim is 6 points in from that box's ends, so everything under
 * this stays inside the box and nothing about the surface's geometry changes
 * when it bristles.
 */
export const BRISTLE_REACH = 6;

/**
 * How many points the outline is drawn with, all the way round.
 *
 * Enough to resolve the urchin's spines on a perimeter of about seventy
 * points, and small enough that the path stays a couple of kilobytes.
 */
const OUTLINE_SAMPLES = 180;

/** How many straight pieces each curve of the artwork is cut into. */
const CURVE_STEPS = 8;

/**
 * How long the outline takes to grow out, hold, and settle back, in
 * milliseconds.
 *
 * Fast out and slow back, because a creature stirring is a twitch and a settle
 * rather than a swell.
 */
export const BRISTLE_OUT_MS = 320;
export const BRISTLE_HOLD_MS = 160;
export const BRISTLE_BACK_MS = 480;

export interface Point {
  x: number;
  y: number;
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const COMMAND = /([MLHVCZmlhvcz])([^MLHVCZmlhvcz]*)/g;

/**
 * The artwork as polylines, one per subpath.
 *
 * The catalog's paths are absolute moves, lines and cubics, closed; the
 * relative forms and the axis-aligned lines are read too, for a shape drawn
 * by a different hand. Anything else is skipped rather than thrown on: a path
 * this cannot read is a capsule that does not bristle, not a surface that
 * does not draw.
 */
export const flattenPath = (
  d: string,
  curveSteps: number = CURVE_STEPS,
): Point[][] => {
  const polylines: Point[][] = [];
  let current: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };

  const close = () => {
    if (current.length > 1) {
      polylines.push(current);
    }
    current = [];
  };

  for (const [, letter, rest] of d.matchAll(COMMAND)) {
    const nums = (rest?.match(NUMBER) ?? []).map(Number);
    const relative = letter === letter?.toLowerCase();
    const at = (x: number, y: number): Point =>
      relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
    switch (letter?.toUpperCase()) {
      case "M": {
        close();
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cursor = at(nums[i]!, nums[i + 1]!);
          if (i === 0) {
            start = cursor;
          }
          current.push(cursor);
        }
        break;
      }
      case "L": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cursor = at(nums[i]!, nums[i + 1]!);
          current.push(cursor);
        }
        break;
      }
      case "H": {
        for (const x of nums) {
          cursor = { x: relative ? cursor.x + x : x, y: cursor.y };
          current.push(cursor);
        }
        break;
      }
      case "V": {
        for (const y of nums) {
          cursor = { x: cursor.x, y: relative ? cursor.y + y : y };
          current.push(cursor);
        }
        break;
      }
      case "C": {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const from = cursor;
          const c1 = at(nums[i]!, nums[i + 1]!);
          const c2 = at(nums[i + 2]!, nums[i + 3]!);
          const to = at(nums[i + 4]!, nums[i + 5]!);
          for (let step = 1; step <= curveSteps; step++) {
            const t = step / curveSteps;
            const u = 1 - t;
            current.push({
              x:
                u * u * u * from.x +
                3 * u * u * t * c1.x +
                3 * u * t * t * c2.x +
                t * t * t * to.x,
              y:
                u * u * u * from.y +
                3 * u * u * t * c1.y +
                3 * u * t * t * c2.y +
                t * t * t * to.y,
            });
          }
          cursor = to;
        }
        break;
      }
      case "Z": {
        close();
        cursor = start;
        break;
      }
    }
  }
  close();
  return polylines;
};

const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;

/**
 * How far along a ray from `origin` in direction `dir` the segment `a` to `b`
 * is hit, or `null` when it is not.
 */
const rayHit = (
  origin: Point,
  dir: Point,
  a: Point,
  b: Point,
): number | null => {
  const edge = { x: b.x - a.x, y: b.y - a.y };
  const denom = cross(dir, edge);
  if (Math.abs(denom) < 1e-9) {
    return null;
  }
  const w = { x: a.x - origin.x, y: a.y - origin.y };
  const t = cross(w, edge) / denom;
  const u = cross(w, dir) / denom;
  return t >= 0 && u >= 0 && u <= 1 ? t : null;
};

/**
 * The outline's distance from the artwork's centre at each of `samples`
 * angles, clockwise on screen from straight right.
 *
 * The farthest hit along each ray, so what comes back is the silhouette: a
 * subpath drawn inside another (the ghost's arch, the stack's layers) never
 * pulls the profile inward. The centre is the artwork's bounding box's,
 * rather than the face's, which sits wherever the eyes do.
 */
export const radialProfile = (
  polylines: Point[][],
  samples: number = OUTLINE_SAMPLES,
): number[] => {
  const points = polylines.flat();
  if (points.length === 0) {
    return [];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  const profile: number[] = [];
  for (let i = 0; i < samples; i++) {
    const angle = (2 * Math.PI * i) / samples;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    let far = 0;
    for (const line of polylines) {
      for (let j = 0; j < line.length; j++) {
        const hit = rayHit(centre, dir, line[j]!, line[(j + 1) % line.length]!);
        if (hit !== null && hit > far) {
          far = hit;
        }
      }
    }
    profile.push(far);
  }
  return profile;
};

/**
 * A creature's silhouette as the capsule wears it.
 *
 * `relief` is the profile with its shallowest point at 0 and its farthest at
 * 1, so the deepest hollow sits flush on the capsule and the longest spine
 * reaches the full stretch. `spikiness` is how far the shape departs from a
 * disc, which is what the stretch is scaled by: an urchin at full reach and a
 * blob at the same reach would be two lumpy pills, and a blob's whole
 * character is that it barely departs from round.
 */
export interface Silhouette {
  relief: number[];
  spikiness: number;
}

export const silhouetteOf = (
  svgPath: string,
  samples: number = OUTLINE_SAMPLES,
): Silhouette | undefined => {
  const profile = radialProfile(flattenPath(svgPath), samples);
  if (profile.length === 0) {
    return undefined;
  }
  const min = Math.min(...profile);
  const max = Math.max(...profile);
  if (max <= 0) {
    return undefined;
  }
  const span = max - min;
  return {
    relief: profile.map((r) => (span > 0 ? (r - min) / span : 0)),
    spikiness: 1 - min / max,
  };
};

/**
 * How much of the reach a shape gets, from its spikiness.
 *
 * Full reach from half-spiky up, which is where the urchin, the star and the
 * burst sit, and never under a third, so a blob still visibly swells rather
 * than doing nothing at all.
 */
export const stretchFor = (spikiness: number): number =>
  Math.min(1, Math.max(0.35, spikiness / 0.5));

const silhouettes = new Map<string, Silhouette | undefined>();

/**
 * The silhouette of a catalog body shape, computed once per shape for the
 * life of the module: it is a pure function of artwork that never changes.
 */
export const silhouetteFor = (bodyShape: string): Silhouette | undefined => {
  if (!silhouettes.has(bodyShape)) {
    const shape = BUNDLED_COMPONENTS.bodyShapes.find(
      (candidate) => candidate.id === bodyShape,
    );
    silhouettes.set(
      bodyShape,
      shape === undefined ? undefined : silhouetteOf(shape.svgPath),
    );
  }
  return silhouettes.get(bodyShape);
};

/**
 * The capsule the outline grows out of, in points: the accent the user sees
 * and the rim around it. Stated by the caller, which is where the capsule is
 * drawn, so the two cannot drift.
 */
export interface BristleCapsule {
  width: number;
  height: number;
  rim: number;
}

/**
 * The canvas the outline is drawn on: the capsule's box plus the reach on
 * every side, centred where the capsule is.
 */
export const bristleBox = (
  capsule: BristleCapsule,
  reach: number = BRISTLE_REACH,
): { width: number; height: number } => ({
  width: capsule.width + 2 * capsule.rim + 2 * reach,
  height: capsule.height + 2 * capsule.rim + 2 * reach,
});

/** Two decimals is plenty at this size and keeps the path data short. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * A point on the accent's edge and its outward normal, `fraction` of the way
 * round by arc length, clockwise on screen from the right end's middle.
 *
 * The capsule is a stadium: two straight runs joined by two half circles. Arc
 * length rather than angle is what spreads the creature evenly over it, since
 * by angle the straight runs would get almost nothing.
 */
const stadiumAt = (
  capsule: BristleCapsule,
  fraction: number,
): { point: Point; normal: Point } => {
  const radius = capsule.height / 2;
  const run = Math.max(0, capsule.width - capsule.height);
  const quarter = (Math.PI * radius) / 2;
  const perimeter = 2 * run + 4 * quarter;
  let s = (((fraction % 1) + 1) % 1) * perimeter;
  const half = run / 2;

  // Right cap, lower quarter: from the right end's middle down to the bottom
  // run. On screen, y grows downward, so this is clockwise.
  if (s < quarter) {
    const angle = (s / quarter) * (Math.PI / 2);
    const normal = { x: Math.cos(angle), y: Math.sin(angle) };
    return {
      point: { x: half + radius * normal.x, y: radius * normal.y },
      normal,
    };
  }
  s -= quarter;
  // Bottom run, right to left.
  if (s < run) {
    return { point: { x: half - s, y: radius }, normal: { x: 0, y: 1 } };
  }
  s -= run;
  // Left cap, from the bottom round to the top.
  if (s < 2 * quarter) {
    const angle = Math.PI / 2 + (s / (2 * quarter)) * Math.PI;
    const normal = { x: Math.cos(angle), y: Math.sin(angle) };
    return {
      point: { x: -half + radius * normal.x, y: radius * normal.y },
      normal,
    };
  }
  s -= 2 * quarter;
  // Top run, left to right.
  if (s < run) {
    return { point: { x: -half + s, y: -radius }, normal: { x: 0, y: -1 } };
  }
  s -= run;
  // Right cap, upper quarter: from the top run back to the right end's middle.
  const angle = (3 * Math.PI) / 2 + (s / quarter) * (Math.PI / 2);
  const normal = { x: Math.cos(angle), y: Math.sin(angle) };
  return {
    point: { x: half + radius * normal.x, y: radius * normal.y },
    normal,
  };
};

/**
 * The outline's path, with the silhouette standing `stretch` of its full
 * height off the capsule's edge: 0 is the accent's own edge, hidden under the
 * rim, and 1 is `reach` past the rim.
 *
 * The same number of points in the same order whatever the stretch, which is
 * what lets the browser interpolate between two of them: a path that changed
 * shape would snap instead.
 */
export const bristleOutline = (
  capsule: BristleCapsule,
  silhouette: Silhouette,
  stretch: number,
  reach: number = BRISTLE_REACH,
): string => {
  const box = bristleBox(capsule, reach);
  const centre = { x: box.width / 2, y: box.height / 2 };
  const height = (capsule.rim + reach) * stretchFor(silhouette.spikiness);
  const count = silhouette.relief.length;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const { point, normal } = stadiumAt(capsule, i / count);
    const out = silhouette.relief[i]! * height * stretch;
    const x = centre.x + point.x + normal.x * out;
    const y = centre.y + point.y + normal.y * out;
    parts.push(`${i === 0 ? "M" : "L"}${n(x)} ${n(y)}`);
  }
  return `${parts.join(" ")} Z`;
};

/**
 * One draw from the interval, in milliseconds.
 *
 * `random` is a parameter so the arithmetic can be stated as a test: the
 * shortest gap at 0, the longest at 1, and nothing outside them between.
 */
export const bristleDelayMs = (
  interval: BristleInterval,
  random: () => number = Math.random,
): number => (interval.min + random() * (interval.max - interval.min)) * 1000;

/**
 * A counter that goes up once per bristle, at random gaps inside `interval`,
 * for as long as `enabled` holds.
 *
 * A counter rather than a boolean because each bristle is one grow-and-settle,
 * and the count is what starts one. There is nothing to turn off: a bristle
 * settles on its own, so disabling simply stops the next one from being
 * scheduled.
 */
export function useBristle(
  enabled: boolean,
  interval: BristleInterval = BRISTLE_INTERVAL_SECONDS,
): number {
  const [count, setCount] = useState(0);
  const { min, max } = interval;
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setCount((n) => n + 1);
        schedule();
      }, bristleDelayMs({ min, max }));
    };
    schedule();
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, min, max]);
  return count;
}

export function CompanionBristle({
  bodyShape,
  accentHex,
  rimHex,
  capsule,
  enabled,
  held = false,
  reach = BRISTLE_REACH,
  interval = BRISTLE_INTERVAL_SECONDS,
  className,
  style,
}: {
  /** The catalog id of the creature's body shape. */
  bodyShape: string;
  accentHex: string;
  /** The capsule's own rim colour, so the outline wears the same edge. */
  rimHex: string;
  capsule: BristleCapsule;
  /**
   * Whether the next bristle should be scheduled. Off while the creature is
   * out of the capsule, and off while it is working: a working creature holds
   * a focused pose, and it stops blinking for the same reason.
   */
  enabled: boolean;
  /**
   * Hold the outline at full stretch, with no clock. For looking at the
   * silhouette rather than the motion; the surface never passes it.
   */
  held?: boolean;
  /** How far past the rim the outline may stand. See {@link BRISTLE_REACH}. */
  reach?: number;
  interval?: BristleInterval;
  className?: string;
  style?: CSSProperties;
}) {
  // A bristle is travel across the screen, so for a reader who asked for
  // stillness there is none. Nothing is drawn and no clock runs.
  const reduce = useReducedMotion();
  const silhouette = silhouetteFor(bodyShape);
  const count = useBristle(
    enabled && !held && !reduce && silhouette !== undefined,
    interval,
  );

  // Out for the grow and the hold, then back. The settle is a transition on
  // the path itself rather than a keyframe, since the path is a function of
  // the creature and cannot be written into a stylesheet.
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (count === 0) {
      return;
    }
    setOut(true);
    const timer = setTimeout(() => {
      setOut(false);
    }, BRISTLE_OUT_MS + BRISTLE_HOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [count]);

  if (silhouette === undefined || reduce) {
    return null;
  }

  const box = bristleBox(capsule, reach);
  const stretched = held || out;

  return (
    <svg
      className={`companion-bristle ${className ?? ""}`}
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${box.width} ${box.height}`}
      style={style}
      aria-hidden
    >
      <path
        className="companion-bristle-outline"
        d={bristleOutline(capsule, silhouette, stretched ? 1 : 0, reach)}
        fill={accentHex}
        stroke={rimHex}
        strokeWidth={capsule.rim}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{
          transition: held
            ? "none"
            : out
              ? `d ${BRISTLE_OUT_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
              : `d ${BRISTLE_BACK_MS}ms ease-in-out`,
        }}
      />
    </svg>
  );
}
