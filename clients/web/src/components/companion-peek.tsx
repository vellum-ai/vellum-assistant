import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import type { CompanionCharacter } from "@vellumai/ipc-contract";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  avatarPeekMetrics,
  type AvatarPeekMetrics,
} from "@/utils/avatar-peek-metrics";

/**
 * The peek: the creature pulling itself out of the resting capsule.
 *
 * At rest the companion is a thin capsule in the assistant's colour and nothing
 * else (see `RESTING_HEIGHT` in `companion-surface.tsx`). That is the right
 * thing to leave on a desktop all day, and it is also a shape with nobody in
 * it. Every few seconds the creature rises out of one of the capsule's edges,
 * far enough to show its eyes, looks out for a moment, and ducks back in. The
 * marker stays a marker, and once in a while whoever is inside it looks out.
 *
 * **The same peek the chat page makes.** `ComposerPeek` surfaces the creature
 * over the composer's top rim when the input is focused; this is the same act
 * over a smaller rim. It borrows the same measurement (`avatarPeekMetrics`,
 * which says where each body and eye style actually put the eye ink, so the
 * eyes ride the edge on every creature rather than a fixed slice of body) and
 * the same choreography: a springy rise, a hold, and a quick duck.
 *
 * **From any edge.** Each peek picks one of the capsule's four edges at
 * random and the creature comes out of that one, turned so its crown faces
 * out: upright over the top, hanging upside down under the bottom, sideways
 * off either end. That is what the chat page does when its hello hangs off
 * the composer's bottom rim, and it is what keeps the eyes riding the rim
 * whichever edge they clear: the geometry is measured once, for the top, and
 * the whole frame is turned.
 *
 * **The capsule stretches into the creature.** A creature rising out of a pill
 * that holds still reads as two things, one behind the other; a second pill
 * sliding out under it reads as a device with a slot. What reads as one body
 * is a collar: the capsule's own colour, running from the capsule's
 * cross-section out to the creature's actual width where it is cut, so the
 * pill necks up into a narrow creature and funnels out around a wide one. The
 * creature is cut {@link PEEK_STRETCH} past the capsule's edge at the top of
 * the rise and the collar fills that gap, growing on the same spring, so the
 * pill is visibly what the creature is pulling out of.
 *
 * **The creature's actual artwork.** The peeking creature is `AnimatedAvatar`,
 * so it blinks and breathes while it is up, and the collar's far end is read
 * off the body shape's path, so it meets each creature where that creature
 * actually is. A custom uploaded image has no creature to peek: the surface
 * passes no character and the capsule stays still.
 *
 * **Random, inside a stated range.** A fixed period reads as a machine ticking;
 * a random one inside {@link PEEK_INTERVAL_SECONDS} reads as a creature
 * checking on things. Each peek schedules the next, so the gaps are
 * independent draws rather than a phase-shifted clock.
 */

/**
 * The gap between one peek and the next, in seconds, as a range the actual
 * delay is drawn from uniformly.
 *
 * Low enough to be seen by someone who glances at the marker now and then, high
 * enough that it is not a thing happening in the corner of the eye all day.
 */
export const PEEK_INTERVAL_SECONDS = { min: 3, max: 10 };

export interface PeekInterval {
  /** The shortest gap, in seconds. */
  min: number;
  /** The longest gap, in seconds. */
  max: number;
}

/** The edges the creature can come out of. */
export const PEEK_EDGES = ["top", "right", "bottom", "left"] as const;
export type PeekEdge = (typeof PEEK_EDGES)[number];

/**
 * One draw of an edge. `random` is a parameter so the four quarters can be
 * stated as a test.
 */
export const pickEdge = (random: () => number = Math.random): PeekEdge =>
  PEEK_EDGES[Math.min(3, Math.floor(random() * 4))]!;

/** How long the creature stays up, in milliseconds, before ducking. */
export const PEEK_HOLD_MS = 1600;

/** The duck back down, in seconds, for the transition. */
const DUCK_SECONDS = 0.22;

/**
 * How far past the capsule's edge the creature is cut at the top of the rise,
 * which is the length of the collar joining the two.
 */
export const PEEK_STRETCH = 6;

/**
 * How far the collar runs on past the cut, under the creature. The two edges
 * would otherwise meet on one line, and two antialiased edges on one line
 * leave a hairline of desktop between them.
 */
const COLLAR_LAP = 1;

/**
 * The most of the creature that shows past the collar, in points.
 *
 * A body whose face sits low would otherwise expose a tall slab of itself to
 * get its eyes over the edge; capping the exposure scales that creature down
 * instead, which is what the chat page's peek does too. Half the capsule's
 * width: enough for eyes and a crown, not a creature standing on a pill.
 */
export const PEEK_EXPOSED_MAX = 14;

/** Air between the eye ink's bottom and the cut, as a fraction of the square. */
const EYE_PAD_FRAC = 0.04;

/**
 * Room above the exposed creature for the breathing pulse, and beside it for
 * the idle twitch, so neither is sliced flat by the clip.
 */
const HEADROOM = 4;

/**
 * How far the creature is drawn, on every axis, from the measurements.
 *
 * `size` is the creature's square. `exposed` is how much of it shows past the
 * cut at the top of the rise: down to just under the eye ink. `clip` is the
 * box it is drawn in, whose bottom edge is the cut, and `rest` is how far
 * below the top of the rise it sits when hidden: its whole exposure plus a
 * little, so nothing of it shows through the clip's bottom edge.
 */
export interface PeekGeometry {
  size: number;
  exposed: number;
  clip: { width: number; height: number };
  rest: number;
}

export const peekGeometry = (
  metrics: AvatarPeekMetrics,
  fullSize: number,
): PeekGeometry => {
  const exposedFrac = Math.min(
    0.95,
    Math.max(0.25, metrics.eyeCenterFrac + metrics.eyeHalfFrac + EYE_PAD_FRAC),
  );
  const size = Math.min(fullSize, PEEK_EXPOSED_MAX / exposedFrac);
  const exposed = size * exposedFrac;
  return {
    size,
    exposed,
    clip: { width: size + 2 * HEADROOM, height: exposed + HEADROOM },
    rest: exposed + 2,
  };
};

/**
 * One draw from the interval, in milliseconds.
 *
 * `random` is a parameter so the arithmetic can be stated as a test: the
 * shortest gap at 0, the longest at 1, and nothing outside them between.
 */
export const peekDelayMs = (
  interval: PeekInterval,
  random: () => number = Math.random,
): number => (interval.min + random() * (interval.max - interval.min)) * 1000;

/**
 * A counter that goes up once per peek, at random gaps inside `interval`,
 * for as long as `enabled` holds.
 *
 * A counter rather than a boolean because each peek is one rise-and-duck,
 * and the count is what starts one. There is nothing to turn off: a peek
 * ducks on its own, so disabling simply stops the next one from being
 * scheduled.
 */
export function usePeekClock(
  enabled: boolean,
  interval: PeekInterval = PEEK_INTERVAL_SECONDS,
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
      }, peekDelayMs({ min, max }));
    };
    schedule();
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, min, max]);
  return count;
}

/**
 * The capsule the creature peeks over, in points. Stated by the caller, which
 * is where the capsule is drawn, so the two cannot drift.
 */
export interface PeekCapsule {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;
const COMMAND = /([MLHVCZmlhvcz])([^MLHVCZmlhvcz]*)/g;

/**
 * The artwork as polylines, one per subpath, in its own viewBox.
 *
 * The catalog's paths are absolute moves, lines and cubics, closed; the
 * relative forms and the axis-aligned lines are read too, for a shape drawn
 * by a different hand. Anything else is skipped rather than thrown on.
 */
export const flattenPath = (d: string, curveSteps = 8): Point[][] => {
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
    const command = letter?.toUpperCase();
    const relative = letter === letter?.toLowerCase();
    const at = (x: number, y: number): Point =>
      relative ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
    switch (command) {
      case "M":
      case "L": {
        if (command === "M") {
          close();
        }
        for (let i = 0; i + 1 < nums.length; i += 2) {
          cursor = at(nums[i]!, nums[i + 1]!);
          if (command === "M" && i === 0) {
            start = cursor;
          }
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

const outlines = new Map<string, Point[][]>();

/** A body shape's outline, flattened once for the life of the module. */
const outlineFor = (bodyShape: string): Point[][] | undefined => {
  if (!outlines.has(bodyShape)) {
    const shape = BUNDLED_COMPONENTS.bodyShapes.find(
      (candidate) => candidate.id === bodyShape,
    );
    if (shape === undefined) {
      return undefined;
    }
    outlines.set(bodyShape, flattenPath(shape.svgPath));
  }
  return outlines.get(bodyShape);
};

/**
 * Where a body is, left to right, on the line `cutY` points down from the top
 * of its `size` square: the span the collar has to meet.
 *
 * Measured on the artwork rather than assumed, because the cut lands under
 * the eyes and bodies differ wildly there: a burst is narrow at the neck, a
 * cloud is nearly its full width. The body is fit-centred in the square, the
 * way `AnimatedAvatar` lays it out. `null` when the line misses the body,
 * which a cut under the eyes never does on a catalog shape.
 */
export const bodySpanAt = (
  bodyShape: string,
  size: number,
  cutY: number,
): { left: number; right: number } | null => {
  const shape = BUNDLED_COMPONENTS.bodyShapes.find(
    (candidate) => candidate.id === bodyShape,
  );
  const lines = outlineFor(bodyShape);
  if (shape === undefined || lines === undefined) {
    return null;
  }
  const vb = shape.viewBox;
  const k = Math.min(size / vb.width, size / vb.height);
  const tx = (size - vb.width * k) / 2;
  const ty = (size - vb.height * k) / 2;
  const y = (cutY - ty) / k;

  let left = Infinity;
  let right = -Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i]!;
      const b = line[(i + 1) % line.length]!;
      if (a.y === b.y || y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) {
        continue;
      }
      const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (left === Infinity) {
    return null;
  }
  return { left: left * k + tx, right: right * k + tx };
};

/**
 * The collar's outline, in a box `width` wide whose bottom edge sits `inset`
 * inside the capsule and whose top edge is {@link PEEK_STRETCH} and a lap
 * past it.
 *
 * The base is the capsule's cross-section, centred, on the box's bottom
 * edge: that line is the capsule's own centre line, where it is its full
 * cross-section on every edge, so the base is under the capsule whatever the
 * edge. The far end is the creature's span at the cut, `reach` past the
 * capsule's edge. Each side is one S-curve between them, vertical at both
 * ends, which is what makes the join read as the pill pulled rather than the
 * pill plus a wedge.
 *
 * Collapsed, the far end sits on the base line at the base's own width (see
 * {@link collapsedCollar}), so the collar has no area and is inside the
 * capsule. The same points either way, so the browser can tween between the
 * two, and the far end widens as it travels: a far end that started at the
 * creature's width would show as a sliver the creature's width across the
 * capsule's end for the first frames of a rise, since across the ends the
 * creature is wider than the capsule.
 */
export const collarPath = (
  width: number,
  crossSection: number,
  span: { left: number; right: number },
  inset: number,
  reach: number,
): string => {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  const base = inset + PEEK_STRETCH + COLLAR_LAP;
  const far = PEEK_STRETCH + COLLAR_LAP - reach;
  const a = crossSection / 2;
  const cx = width / 2;
  const mid1 = base - (base - far) * 0.45;
  const mid2 = base - (base - far) * 0.55;
  return [
    `M${n(cx - a)} ${n(base)}`,
    `C${n(cx - a)} ${n(mid1)} ${n(span.left)} ${n(mid2)} ${n(span.left)} ${n(far)}`,
    `L${n(span.right)} ${n(far)}`,
    `C${n(span.right)} ${n(mid2)} ${n(cx + a)} ${n(mid1)} ${n(cx + a)} ${n(base)}`,
    "Z",
  ].join(" ");
};

/** The collar collapsed into the capsule: no area, and nothing past the
 *  capsule's cross-section. */
export const collapsedCollar = (
  width: number,
  crossSection: number,
  inset: number,
): string =>
  collarPath(
    width,
    crossSection,
    { left: width / 2 - crossSection / 2, right: width / 2 + crossSection / 2 },
    inset,
    -inset,
  );

/**
 * Where a box measured for the top (rim side down, creature rising up) sits
 * for each edge, and how it is turned so its rim side faces the capsule.
 *
 * `offset` is how far the box's rim side sits past the capsule's edge:
 * negative reaches inside. The box is placed against the edge and turned,
 * which carries any clip with it: overflow is cut in the box's own frame, so
 * a turned box still hides everything past its rim side. The slot the box
 * turns inside is the box's own size with the axes swapped for the ends, so
 * the turned box fills it exactly.
 */
export const frameFor = (
  edge: PeekEdge,
  box: { width: number; height: number },
  offset: number,
): { slot: CSSProperties; turn: number } => {
  const across = { width: box.width, height: box.height };
  const along = { width: box.height, height: box.width };
  const centreX = { left: "50%", marginLeft: -box.width / 2 };
  const centreY = { top: "50%", marginTop: -box.width / 2 };
  const past = `calc(100% + ${offset}px)`;
  switch (edge) {
    case "top":
      return { slot: { ...across, ...centreX, bottom: past }, turn: 0 };
    case "bottom":
      return { slot: { ...across, ...centreX, top: past }, turn: 180 };
    case "left":
      return { slot: { ...along, ...centreY, right: past }, turn: -90 };
    case "right":
      return { slot: { ...along, ...centreY, left: past }, turn: 90 };
  }
};

/**
 * The capsule's cross-section on an edge: its width across the top and
 * bottom, its height across the ends.
 */
export const crossSectionOf = (edge: PeekEdge, capsule: PeekCapsule): number =>
  edge === "top" || edge === "bottom" ? capsule.width : capsule.height;

/** The axis a window moves along to go out of an edge, and which way. */
const outward = (edge: PeekEdge): { axis: "x" | "y"; sign: number } =>
  edge === "top"
    ? { axis: "y", sign: -1 }
    : edge === "bottom"
      ? { axis: "y", sign: 1 }
      : edge === "left"
        ? { axis: "x", sign: -1 }
        : { axis: "x", sign: 1 };

/**
 * A box measured for the top, placed and turned for `edge`: the slot, and
 * inside it the box itself, centred and rotated.
 */
function Turned({
  edge,
  box,
  offset,
  className,
  children,
}: {
  edge: PeekEdge;
  box: { width: number; height: number };
  offset: number;
  className?: string;
  children: ReactNode;
}) {
  const frame = frameFor(edge, box, offset);
  return (
    <div className="absolute" style={frame.slot}>
      <div
        className={`absolute ${className ?? ""}`}
        style={{
          width: box.width,
          height: box.height,
          left: (Number(frame.slot.width) - box.width) / 2,
          top: (Number(frame.slot.height) - box.height) / 2,
          transform: `rotate(${frame.turn}deg)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function CompanionPeek({
  character,
  accentHex,
  capsule,
  enabled,
  held = false,
  edge: fixedEdge,
  interval = PEEK_INTERVAL_SECONDS,
  className,
  style,
}: {
  /** The traits the creature is composed from. */
  character: CompanionCharacter;
  /** The capsule's colour, which the collar is drawn in. */
  accentHex: string;
  capsule: PeekCapsule;
  /**
   * Whether the next peek should be scheduled. Off while the creature is
   * already out of the capsule, and off while it is working: a working
   * creature holds a focused pose, and it stops blinking for the same reason.
   */
  enabled: boolean;
  /**
   * Hold the creature up, with no clock. For looking at the peek rather than
   * the motion; the surface never passes it.
   */
  held?: boolean;
  /**
   * Always come out of this edge. For the stories that line the four up; the
   * surface never passes it, and each peek draws its own.
   */
  edge?: PeekEdge;
  interval?: PeekInterval;
  className?: string;
  style?: CSSProperties;
}) {
  // A peek is travel across the screen, so for a reader who asked for
  // stillness there is none. Nothing is drawn and no clock runs.
  const reduce = useReducedMotion();
  const metrics = useMemo(
    () => avatarPeekMetrics(BUNDLED_COMPONENTS, character),
    [character],
  );
  const geometry = useMemo(
    () => (metrics === null ? null : peekGeometry(metrics, capsule.width)),
    [metrics, capsule.width],
  );
  const span = useMemo(
    () =>
      geometry === null
        ? null
        : bodySpanAt(character.bodyShape, geometry.size, geometry.exposed),
    [character.bodyShape, geometry],
  );
  const count = usePeekClock(
    enabled && !held && !reduce && geometry !== null && span !== null,
    interval,
  );

  // Up for the hold, then down. A peek that is cut short by the creature
  // coming out of the capsule is fine: the whole node fades with the capsule.
  const [risen, setRisen] = useState(false);
  const [drawnEdge, setDrawnEdge] = useState<PeekEdge>("top");
  useEffect(() => {
    if (count === 0) {
      return;
    }
    // Drawn while the creature is still down, so the frame turns unseen.
    setDrawnEdge(pickEdge());
    setRisen(true);
    const timer = setTimeout(() => {
      setRisen(false);
    }, PEEK_HOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [count]);

  if (geometry === null || span === null || reduce) {
    return null;
  }

  const up = held || risen;
  const edge = fixedEdge ?? drawnEdge;
  const transition = held
    ? { duration: 0 }
    : up
      ? { type: "spring" as const, stiffness: 280, damping: 14 }
      : { duration: DUCK_SECONDS, ease: "easeIn" as const };

  // The collar's box: from the capsule's centre line out to the cut.
  const inset = capsule.height / 2;
  const collar = {
    width: geometry.clip.width,
    height: inset + PEEK_STRETCH + COLLAR_LAP,
  };
  const spanInCollar = {
    left: HEADROOM + span.left,
    right: HEADROOM + span.right,
  };
  const move = outward(edge);

  return (
    // Sized as the capsule's own box and placed where the caller puts the
    // capsule, so everything below can hang off its edges.
    <div
      className={`companion-peek ${className ?? ""}`}
      style={{
        width: capsule.width,
        height: capsule.height,
        ...style,
      }}
      data-risen={up}
      data-edge={edge}
      aria-hidden
    >
      {/* The creature, in a window whose rim side rides out from the
        capsule's edge to the cut on the same spring as the rise. Overflow
        hidden is what makes the creature come out from behind the capsule
        rather than up in front of it. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ [move.axis]: up ? PEEK_STRETCH * move.sign : 0 }}
        transition={transition}
      >
        <Turned
          edge={edge}
          box={geometry.clip}
          offset={0}
          className="overflow-hidden"
        >
          <motion.div
            className="absolute left-1/2"
            style={{
              width: geometry.size,
              height: geometry.size,
              marginLeft: -geometry.size / 2,
              top: geometry.clip.height - geometry.exposed,
            }}
            initial={{ y: geometry.rest }}
            animate={{ y: up ? 0 : geometry.rest }}
            transition={transition}
          >
            <AnimatedAvatar
              components={BUNDLED_COMPONENTS}
              traits={character}
              size={geometry.size}
            />
          </motion.div>
        </Turned>
      </motion.div>
      {/* The collar, drawn after the creature so it sits over the creature's
        base and under the surface's capsule: more of the pill, pulled out to
        meet the creature. */}
      <Turned edge={edge} box={collar} offset={-inset}>
        <svg
          className="companion-peek-collar"
          width={collar.width}
          height={collar.height}
          viewBox={`0 0 ${collar.width} ${collar.height}`}
        >
          <motion.path
            fill={accentHex}
            initial={false}
            animate={{
              d: up
                ? collarPath(
                    collar.width,
                    crossSectionOf(edge, capsule),
                    spanInCollar,
                    inset,
                    PEEK_STRETCH + COLLAR_LAP,
                  )
                : collapsedCollar(
                    collar.width,
                    crossSectionOf(edge, capsule),
                    inset,
                  ),
            }}
            transition={transition}
          />
        </svg>
      </Turned>
    </div>
  );
}
