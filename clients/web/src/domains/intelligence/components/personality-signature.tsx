/**
 * The personality signature: one capsule per trait axis, rising or falling from
 * a shared dashed rule, with that axis' two poles named above and below it
 * ("Coworker" over "Companion"). A capsule's reach toward one of its own two
 * words is the whole reading, so there is no chart grammar to learn. The
 * axes are bipolar (50 is neutral and both ends are equally valid), which is
 * why the mark measures from a centre rule rather than from a corner or an
 * origin. A personality nobody has tuned sits flat on that rule.
 *
 * The axes are unordered, so nothing joins one capsule to the next. Each grows
 * from the rule they all share, and its length repeats what its height already
 * says: how far that trait sits from neutral. A trait nobody has set collapses
 * to a pip resting on the rule.
 *
 * The mark rides `--card-accent` and the rule and labels ride `currentColor`,
 * so the card can flip the whole thing while flooded.
 */

import { animate, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useState } from "react";

import {
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
} from "../identity-actions/personality-axes";

const W = 340;
/**
 * The frame is taller than the mark strictly needs so the signature fills its
 * card rather than floating in the middle of it — the extra height goes to
 * capsule travel and to the gap between the poles, not to dead margin. The
 * label baselines sit the same distance from the top and bottom edges, so a
 * frame that ends flush with the card leaves an even gap at both.
 */
const H = 226;
/** The neutral line: where a trait sits when neither pole has been chosen. */
const MID = 113;
const PAD_X = 46;
/** Vertical travel from the neutral line to a pole. */
const SPAN = 58;
/** Baselines for the first line of each pole label. */
const TOP_Y = 15;
const BOTTOM_Y = 216;
const LINE_H = 11.5;
/** Inside this much of neutral a trait reads as unset, not as a lean. */
const DEAD_ZONE = 5;
/** Capsule width; also the diameter an unset trait collapses to. */
const CAP_W = 10;
/** Both poles of an unset trait, then the pole a set trait moved away from. */
const NEUTRAL_LABEL_OPACITY = 0.42;
const FADED_LABEL_OPACITY = 0.26;

const XS = PERSONALITY_AXES.map(
  (_, i) => PAD_X + (i * (W - PAD_X * 2)) / (PERSONALITY_AXES.length - 1),
);

function axisValue(values: Record<string, number>, id: string): number {
  const n = values[id] ?? PERSONALITY_AXIS_DEFAULT;
  return Math.max(0, Math.min(100, n));
}

function yFor(value: number): number {
  return MID - ((value - 50) / 50) * SPAN;
}

/** "Baby Boomer" needs two lines at this size; single words never wrap. */
function poleLines(label: string): string[] {
  return label.length > 8 && label.includes(" ") ? label.split(" ") : [label];
}

interface PoleLabelProps {
  x: number;
  label: string;
  /** Above the rule the label grows downward; below it, upward. */
  above: boolean;
  /** This is the pole the trait was pushed toward. */
  leaning: boolean;
  /** The trait sits in the dead zone, so neither pole won. */
  neutral: boolean;
  /** How far the trait was pushed, 0–1. */
  magnitude: number;
}

/** The pole a trait leans toward comes up to full weight; the other recedes. */
function PoleLabel({
  x,
  label,
  above,
  leaning,
  neutral,
  magnitude,
}: PoleLabelProps) {
  const rows = poleLines(label);
  const y = above ? TOP_Y : BOTTOM_Y - (rows.length - 1) * LINE_H;
  const strong = leaning && !neutral;
  const opacity = neutral
    ? NEUTRAL_LABEL_OPACITY
    : strong
      ? 0.62 + 0.38 * magnitude
      : FADED_LABEL_OPACITY;
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={10}
      fontWeight={strong ? 600 : 400}
      fill="currentColor"
      fillOpacity={opacity}
    >
      {rows.map((row, i) => (
        <tspan key={row} x={x} dy={i === 0 ? 0 : LINE_H}>
          {row}
        </tspan>
      ))}
    </text>
  );
}

interface PersonalitySignatureProps {
  values: Record<string, number>;
  className?: string;
}

export function PersonalitySignature({
  values,
  className,
}: PersonalitySignatureProps) {
  const reduce = useReducedMotion();

  const axes = PERSONALITY_AXES.map((axis) => {
    const value = axisValue(values, axis.id);
    const lean = value - 50;
    const neutral = Math.abs(lean) <= DEAD_ZONE;
    return { axis, value, lean, neutral, magnitude: Math.abs(lean) / 50 };
  });

  // The mark grows out of the neutral line on mount. A spring drives the
  // values themselves rather than a transform on the group: scaling a group
  // would stretch the stroke and squash the dots into ellipses.
  const [grown, setGrown] = useState(reduce ? 1 : 0);
  useEffect(() => {
    if (reduce) {
      setGrown(1);
      return;
    }
    const controls = animate(0, 1, {
      type: "spring",
      stiffness: 140,
      damping: 16,
      onUpdate: setGrown,
    });
    return () => controls.stop();
  }, [reduce]);

  const ys = axes.map((a) => yFor(50 + (a.value - 50) * grown));

  const ariaLabel = axes
    .map(({ axis, lean, neutral, magnitude }) => {
      if (neutral) {
        return `${axis.left} and ${axis.right} balanced`;
      }
      return `${Math.round(magnitude * 100)}% ${lean > 0 ? axis.right : axis.left}`;
    })
    .join(", ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Personality: ${ariaLabel}`}
      className={className}
    >
      <line
        x1={PAD_X - 14}
        y1={MID}
        x2={W - PAD_X + 14}
        y2={MID}
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={1}
        strokeDasharray="2 4"
      />

      {/* Each capsule reaches from the rule to its own value and stops. The
          axes are unordered, so nothing spans two of them: a shape crossing
          from one axis to the next would imply a value in between.
          A rounded rect rather than a round-capped line, because an unset
          trait is a zero-length run, which browsers disagree about drawing. */}
      {axes.map(({ axis }, i) => (
        <rect
          key={axis.id}
          x={XS[i]! - CAP_W / 2}
          y={Math.min(MID, ys[i]!) - CAP_W / 2}
          width={CAP_W}
          height={Math.abs(ys[i]! - MID) + CAP_W}
          rx={CAP_W / 2}
          fill="var(--card-accent)"
        />
      ))}

      {axes.map(({ axis, lean, neutral, magnitude }, i) => (
        <Fragment key={axis.id}>
          <PoleLabel
            x={XS[i]!}
            label={axis.right}
            above
            leaning={lean > 0}
            neutral={neutral}
            magnitude={magnitude}
          />
          <PoleLabel
            x={XS[i]!}
            label={axis.left}
            above={false}
            leaning={lean < 0}
            neutral={neutral}
            magnitude={magnitude}
          />
        </Fragment>
      ))}
    </svg>
  );
}
