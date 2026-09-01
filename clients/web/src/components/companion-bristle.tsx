import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/**
 * The bristle: the resting capsule stirring, in the shape of the creature that
 * is tucked inside it.
 *
 * At rest the companion is a thin capsule in the assistant's colour and nothing
 * else (see `RESTING_HEIGHT` in `companion-surface.tsx`). That is the right
 * thing to leave on a desktop all day, and it is also a shape with no
 * character in it: a capsule for an urchin is the capsule for a cloud. Every
 * few seconds the capsule bristles, and what pokes out of it is the creature's
 * own vocabulary. An urchin's capsule sprouts spikes, a flower's sprouts petals,
 * a ninja's sprouts curved blades, a stack grows a layer, and each settles
 * back into the plain capsule a moment later. The marker stays a marker, and
 * once in a while it says whose marker it is.
 *
 * **Under the capsule, never over it.** The features are drawn behind the
 * capsule, with their bases hidden inside it, and grow out past its edge. That
 * is what makes them read as emerging from the shape rather than as a second
 * shape appearing beside it, and it leaves the capsule's rim and the working
 * ring exactly as they are.
 *
 * **Only for a composed creature.** A custom uploaded image has no body shape
 * to bristle in, so the surface passes nothing here and the capsule stays
 * still. The same is true of a body shape this module has no vocabulary for:
 * an unknown id is a fallback, not an exception.
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
 * How far a feature may reach past the capsule's edge, in points.
 *
 * One number because it is what sizes the canvas the features are drawn on,
 * and because the capsule sits inside a fixed box the host hit-tests the
 * pointer against: the capsule's rim is 15 points in from that box's top, so
 * everything under this stays inside the box and nothing about the surface's
 * geometry changes when it bristles.
 */
export const BRISTLE_REACH = 8;

/**
 * How far a feature's base runs down into the capsule, in points, so the
 * capsule drawn over it hides the seam.
 */
const BASE_INSET = 3;

/**
 * How long one bristle takes from flat to flat, in milliseconds. The contract
 * with `index.css`, which is where the travel lives.
 */
export const BRISTLE_DURATION_MS = 900;

/**
 * The vocabulary. Each is one closed path in a local frame with the base's
 * centre at the origin and growth along negative y.
 */
export type BristleKind = "spike" | "oval" | "puff" | "crescent";

export interface BristleFeature {
  kind: BristleKind;
  /** Where along the capsule it stands: 0 at the left edge, 1 at the right. */
  at: number;
  /** Which edge of the capsule it grows out of. */
  side: "top" | "bottom";
  /** How far past the edge it reaches at full stretch, in points. */
  reach: number;
  /** How wide it is at the base, in points. */
  width: number;
  /** Degrees of lean, positive leaning towards the capsule's right. */
  tilt?: number;
}

const spike = (
  at: number,
  reach: number,
  width: number,
  tilt = 0,
  side: "top" | "bottom" = "top",
): BristleFeature => ({ kind: "spike", at, reach, width, tilt, side });
const oval = (
  at: number,
  reach: number,
  width: number,
  tilt = 0,
  side: "top" | "bottom" = "top",
): BristleFeature => ({ kind: "oval", at, reach, width, tilt, side });
const puff = (
  at: number,
  reach: number,
  width: number,
  tilt = 0,
  side: "top" | "bottom" = "top",
): BristleFeature => ({ kind: "puff", at, reach, width, tilt, side });
const crescent = (
  at: number,
  reach: number,
  width: number,
  tilt = 0,
  side: "top" | "bottom" = "top",
): BristleFeature => ({ kind: "crescent", at, reach, width, tilt, side });

/**
 * What each body shape's capsule bristles with, keyed by the catalog's body
 * shape id.
 *
 * Authored by eye against the artwork in `@vellumai/avatar-catalog`: the thing
 * that pokes out should be the thing that shape is made of. Top-heavy on
 * purpose, since the capsule reads as the creature's back and the pill hangs
 * off its side: a few features underneath keep it from reading as a crown.
 */
export const BRISTLES: Record<string, readonly BristleFeature[]> = {
  // A round thing, so soft swells rather than anything with an edge.
  blob: [
    oval(0.3, 4, 9, -6),
    oval(0.55, 5, 10),
    oval(0.8, 4, 8, 8),
    oval(0.5, 3, 10, 0, "bottom"),
  ],
  // Puffs, fuller than the blob's swells, in the cloud's own bunching.
  cloud: [
    puff(0.2, 5, 8),
    puff(0.5, 7, 10),
    puff(0.8, 5, 8),
    puff(0.35, 4, 7, 0, "bottom"),
    puff(0.65, 4, 7, 0, "bottom"),
  ],
  // The three fingers it holds up, and nothing underneath: it sprouts.
  sprout: [oval(0.3, 6, 5, -14), oval(0.5, 8, 6), oval(0.72, 6, 5, 16)],
  // Points, broad and few.
  star: [
    spike(0.25, 6, 6, -26),
    spike(0.5, 8, 6),
    spike(0.75, 6, 6, 26),
    spike(0.35, 4, 5, 14, "bottom"),
    spike(0.65, 4, 5, -14, "bottom"),
  ],
  // The dome above and the scalloped hem below, which is the whole ghost.
  ghost: [
    puff(0.5, 5, 20),
    puff(0.25, 3, 6, 0, "bottom"),
    puff(0.5, 3, 6, 0, "bottom"),
    puff(0.75, 3, 6, 0, "bottom"),
  ],
  // Many thin spines, at every angle, because that is all an urchin is.
  urchin: [
    spike(0.1, 5, 2.6, -38),
    spike(0.24, 7, 2.6, -24),
    spike(0.38, 6, 2.6, -10),
    spike(0.5, 8, 2.6),
    spike(0.62, 6, 2.6, 10),
    spike(0.76, 7, 2.6, 24),
    spike(0.9, 5, 2.6, 38),
    spike(0.2, 4, 2.6, 22, "bottom"),
    spike(0.4, 5, 2.6, 8, "bottom"),
    spike(0.6, 5, 2.6, -8, "bottom"),
    spike(0.8, 4, 2.6, -22, "bottom"),
  ],
  // One more layer on the pile, above and below.
  stack: [puff(0.5, 4, 24), puff(0.5, 3, 22, 0, "bottom")],
  // Petals, fanned.
  flower: [
    oval(0.15, 6, 4.5, -50),
    oval(0.35, 7, 4.5, -25),
    oval(0.5, 8, 4.5),
    oval(0.65, 7, 4.5, 25),
    oval(0.85, 6, 4.5, 50),
    oval(0.3, 5, 4.5, 30, "bottom"),
    oval(0.7, 5, 4.5, -30, "bottom"),
  ],
  // Jags, closer set and less regular than the star's.
  burst: [
    spike(0.1, 5, 5, -32),
    spike(0.3, 7, 5, -14),
    spike(0.5, 6, 5, 4),
    spike(0.7, 7, 5, 14),
    spike(0.9, 5, 5, 32),
    spike(0.25, 4, 4, 18, "bottom"),
    spike(0.5, 4, 4, -6, "bottom"),
    spike(0.75, 4, 4, -18, "bottom"),
  ],
  // The curved blades of the shuriken it is.
  ninja: [
    crescent(0.2, 7, 5, -34),
    crescent(0.5, 8, 5),
    crescent(0.8, 7, 5, 34),
    crescent(0.35, 5, 4.5, 20, "bottom"),
    crescent(0.65, 5, 4.5, -20, "bottom"),
  ],
};

/**
 * The features a body shape bristles with, or `undefined` for a shape this
 * module has no vocabulary for.
 */
export const bristleFor = (
  bodyShape: string,
): readonly BristleFeature[] | undefined => BRISTLES[bodyShape];

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
 * A counter rather than a boolean because each bristle is a one-shot
 * animation, and a node keyed by the count remounts and replays it. There is
 * nothing to turn off: the animation ends flat on its own, so disabling simply
 * stops the next one from being scheduled.
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

/** Two decimals is plenty at this size and keeps the path data short. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * The outline of one feature in its local frame: base centred on the origin,
 * growing along negative y, and running {@link BASE_INSET} below the origin so
 * the seam sits under the capsule.
 */
export const featurePath = (feature: BristleFeature): string => {
  const h = feature.width / 2;
  const r = feature.reach;
  const base = `M${n(-h)} ${BASE_INSET} L${n(-h)} 0`;
  const close = `L${n(h)} ${BASE_INSET} Z`;
  switch (feature.kind) {
    case "spike":
      return `${base} L0 ${n(-r)} L${n(h)} 0 ${close}`;
    case "oval":
      return `${base} C${n(-h)} ${n(-r * 0.6)} ${n(-h * 0.55)} ${n(-r)} 0 ${n(-r)} C${n(h * 0.55)} ${n(-r)} ${n(h)} ${n(-r * 0.6)} ${n(h)} 0 ${close}`;
    case "puff":
      return `${base} C${n(-h)} ${n(-r * 1.33)} ${n(h)} ${n(-r * 1.33)} ${n(h)} 0 ${close}`;
    case "crescent":
      return `${base} C${n(-h * 1.8)} ${n(-r * 0.5)} ${n(-h * 0.2)} ${n(-r * 0.95)} ${n(h * 0.8)} ${n(-r)} C${n(h * 0.2)} ${n(-r * 0.7)} ${n(h * 0.6)} ${n(-r * 0.3)} ${n(h)} 0 ${close}`;
  }
};

/**
 * The capsule the features grow out of, in points: the accent the user sees
 * and the rim around it. Stated by the caller, which is where the capsule is
 * drawn, so the two cannot drift.
 */
export interface BristleCapsule {
  width: number;
  height: number;
  rim: number;
}

/**
 * The canvas the features are drawn on: the capsule's box plus the reach on
 * both sides, centred where the capsule is.
 */
export const bristleBox = (
  capsule: BristleCapsule,
): { width: number; height: number } => ({
  width: capsule.width + 2 * capsule.rim,
  height: capsule.height + 2 * capsule.rim + 2 * BRISTLE_REACH,
});

export function CompanionBristle({
  bodyShape,
  features: featuresOverride,
  accentHex,
  rimHex,
  capsule,
  enabled,
  held = false,
  interval = BRISTLE_INTERVAL_SECONDS,
  className,
  style,
}: {
  /** The catalog id of the creature's body shape. */
  bodyShape: string;
  /**
   * What to draw instead of the shape's own vocabulary. For the stories that
   * put alternatives side by side; the surface never passes it.
   */
  features?: readonly BristleFeature[];
  accentHex: string;
  /** The capsule's own rim colour, so the features wear the same edge. */
  rimHex: string;
  capsule: BristleCapsule;
  /**
   * Whether the next bristle should be scheduled. Off while the creature is
   * out of the capsule, and off while it is working: a working creature holds
   * a focused pose, and it stops blinking for the same reason.
   */
  enabled: boolean;
  /**
   * Draw every feature at full stretch and keep it there, with no clock. For
   * looking at the vocabulary rather than the motion; the surface never
   * passes it.
   */
  held?: boolean;
  interval?: BristleInterval;
  className?: string;
  style?: CSSProperties;
}) {
  // A bristle is travel across the screen, so for a reader who asked for
  // stillness there is none. The stylesheet holds the features flat too; this
  // is what keeps the timer from running at all.
  const reduce = useReducedMotion();
  const features = featuresOverride ?? bristleFor(bodyShape);
  const count = useBristle(
    enabled && !held && !reduce && features !== undefined,
    interval,
  );

  if (features === undefined || reduce) {
    return null;
  }

  const box = bristleBox(capsule);
  const top = BRISTLE_REACH;
  const bottom = BRISTLE_REACH + capsule.height + 2 * capsule.rim;

  return (
    <svg
      className={`companion-bristle ${className ?? ""}`}
      width={box.width}
      height={box.height}
      viewBox={`0 0 ${box.width} ${box.height}`}
      style={style}
      aria-hidden
    >
      {/* Keyed by the count so each bristle remounts the features and replays
        the one-shot travel. Nothing is drawn before the first: the features
        start flat, but a node that has never fired has nothing to say. */}
      {count > 0 || held ? (
        <g key={count}>
          {features.map((feature, index) => {
            const x = capsule.rim + feature.at * capsule.width;
            const tilt = feature.tilt ?? 0;
            const placement =
              feature.side === "top"
                ? `translate(${n(x)} ${top}) rotate(${n(tilt)})`
                : `translate(${n(x)} ${bottom}) rotate(${n(180 - tilt)})`;
            return (
              <g key={index} transform={placement}>
                <path
                  className="companion-bristle-feature"
                  d={featurePath(feature)}
                  fill={accentHex}
                  stroke={rimHex}
                  strokeWidth={capsule.rim}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  style={
                    held
                      ? { animation: "none", transform: "scaleY(1)" }
                      : // Its place in the stagger. The stylesheet turns it
                        // into a delay, so the spacing is stated once, beside
                        // the travel it spaces out.
                        { ["--bristle-index" as string]: index }
                  }
                />
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}
