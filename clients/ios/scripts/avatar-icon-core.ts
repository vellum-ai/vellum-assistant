/**
 * Naming, framing, and eye-artwork measurement behind the avatar app icons.
 *
 * Every platform generator draws the same artwork at the same size, so the
 * pieces that decide *which* icons exist and *how big* the eyes are drawn live
 * here rather than in any one platform's script. Rasterizing needs the native
 * `@resvg/resvg-js` binding, so the assistant package's dependencies have to be
 * installed first: `bun install --filter=@vellumai/assistant`.
 */

import { getCharacterComponents } from "../../../packages/avatar-catalog/src/index.js";
import { getResvg } from "../../../assistant/src/avatar/resvg-lazy.js";

/**
 * Fraction of the icon an eye pair's tight bounds span, for every style the
 * table below does not name.
 *
 * `clients/web/src/components/avatar/app-icon-preview.tsx` mirrors both this
 * number and the table, so its on-screen preview frames a pair the way the
 * shipped PNG does. Each side pins the numbers in its own tests, since a web
 * bundle cannot import a build script that rasterizes SVG. A span moves here
 * only alongside that file, and the catalog is regenerated with it.
 */
const DEFAULT_EYE_SPAN_FRACTION = 0.5;

/** Eye styles framed wider or narrower than {@link DEFAULT_EYE_SPAN_FRACTION}. */
const EYE_SPAN_FRACTION_OVERRIDES: Record<string, number> = {
  dazed: 0.55,
  bashful: 0.4,
};

/**
 * Canvas the eye bounds below are measured on, in px. The scan reports whole
 * probe pixels, so each edge carries up to one of them as slack; this size
 * keeps that under a thousandth of the artwork.
 */
const EYE_BOUNDS_PROBE_PX = 2048;

/**
 * `--pilot` narrows a local run to a 12-set slice, which rasterizes in a couple
 * of seconds. `grumpy` is the widest, flattest eye pair in the library and
 * `gentle` the closest to square, so between them they cover both ends of what
 * the placement has to fit.
 */
const PILOT_EYE_STYLES = ["grumpy", "gentle"];

/** Every color in the palette is a 6-digit sRGB hex, and goes straight to markup. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type IconSetScope = "pilot" | "full";

export interface AvatarIconTraits {
  eyeStyle: string;
  color: string;
}

export type EyeStyle = ReturnType<
  typeof getCharacterComponents
>["eyeStyles"][number];

/** Tight bounds of an eye style's artwork, in its own source viewBox units. */
export interface EyeBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * Icon set name for an eye style and color. The web layer derives the same name
 * when it asks iOS to switch icons, so this format is a wire contract: changing
 * it breaks every already-installed app until both sides ship together. Body
 * shape is deliberately absent, since the icons draw eyes on a color field and
 * no body.
 *
 * The name is also a cache key: iOS caches an alternate icon's artwork under
 * it, so each name permanently identifies one artwork version. Changed art
 * goes out under a new versioned name, never behind an existing one.
 */
export function iconNameForTraits(traits: AvatarIconTraits): string {
  return `avatar-eyes-${traits.eyeStyle}-${traits.color}`;
}

/**
 * Android resource name for the same pair. Resource names admit underscores
 * rather than dashes, so this is {@link iconNameForTraits} with every separator
 * swapped, and {@link assertUnderscoreSafeIds} keeps that swap reversible.
 */
export function androidResourceNameForTraits(traits: AvatarIconTraits): string {
  return iconNameForTraits(traits).replace(/-/g, "_");
}

/**
 * Rejects any library id carrying an underscore.
 *
 * Translating between the wire name and the Android resource name swaps every
 * dash for an underscore across the whole string, which only round-trips while
 * no id contains a separator of its own.
 */
export function assertUnderscoreSafeIds(): void {
  const components = getCharacterComponents();
  const ids = [
    ...components.eyeStyles.map((eye) => eye.id),
    ...components.colors.map((color) => color.id),
  ];
  for (const id of ids) {
    if (id.includes("_")) {
      throw new Error(
        `Avatar component id "${id}" contains an underscore, which would not ` +
          `survive the dash to underscore translation into an Android resource name.`,
      );
    }
  }
}

/** Trait pairs in scope, in a stable eye, color order. */
export function traitCombinations(scope: IconSetScope): AvatarIconTraits[] {
  assertUnderscoreSafeIds();

  const components = getCharacterComponents();
  const allEyeStyles = components.eyeStyles.map((eye) => eye.id);

  const eyeStyles =
    scope === "full"
      ? allEyeStyles
      : assertKnownIds(PILOT_EYE_STYLES, allEyeStyles, "eye style");

  const combinations: AvatarIconTraits[] = [];
  for (const eyeStyle of eyeStyles) {
    for (const color of components.colors) {
      combinations.push({ eyeStyle, color: color.id });
    }
  }
  return combinations;
}

function assertKnownIds(
  requested: string[],
  known: string[],
  label: string,
): string[] {
  for (const id of requested) {
    if (!known.includes(id)) {
      throw new Error(
        `Unknown ${label}: "${id}". Valid IDs: ${known.join(", ")}`,
      );
    }
  }
  return requested;
}

/** The eye style an id names, or a throw listing the ids the library defines. */
export function requireEyeStyle(eyeStyleId: string): EyeStyle {
  const components = getCharacterComponents();
  const eyeStyle = components.eyeStyles.find((eye) => eye.id === eyeStyleId);
  if (!eyeStyle) {
    throw new Error(
      `Unknown eye style: "${eyeStyleId}". Valid IDs: ${components.eyeStyles
        .map((eye) => eye.id)
        .join(", ")}`,
    );
  }
  return eyeStyle;
}

/** Color id to hex, for the field every platform draws its icons on. */
export function colorHexIndex(): Map<string, string> {
  return new Map(
    getCharacterComponents().colors.map((color) => [color.id, color.hex]),
  );
}

/**
 * The hex a color id names. Every platform interpolates it straight into markup
 * it emits, so anything that is not a 6-digit hex is rejected here rather than
 * written into an icon.
 */
export function requireColorHex(
  index: Map<string, string>,
  colorId: string,
): string {
  const hex = index.get(colorId);
  if (!hex) {
    throw new Error(`Unknown color id: "${colorId}"`);
  }
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(
      `Expected a 6-digit hex color for "${colorId}", got "${hex}"`,
    );
  }
  return hex;
}

/** An eye style's paths, verbatim, under one shared affine transform. */
export function eyePathsSvg(eyeStyle: EyeStyle, transform: string): string {
  return eyeStyle.paths
    .map(
      (path) =>
        `<path d="${path.svgPath}" fill="${path.color}" transform="${transform}"/>`,
    )
    .join("");
}

export function renderSvg(body: string, width: number, height: number) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  const Resvg = getResvg();
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
}

const eyeBoundsCache = new Map<string, EyeBounds>();

/**
 * Tight bounds of an eye style's artwork, measured by rasterizing it on its own
 * and scanning for covered pixels. Measuring through the same rasterizer that
 * writes the icons puts the bounds where the artwork is drawn rather than where
 * its path data nominally reaches, and the result is a pure function of the
 * path data, so the placement it feeds stays byte-reproducible.
 */
export function eyeArtworkBounds(eyeStyle: EyeStyle): EyeBounds {
  const cached = eyeBoundsCache.get(eyeStyle.id);
  if (cached) {
    return cached;
  }

  const viewBox = eyeStyle.sourceViewBox;
  const probeScale =
    EYE_BOUNDS_PROBE_PX / Math.max(viewBox.width, viewBox.height);
  const rendered = renderSvg(
    eyePathsSvg(eyeStyle, `matrix(${probeScale},0,0,${probeScale},0,0)`),
    Math.round(viewBox.width * probeScale),
    Math.round(viewBox.height * probeScale),
  );

  // `pixels` materializes a fresh buffer per read, so it is read exactly once.
  const pixels = rendered.pixels;
  const width = rendered.width;
  const height = rendered.height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) {
        continue;
      }
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    throw new Error(`Eye style "${eyeStyle.id}" rasterized to nothing.`);
  }

  const bounds: EyeBounds = {
    minX: minX / probeScale,
    minY: minY / probeScale,
    width: (maxX + 1 - minX) / probeScale,
    height: (maxY + 1 - minY) / probeScale,
  };
  eyeBoundsCache.set(eyeStyle.id, bounds);
  return bounds;
}

/** Fraction of the icon one style's pair spans. */
export function eyeSpanFraction(eyeStyleId: string): number {
  return EYE_SPAN_FRACTION_OVERRIDES[eyeStyleId] ?? DEFAULT_EYE_SPAN_FRACTION;
}
