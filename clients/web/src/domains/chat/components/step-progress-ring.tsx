/**
 * A ring that fills with a plan's step count: how far along, drawn rather than
 * spelled out.
 *
 * Sized to sit in a button's leading icon slot, so it reads as the glyph for a
 * plan in flight while carrying the same fraction the panel's "3 of 4" counter
 * states.
 *
 * The arc is the assistant's own accent, the same colour its avatar and the
 * loading sweeps carry, so the fraction reads as the assistant's work rather
 * than as neutral chrome. The track is a fixed low-contrast tone: it has to
 * stay legible against the accent wash that sweeps the pill during the
 * entrance.
 *
 * `total` of zero draws the bare track, which is the honest picture of a plan
 * with no steps to count.
 */

import { AVATAR_ACCENT } from "@/domains/chat/components/streaming-shimmer-text";

const SIZE_PX = 14;
const STROKE_PX = 2;

/** Radius inset by half the stroke, so the ring's edge lands inside the box. */
const RADIUS = (SIZE_PX - STROKE_PX) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StepProgressRing({
  current,
  total,
  className,
}: {
  /** Steps reached, matching the counter's numerator. */
  current: number;
  total: number;
  className?: string;
}) {
  const fraction = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const center = SIZE_PX / 2;

  return (
    <svg
      aria-hidden
      className={className}
      width={SIZE_PX}
      height={SIZE_PX}
      viewBox={`0 0 ${SIZE_PX} ${SIZE_PX}`}
      fill="none"
    >
      <circle
        cx={center}
        cy={center}
        r={RADIUS}
        stroke="var(--border-base)"
        strokeWidth={STROKE_PX}
      />
      {fraction > 0 ? (
        <circle
          cx={center}
          cy={center}
          r={RADIUS}
          stroke={AVATAR_ACCENT}
          strokeWidth={STROKE_PX}
          strokeLinecap="round"
          // Dash the full circumference and offset by the unfilled remainder,
          // so the visible run is exactly `fraction` of the ring. Rotated so it
          // starts at twelve o'clock rather than three.
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dashoffset 300ms ease-out" }}
        />
      ) : null}
    </svg>
  );
}
