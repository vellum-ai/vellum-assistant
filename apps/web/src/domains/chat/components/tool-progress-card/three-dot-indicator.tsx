
/**
 * Three-dot pulsing "thinking" indicator. Used in the web-search progress
 * card header and as the assistant avatar's progress badge.
 *
 * Renders three evenly-sized dots that pulse in opacity (1 → 0.3) and scale
 * (1 → 0.85) over 1s, staggered by 150ms each to produce a left-to-right
 * wave. The dots carry the shared `busy-indicator` class so they use the
 * same `busy-pulse` keyframe and `--primary-base` colour as the single-dot
 * `BusyIndicator`, and — crucially — inherit its `prefers-reduced-motion`
 * override (which targets the class, not the keyframe name). Per-dot
 * `animationDelay` supplies the stagger; an inline longhand, so it survives
 * the class's `animation` shorthand resetting delay to 0.
 *
 * `dotSize` and `gap` scale the indicator for tighter contexts (e.g. the
 * avatar badge), defaulting to the 8px / 3px transcript sizing.
 */

const DOT_COUNT = 3;
const DEFAULT_DOT_SIZE = 8;
const DEFAULT_GAP = 3;
const STAGGER_MS = 150;

export function ThreeDotIndicator({
  className,
  dotSize = DEFAULT_DOT_SIZE,
  gap = DEFAULT_GAP,
  "data-testid": dataTestId,
}: {
  className?: string;
  dotSize?: number;
  gap?: number;
  "data-testid"?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={dataTestId}
      className={`inline-flex items-center${className ? ` ${className}` : ""}`}
      style={{ gap }}
    >
      {Array.from({ length: DOT_COUNT }, (_, i) => (
        <span
          key={i}
          className="busy-indicator shrink-0 rounded-full bg-[var(--primary-base)]"
          style={{
            width: dotSize,
            height: dotSize,
            animationDelay: `${i * STAGGER_MS}ms`,
          }}
        />
      ))}
    </span>
  );
}
