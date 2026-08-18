import type { CSSProperties } from "react";

/**
 * A plus drawn as one path rather than lucide's two.
 *
 * On device the composer's plus shows a one-pixel column of background where
 * the horizontal bar meets the vertical stroke, measured off a screenshot at
 * native scale: the bar reads full value either side and exactly the surface
 * colour at that column, and the values there are the vertical stroke's own
 * edge, so the second stroke writes over the bar instead of blending with it.
 *
 * Two subpaths in one `<path>` are a single shape to the rasterizer, which
 * removes the boundary between two strokes that artifact needs. Geometry and
 * stroke attributes are otherwise lucide's, so this sits beside lucide glyphs
 * at the same weight.
 *
 * What triggers it is not established. Neither Chromium nor desktop WebKit
 * reproduces it across scales, sub-pixel offsets, the button's own chrome, or
 * ten compositing contexts, and both path forms render identically in every
 * one of them. So this is the remedy the measurement points at rather than a
 * confirmed fix, and only a device can tell whether it lands.
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
