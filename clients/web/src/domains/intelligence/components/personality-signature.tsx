/**
 * The personality signature: one dot per trait axis on a dashed neutral rule,
 * joined by a drawn curve, with each axis' two poles named above and below its
 * dot ("Coworker" over "Companion"). A dot's height between its own pair of
 * words is the whole reading — there is no chart grammar to learn.
 *
 * This replaces a pentagon radar, which mis-encoded the data: the axes are
 * bipolar (50 is neutral and both ends are equally valid), so a radar's
 * "further out = more" grammar drew one pole as abundance and the other as
 * absence, and an untouched personality — the common case — drew a confident
 * but information-free pentagon. Here an untouched personality is a flat line.
 *
 * The dots carry the data; the curve and its wash only bind them into one
 * mark, so left-to-right order is a reading aid rather than a measurement.
 * The wash fades to nothing at the neutral rule, which puts the most ink
 * exactly where a trait is furthest from neutral.
 *
 * The mark rides `--card-accent` and the rule and labels ride `currentColor`,
 * so the card can flip the whole thing while flooded. `--signature-wash` (and
 * its opacity) let the photo backdrop soften the fill without a code change.
 */

import { animate, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useId, useState } from "react";

import {
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
} from "../identity-actions/personality-axes";

const W = 340;
const H = 194;
/** The neutral line: where a trait sits when neither pole has been chosen. */
const MID = 97;
const PAD_X = 46;
/** Vertical travel from the neutral line to a pole. */
const SPAN = 44;
/** Baselines for the first line of each pole label. */
const TOP_Y = 15;
const BOTTOM_Y = 179;
const LINE_H = 11.5;
/** Inside this much of neutral a trait reads as unset, not as a lean. */
const DEAD_ZONE = 5;
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

/**
 * A Catmull-Rom spline through the dots, emitted as cubic beziers so the mark
 * reads as drawn rather than plotted.
 *
 * `voice-reactive-waves` runs the same spline math over its sampled heights.
 * It stays separate deliberately: that one reads a `Float32Array` on every
 * animation frame, so giving both a shared point-array helper would put
 * per-frame allocation into its rAF loop.
 */
function curvePath(ys: number[]): string {
  let d = `M ${XS[0]!.toFixed(1)} ${ys[0]!.toFixed(1)}`;
  for (let i = 0; i < XS.length - 1; i++) {
    const prev = Math.max(0, i - 1);
    const after = Math.min(XS.length - 1, i + 2);
    const c1x = XS[i]! + (XS[i + 1]! - XS[prev]!) / 6;
    const c1y = ys[i]! + (ys[i + 1]! - ys[prev]!) / 6;
    const c2x = XS[i + 1]! - (XS[after]! - XS[i]!) / 6;
    const c2y = ys[i + 1]! - (ys[after]! - ys[i]!) / 6;
    d +=
      ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)},` +
      ` ${c2x.toFixed(1)} ${c2y.toFixed(1)},` +
      ` ${XS[i + 1]!.toFixed(1)} ${ys[i + 1]!.toFixed(1)}`;
  }
  return d;
}

/** The curve closed back along the neutral rule, for the gradient wash. */
function washPath(curve: string): string {
  return `${curve} L ${XS[XS.length - 1]!.toFixed(1)} ${MID} L ${XS[0]!.toFixed(1)} ${MID} Z`;
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
  // Both layouts can mount this at once, so the gradient needs an id that
  // can't collide. `useId` wraps its value in punctuation that `url(#…)`
  // won't take, hence the strip.
  const washId = `personality-wash-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

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
  // Built once per frame and shared: the wash is the same curve, closed.
  const curve = curvePath(ys);

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
      <defs>
        <linearGradient
          id={washId}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={0}
          x2={0}
          y2={H}
        >
          <stop
            offset="0"
            stopColor="var(--signature-wash, var(--card-accent))"
            stopOpacity={0.34}
          />
          <stop
            offset="0.5"
            stopColor="var(--signature-wash, var(--card-accent))"
            stopOpacity={0}
          />
          <stop
            offset="1"
            stopColor="var(--signature-wash, var(--card-accent))"
            stopOpacity={0.34}
          />
        </linearGradient>
      </defs>

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

      <path
        d={washPath(curve)}
        fill={`url(#${washId})`}
        // The photo backdrop softens the wash without changing the mark.
        style={{ fillOpacity: "var(--signature-wash-opacity, 1)" }}
      />
      <path
        d={curve}
        fill="none"
        stroke="var(--card-accent)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {axes.map(({ axis }, i) => (
        <circle
          key={axis.id}
          cx={XS[i]}
          cy={ys[i]}
          r={5}
          fill="var(--card-accent)"
          // The halo is whatever surface the dot sits on, so each dot reads
          // as a bead rather than a thickening of the curve. The card sets
          // `--signature-halo` wherever that surface isn't its own feature bg
          // (the flood, the photo backdrop).
          stroke="var(--signature-halo, var(--card-feature-bg, var(--card-bg, var(--surface-lift))))"
          strokeWidth={2.5}
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
