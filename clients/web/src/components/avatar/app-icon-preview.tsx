/**
 * On-screen preview of an iOS app icon.
 *
 * Draws what `clients/ios/scripts/generate-avatar-icons.ts` bakes into each
 * `avatar-eyes-<eyeStyle>-<color>.appiconset`: a solid field in the trait
 * color with the eye style's paths centered on it, the pair sized to the share
 * of the icon that style's art claims on an avatar. The generator measures its
 * artwork by rasterizing it, which the web has no way to do, so the framing
 * here comes from `tightPathBBox`, whose curve-solved box is the same box a
 * rasterizer would find. Framing against the control-point box the voice room
 * uses (`pathBBox`) would place the `angry` eyes about 6% of the icon above
 * where the shipped PNG has them.
 *
 * The app's primary icon (`clients/ios/App/App/AppIcon.icon`) is drawn by hand
 * rather than generated, and it places its pair at the full
 * {@link EYE_CANVAS_FRACTION} span, so a preview standing in for it passes
 * {@link AppIconPreviewProps.primary} to be framed that way.
 *
 * Purely presentational: no store, hook, or native bridge. An eye style or
 * color the components catalog does not carry renders as the field alone
 * rather than throwing, so a preview seeded from a stale or skewed icon name
 * still shows something.
 */

import { useMemo } from "react";

import { tightPathBBox, unionBBox, type BBox } from "@/utils/eye-bbox";
import type {
  CharacterComponents,
  EyePathDefinition,
  EyeStyleDefinition,
} from "@/types/avatar";

/**
 * Fraction of the icon the library's largest eye pair spans, which states the
 * invariant this preview shares with the artwork it stands in for: that pair
 * spans half the icon width, centered, and every other style spans a
 * proportionally smaller share. The iOS icon generator holds the shipped PNGs
 * to that same invariant, and each side pins the resulting per-style scales in
 * its own tests, since a web bundle cannot import a build script that
 * rasterizes SVG. Move this only when the generator's `EYE_CANVAS_FRACTION`
 * moves.
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
  /**
   * Frame the pair the way the app's primary icon frames its own: the whole
   * {@link EYE_CANVAS_FRACTION} span, whatever style is on screen. Alternates
   * leave this off and take their own share of the field.
   */
  primary?: boolean;
  /** Rendered width and height in px. */
  size?: number;
  className?: string;
}

interface IconEyeArt {
  paths: EyePathDefinition[];
  /** Affine transform placing the artwork on the icon's field. */
  transform: string;
}

interface EyeMeasurement {
  /** Tight box of the artwork, in the style's own path units. */
  bbox: BBox;
  /**
   * Size of that box on the style's own source canvas, aspect-fit onto a
   * square. The avatar compositor fits each style's `sourceViewBox` into the
   * body it draws on the same way, so this is the size the pair reads at on an
   * avatar, and comparing two styles by it compares what a user sees.
   */
  extent: number;
}

function measureEyeStyle(eyeStyle: EyeStyleDefinition): EyeMeasurement | null {
  if (eyeStyle.paths.length === 0) {
    return null;
  }
  const bbox = unionBBox(
    eyeStyle.paths.map((path) => tightPathBBox(path.svgPath)),
  );
  const canvas = Math.max(
    eyeStyle.sourceViewBox.width,
    eyeStyle.sourceViewBox.height,
  );
  if (bbox.w <= 0 || bbox.h <= 0 || canvas <= 0) {
    return null;
  }
  return { bbox, extent: Math.max(bbox.w, bbox.h) / canvas };
}

/**
 * Every measurable style in one catalog, keyed by id. Memoized on the catalog
 * object because a picker renders one preview per icon and each one needs the
 * whole catalog measured to know which style is the largest.
 */
const catalogMeasurements = new WeakMap<
  CharacterComponents,
  Map<string, EyeMeasurement>
>();

function measureCatalog(
  components: CharacterComponents,
): Map<string, EyeMeasurement> {
  const cached = catalogMeasurements.get(components);
  if (cached) {
    return cached;
  }
  const measured = new Map<string, EyeMeasurement>();
  for (const eyeStyle of components.eyeStyles) {
    const measurement = measureEyeStyle(eyeStyle);
    if (measurement) {
      measured.set(eyeStyle.id, measurement);
    }
  }
  catalogMeasurements.set(components, measured);
  return measured;
}

/**
 * Scale and center an eye style's artwork on a `size` square field.
 *
 * The pair is fitted by its wider axis to its share of the field, which is
 * {@link EYE_CANVAS_FRACTION} for the largest style in the catalog and less
 * for the rest in proportion to how much smaller they are drawn on an avatar.
 * A `primary` preview takes the whole fraction instead, since the icon it
 * stands in for is framed that way whichever pair it carries. Taking the
 * smaller of the two ratios caps a pair taller than it is wide at that same
 * fraction of the height, so an unusually tall pair cannot outgrow a wide one.
 * Returns null for art that is missing or degenerate, which is what makes an
 * unknown id render the field alone.
 */
function resolveEyeArt(
  components: CharacterComponents | null,
  eyeStyleId: string,
  size: number,
  primary: boolean,
): IconEyeArt | null {
  const eyeStyle = components?.eyeStyles.find((eye) => eye.id === eyeStyleId);
  if (!components || !eyeStyle) {
    return null;
  }
  const measured = measureCatalog(components);
  const measurement = measured.get(eyeStyleId);
  if (!measurement) {
    return null;
  }
  const largestExtent = Math.max(
    ...Array.from(measured.values(), (entry) => entry.extent),
  );
  const { bbox } = measurement;
  const span =
    size *
    EYE_CANVAS_FRACTION *
    (primary ? 1 : measurement.extent / largestExtent);
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
  primary = false,
  size = DEFAULT_SIZE,
  className,
}: AppIconPreviewProps) {
  const art = useMemo(
    () => resolveEyeArt(components, eyeStyle, size, primary),
    [components, eyeStyle, size, primary],
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
