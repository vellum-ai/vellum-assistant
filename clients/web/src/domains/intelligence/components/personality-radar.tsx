/**
 * Pentagon radar of the persisted personality slider values, shown on the
 * overview's Personality card — one spoke per trait axis, measured toward
 * the axis' "100" pole, with two-line labels naming both poles
 * ("Coworker / vs. companion"). Matches the Figma spec (New-App
 * 6944-89257): solid nested-pentagon grid, straight-edged value polygon
 * in the avatar accent (`--card-accent`, set by the bento) over a
 * translucent fill, springing in on mount.
 *
 * Grid and labels ride `currentColor`, so the card can flip them while
 * flooded.
 */

import { motion } from "motion/react";

import { PERSONALITY_AXIS_DEFAULT } from "../identity-actions/personality-axes";

/** One spoke per axis, valued toward the named pole (the axis' 100 end). */
const RADAR_SPOKES: {
  label: string;
  sub: string;
  value: (v: Record<string, number>) => number;
}[] = [
  { label: "Coworker", sub: "vs. companion", value: (v) => axis(v, "companion-coworker") },
  { label: "Baby Boomer", sub: "vs. Gen Z", value: (v) => axis(v, "genz-boomer") },
  { label: "Collaborative", sub: "vs. independent", value: (v) => axis(v, "execute-collaborate") },
  { label: "Serious", sub: "vs. playful", value: (v) => axis(v, "playful-serious") },
  { label: "Unfiltered", sub: "vs. polite", value: (v) => axis(v, "polite-unfiltered") },
];

function axis(values: Record<string, number>, id: string): number {
  const n = values[id] ?? PERSONALITY_AXIS_DEFAULT;
  return Math.max(0, Math.min(100, n));
}

const W = 356;
const H = 246;
const CX = W / 2;
const CY = 132;
const R = 100;
/** Zero values keep a visible nub instead of collapsing into the center. */
const MIN_VALUE_FRACTION = 0.1;
const RING_FRACTIONS = [0.25, 0.5, 0.75, 1];

/** Per-spoke label placement: anchor + offsets from the rim vertex. */
const LABEL_LAYOUT: {
  anchor: "start" | "middle" | "end";
  dx: number;
  dy: number;
}[] = [
  { anchor: "middle", dx: 0, dy: -18 }, // top
  { anchor: "start", dx: 9, dy: -2 }, // upper right
  { anchor: "start", dx: -10, dy: 17 }, // lower right (below the chart)
  { anchor: "end", dx: 10, dy: 17 }, // lower left (below the chart)
  { anchor: "end", dx: -9, dy: -2 }, // upper left
];

interface Point {
  x: number;
  y: number;
}

function spokePoint(i: number, radius: number): Point {
  const angle = -Math.PI / 2 + (i * 2 * Math.PI) / RADAR_SPOKES.length;
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

function polygonPoints(radiusFor: (i: number) => number): string {
  return RADAR_SPOKES.map((_, i) => {
    const p = spokePoint(i, radiusFor(i));
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
}

interface PersonalityRadarProps {
  values: Record<string, number>;
  className?: string;
}

export function PersonalityRadar({ values, className }: PersonalityRadarProps) {
  const ariaLabel = RADAR_SPOKES.map(
    (s) => `${s.label} ${Math.round(s.value(values))}`,
  ).join(", ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Personality: ${ariaLabel}`}
      className={className}
    >
      {RING_FRACTIONS.map((f) => (
        <polygon
          key={f}
          points={polygonPoints(() => R * f)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={1}
          strokeLinejoin="round"
        />
      ))}
      {RADAR_SPOKES.map((_, i) => {
        const p = spokePoint(i, R);
        return (
          <line
            key={i}
            x1={CX}
            y1={CY}
            x2={p.x}
            y2={p.y}
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={1}
          />
        );
      })}

      {/* The personality polygon springs in from the center on mount. */}
      <motion.g
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 140, damping: 16 }}
        style={{ transformOrigin: `${CX}px ${CY}px` }}
      >
        <polygon
          points={polygonPoints((i) =>
            R * Math.max(MIN_VALUE_FRACTION, RADAR_SPOKES[i]!.value(values) / 100),
          )}
          fill="var(--card-accent)"
          fillOpacity={0.25}
          stroke="var(--card-accent)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </motion.g>

      {RADAR_SPOKES.map((s, i) => {
        const layout = LABEL_LAYOUT[i]!;
        const p = spokePoint(i, R);
        const x = p.x + layout.dx;
        const y = p.y + layout.dy;
        return (
          <text key={s.label} x={x} y={y} textAnchor={layout.anchor}>
            <tspan x={x} fontSize={11.5} fontWeight={500} fill="currentColor">
              {s.label}
            </tspan>
            <tspan
              x={x}
              dy={12.5}
              fontSize={10}
              fill="currentColor"
              fillOpacity={0.8}
            >
              {s.sub}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}
