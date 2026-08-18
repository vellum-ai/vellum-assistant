import type { CSSProperties } from "react";

/**
 * A plus drawn as one path, so its two strokes cannot part where they cross.
 *
 * Lucide's `Plus` is two separate `<path>` elements. WebKit rasterizes and
 * composites each on its own, and on device it leaves a one-pixel column of
 * background between the horizontal bar and the vertical stroke: a hard hole
 * rather than a soft edge, on one side of the crossing only. The asymmetry is
 * what marks it as a rounding artifact between two shapes rather than
 * antialiasing, and the composer's fractional scale (20px from a 24px viewBox)
 * is what puts the boundary mid-pixel for it to fall into.
 *
 * Two subpaths in one `<path>` are one shape to the rasterizer, so there is no
 * boundary for a gap to open along. Geometry and stroke attributes are
 * otherwise lucide's, so this sits beside lucide glyphs at the same weight.
 *
 * Chromium renders both forms identically, so this is not reproducible outside
 * a WebKit engine. Any lucide icon whose strokes cross is exposed to the same
 * artifact; `X` is the other one this codebase leans on.
 */

interface PlusIconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}

export function PlusIcon({
  size = 24,
  className,
  style,
  strokeWidth = 2,
}: PlusIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}
