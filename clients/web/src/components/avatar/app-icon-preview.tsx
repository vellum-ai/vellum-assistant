/**
 * On-screen preview of a bundled iOS alternate app icon.
 *
 * Draws what `clients/ios/scripts/generate-avatar-icons.ts` bakes into each
 * `avatar-eyes-<eyeStyle>-<color>.appiconset`: a solid field in the trait
 * color with the eye style's paths centered on it, the pair spanning half the
 * icon. The generator measures its artwork by rasterizing it, which the web
 * has no way to do, so the framing here comes from `tightPathBBox`, whose
 * curve-solved box is the same box a rasterizer would find. Framing against
 * the control-point box the voice room uses (`pathBBox`) would place the
 * `angry` eyes about 6% of the icon above where the shipped PNG has them.
 *
 * Purely presentational: no store, hook, or native bridge. An eye style or
 * color the components catalog does not carry renders as the field alone
 * rather than throwing, so a preview seeded from a stale or skewed icon name
 * still shows something.
 */

import { useMemo } from "react";

import { tightPathBBox, unionBBox } from "@/utils/eye-bbox";
import type { CharacterComponents, EyePathDefinition } from "@/types/avatar";

/**
 * Fraction of the icon the eye pair spans, which states the invariant this
 * preview shares with the artwork it stands in for: the eye group spans half
 * the icon width, centered. The iOS icon generator holds the shipped PNGs to
 * that same invariant, and each side pins it in its own tests, since a web
 * bundle cannot import a build script that rasterizes SVG. Move this only when
 * the generator's `EYE_CANVAS_FRACTION` moves.
 */
const EYE_CANVAS_FRACTION = 0.5;

/**
 * Corner radius as a fraction of the icon's width. Close enough to the iOS
 * squircle that the preview reads as an app icon rather than a color swatch.
 */
const CORNER_RADIUS_FRACTION = 0.224;

/** Field painted when the color id is not in the catalog. */
const UNKNOWN_FIELD_FILL = "var(--surface-sunken)";

/** Default preview size, matching the avatar builder's inline thumbnails. */
const DEFAULT_SIZE = 64;

export interface AppIconPreviewProps {
  /** Trait catalog the ids resolve against. Null while it is still loading. */
  components: CharacterComponents | null;
  eyeStyle: string;
  color: string;
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

interface IconEyeArt {
  paths: EyePathDefinition[];
  /** Affine transform placing the artwork on the icon's field. */
  transform: string;
}

/**
 * Scale and center an eye style's artwork on a `size` square field.
 *
 * The pair is fitted to {@link EYE_CANVAS_FRACTION} of the field by its wider
 * axis, so taking the smaller of the two ratios caps a pair taller than it is
 * wide at that same fraction of the height and an unusually tall pair cannot
 * outgrow a wide one. Returns null for art that is missing or degenerate,
 * which is what makes an unknown id render the field alone.
 */
function resolveEyeArt(
  components: CharacterComponents | null,
  eyeStyleId: string,
  size: number,
): IconEyeArt | null {
  const eyeStyle = components?.eyeStyles.find((eye) => eye.id === eyeStyleId);
  if (!eyeStyle || eyeStyle.paths.length === 0) {
    return null;
  }
  const bbox = unionBBox(
    eyeStyle.paths.map((path) => tightPathBBox(path.svgPath)),
  );
  if (bbox.w <= 0 || bbox.h <= 0) {
    return null;
  }
  const span = size * EYE_CANVAS_FRACTION;
  const scale = Math.min(span / bbox.w, span / bbox.h);
  const translateX = size / 2 - (bbox.x + bbox.w / 2) * scale;
  const translateY = size / 2 - (bbox.y + bbox.h / 2) * scale;
  return {
    paths: eyeStyle.paths,
    transform: `matrix(${scale},0,0,${scale},${translateX},${translateY})`,
  };
}

export function AppIconPreview({
  components,
  eyeStyle,
  color,
  size = DEFAULT_SIZE,
  className,
}: AppIconPreviewProps) {
  const art = useMemo(
    () => resolveEyeArt(components, eyeStyle, size),
    [components, eyeStyle, size],
  );
  const fieldHex = components?.colors.find((entry) => entry.id === color)?.hex;
  const radius = size * CORNER_RADIUS_FRACTION;

  return (
    <svg
      aria-hidden="true"
      data-testid="app-icon-preview"
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: "block", flexShrink: 0 }}
    >
      <rect
        data-testid="app-icon-preview-field"
        width={size}
        height={size}
        rx={radius}
        ry={radius}
        fill={fieldHex ?? UNKNOWN_FIELD_FILL}
      />
      {art ? (
        <g data-testid="app-icon-preview-eyes" transform={art.transform}>
          {art.paths.map((path, index) => (
            <path key={index} d={path.svgPath} fill={path.color} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
