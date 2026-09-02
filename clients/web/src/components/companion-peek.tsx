import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import type { CompanionCharacter } from "@vellumai/ipc-contract";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  avatarPeekMetrics,
  type AvatarPeekMetrics,
} from "@/utils/avatar-peek-metrics";

/**
 * The peek: the creature looking out of the resting capsule.
 *
 * At rest the companion is a thin capsule in the assistant's colour and nothing
 * else (see `RESTING_HEIGHT` in `companion-surface.tsx`). That is the right
 * thing to leave on a desktop all day, and it is also a shape with nobody in
 * it. Every few seconds the creature rises from behind the capsule's edge,
 * far enough to show its eyes, looks out for a moment, and ducks back down.
 * The marker stays a marker, and once in a while whoever is inside it looks
 * out.
 *
 * **The same peek the chat page makes.** `ComposerPeek` surfaces the creature
 * over the composer's top rim when the input is focused; this is the same act
 * over a smaller rim. It borrows the same measurement (`avatarPeekMetrics`,
 * which says where each body and eye style actually put the eye ink, so the
 * eyes ride the edge on every creature rather than a fixed slice of body) and
 * the same choreography: a springy rise, a hold, and a quick duck.
 *
 * **Over the top or under the bottom.** Each peek draws one of the two at
 * random, independently of the last, so it can come up the same way twice
 * running and the next one is never a foregone conclusion. Under the bottom
 * the creature hangs upside down, which is what the chat page does when its
 * hello hangs off the composer's bottom rim. The geometry is measured once,
 * for the top, and the whole frame is turned over for the bottom, which is
 * what keeps the eyes riding the rim either way. The capsule's ends are not
 * edges it comes out of: a creature cut sideways is far taller than the
 * capsule's end, and it read as a separate thing beside the pill. Nor does
 * the capsule stretch to meet it: a collar joining the two was tried and read
 * as a second shape rather than as the pill, and the plain rise reads as the
 * creature behind the pill, which is what it is.
 *
 * **The creature's actual artwork.** The peeking creature is `AnimatedAvatar`,
 * so it blinks and breathes while it is up, and a custom uploaded image has no
 * creature to peek: the surface passes no character and the capsule stays
 * still.
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
export const PEEK_EDGES = ["top", "bottom"] as const;
export type PeekEdge = (typeof PEEK_EDGES)[number];

/**
 * One draw of an edge, a coin toss. `random` is a parameter so the two halves
 * can be stated as a test.
 */
export const pickEdge = (random: () => number = Math.random): PeekEdge =>
  random() < 0.5 ? "top" : "bottom";

/** How long the creature stays up, in milliseconds, before ducking. */
export const PEEK_HOLD_MS = 1600;

/** The duck back down, in seconds, for the transition. */
const DUCK_SECONDS = 0.22;

/**
 * The most of the creature that shows past the capsule, in points.
 *
 * A body whose face sits low would otherwise expose a tall slab of itself to
 * get its eyes over the edge; capping the exposure scales that creature down
 * instead, which is what the chat page's peek does too. Half the capsule's
 * width: enough for eyes and a crown, not a creature standing on a pill.
 */
export const PEEK_EXPOSED_MAX = 14;

/**
 * The widest the creature's square is drawn, in points.
 *
 * Below the capsule's own width, on purpose. The exposure cap alone lets a
 * creature whose face sits near its crown come up at the capsule's full width,
 * and a body that is still full-width at eye level (the ghost) then has its
 * sides cut flat by the rim exactly where the capsule's ends round away
 * beneath them: the creature stands out past the pill instead of rising from
 * behind it. This is what the widest of the other creatures already draws at,
 * and there the cut stays behind the capsule.
 */
export const PEEK_SIZE_MAX = 24;

/** Air between the eye ink's bottom and the rim, as a fraction of the square. */
const EYE_PAD_FRAC = 0.04;

/**
 * Room above the exposed creature for the breathing pulse, and beside it for
 * the idle twitch, so neither is sliced flat by the clip.
 */
const HEADROOM = 4;

/**
 * How far the creature is drawn, on every axis, from the measurements.
 *
 * `size` is the creature's square: the capsule's width, or less where
 * {@link PEEK_SIZE_MAX} or the exposure cap says so. `exposed` is how much of
 * it shows past the rim at the top of the rise: down to just under the eye
 * ink. `clip` is the
 * box it is drawn in, whose bottom edge is the rim, and `rest` is how far
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
  const size = Math.min(
    fullSize,
    PEEK_SIZE_MAX,
    PEEK_EXPOSED_MAX / exposedFrac,
  );
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

/**
 * Where the clip box, measured for the top (rim side down, creature rising
 * up), sits for each edge, and how it is turned so its rim side faces the
 * capsule.
 *
 * For the bottom the box is placed under the capsule and turned over, which
 * carries the clip with it: overflow is cut in the box's own frame, so a
 * turned box still hides everything past its rim side.
 */
export const frameFor = (
  edge: PeekEdge,
  box: { width: number; height: number },
): { slot: CSSProperties; turn: number } => {
  const slot = {
    width: box.width,
    height: box.height,
    left: "50%",
    marginLeft: -box.width / 2,
  };
  return edge === "top"
    ? { slot: { ...slot, bottom: "100%" }, turn: 0 }
    : { slot: { ...slot, top: "100%" }, turn: 180 };
};

export function CompanionPeek({
  character,
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
   * Always come out of this edge. For the stories that line the two up; the
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
  const count = usePeekClock(
    enabled && !held && !reduce && metrics !== null,
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

  if (metrics === null || reduce) {
    return null;
  }

  const geometry = peekGeometry(metrics, capsule.width);
  const up = held || risen;
  const edge = fixedEdge ?? drawnEdge;
  const frame = frameFor(edge, geometry.clip);

  return (
    // Sized as the capsule's own box and placed where the caller puts the
    // capsule, so the clip below can hang off its edge.
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
      {/* The slot against the chosen edge, and inside it the window the
        creature rises into, turned so its rim side faces the capsule.
        Overflow hidden is what makes the creature come out from behind the
        capsule rather than up in front of it. */}
      <div className="absolute" style={frame.slot}>
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ transform: `rotate(${frame.turn}deg)` }}
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
            transition={
              held
                ? { duration: 0 }
                : up
                  ? { type: "spring", stiffness: 280, damping: 14 }
                  : { duration: DUCK_SECONDS, ease: "easeIn" }
            }
          >
            <AnimatedAvatar
              components={BUNDLED_COMPONENTS}
              traits={character}
              size={geometry.size}
            />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
