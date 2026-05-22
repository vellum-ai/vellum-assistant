
/**
 * Three-dot pulsing indicator used in the web-search progress card header.
 *
 * Renders three evenly-sized 8px dots that pulse in opacity (1 → 0.3) and
 * scale (1 → 0.85) over 1s, staggered by 150ms each to produce a
 * left-to-right wave. This mirrors the legacy `BusyIndicator` primitive's
 * `busy-pulse` keyframe and `--primary-base` colour so the new card reads
 * consistently when shown alongside `ToolCallProgressCard` (which renders a
 * single `BusyIndicator` of the same diameter for its running state).
 *
 * Reduced-motion handling is inherited from the shared `busy-pulse`
 * keyframe override in the app theme CSS.
 */

const DOT_COUNT = 3;
const DOT_SIZE = 8;
const STAGGER_MS = 150;

export function ThreeDotIndicator({
  className,
  "data-testid": dataTestId,
}: {
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={dataTestId}
      className={`inline-flex items-center gap-[3px]${className ? ` ${className}` : ""}`}
    >
      {Array.from({ length: DOT_COUNT }, (_, i) => (
        <span
          key={i}
          className="shrink-0 rounded-full bg-[var(--primary-base)]"
          style={{
            width: DOT_SIZE,
            height: DOT_SIZE,
            animation: "busy-pulse 1s ease-in-out infinite",
            animationDelay: `${i * STAGGER_MS}ms`,
          }}
        />
      ))}
    </span>
  );
}
