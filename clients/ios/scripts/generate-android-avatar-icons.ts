#!/usr/bin/env bun
/**
 * Generates the Android alternate launcher icon resources: one icon per eye
 * style and color, drawn as vector XML rather than rasterized PNGs.
 *
 * Run from anywhere in the repo:
 *
 *   bun clients/ios/scripts/generate-android-avatar-icons.ts
 *   bun clients/ios/scripts/generate-android-avatar-icons.ts --pilot
 *
 * Measuring where an eye pair's artwork actually reaches needs the native
 * `@resvg/resvg-js` binding, so the assistant package's dependencies have to be
 * installed first: `bun install --filter=@vellumai/assistant`.
 *
 * Every run deletes and rewrites the whole owned set, and the output is
 * deterministic, so regenerating unchanged resources produces byte-identical
 * files. `clients/ios/scripts/__tests__/android-avatar-icons.test.ts` holds a
 * drift guard that fails when the committed set stops matching a fresh run.
 *
 * Four resources make up one icon:
 *
 * - `drawable/avatar_eyes_fg_<eye>.xml`, the eye pair on a transparent field,
 *   sized for the 72dp an adaptive-icon mask keeps visible.
 * - `drawable/avatar_eyes_mono_<eye>.xml`, the same pair reduced to its sclera
 *   silhouette for themed icons, which consume only alpha.
 * - `mipmap-anydpi-v26/` and `mipmap-anydpi-v33/avatar_eyes_<eye>_<color>.xml`,
 *   adaptive icons pairing that foreground with a background color, the v33
 *   copy adding the monochrome layer.
 * - `mipmap-anydpi/avatar_eyes_<eye>_<color>.xml`, a pre-adaptive fallback that
 *   paints its own background and draws the pair 1.5x larger to fill all 108dp.
 *
 * The background colors are their own `values/avatar_icon_colors.xml` rather
 * than the flavor-owned `launcher_background`: an alternate icon looks the same
 * in every flavor, and only the default launcher icon changes with the build.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  getCharacterComponents,
  SCLERA,
} from "../../../packages/avatar-catalog/src/index.js";
import {
  androidResourceNameForTraits,
  eyeArtworkBounds,
  eyeSpanFraction,
  traitCombinations,
  type AvatarIconTraits,
  type EyeStyle,
  type IconSetScope,
} from "./avatar-icon-core.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Committed output location, regenerated wholesale on every run. */
export const ANDROID_RES_DIR = join(
  REPO_ROOT,
  "clients",
  "android",
  "app",
  "src",
  "main",
  "res",
);

const GENERATOR_SCRIPT = "clients/ios/scripts/generate-android-avatar-icons.ts";

/** Side of the square canvas every launcher vector is drawn on, in dp. */
const CANVAS_DP = 108;

/** Side of the canvas an adaptive-icon mask keeps visible, in dp. */
const MASKED_DP = 72;

/**
 * Decimal places the adaptive scale is rounded to. The legacy scale is exactly
 * 1.5x that rounded value, which can land on one further decimal.
 */
const SCALE_DECIMALS = 4;
const LEGACY_SCALE_DECIMALS = SCALE_DECIMALS + 1;

/** Fill every themed-icon mask path carries; only its alpha is ever read. */
const MONOCHROME_FILL = "#FFFFFF";

/** Resource directories holding files this generator owns. */
const OWNED_RESOURCE_DIRS = [
  "drawable",
  "mipmap-anydpi",
  "mipmap-anydpi-v26",
  "mipmap-anydpi-v33",
];

/**
 * Prefix marking a resource as generated. It deliberately excludes the
 * `ic_launcher*` default launcher icons, which are hand-maintained.
 */
const OWNED_FILE_PREFIX = "avatar_eyes_";

const COLORS_RESOURCE_PATH = "values/avatar_icon_colors.xml";

export interface GenerateAndroidAvatarIconsOptions {
  resDir: string;
  scope: IconSetScope;
}

/**
 * Paths, relative to a `res` directory, of every file this generator owns and
 * would rewrite. Shared with the drift guard so both sides agree on which files
 * are generated.
 */
export function ownedResourcePaths(resDir: string): string[] {
  const paths: string[] = [];
  for (const dir of OWNED_RESOURCE_DIRS) {
    const absoluteDir = join(resDir, dir);
    if (!existsSync(absoluteDir)) {
      continue;
    }
    for (const entry of readdirSync(absoluteDir)) {
      if (entry.startsWith(OWNED_FILE_PREFIX)) {
        paths.push(`${dir}/${entry}`);
      }
    }
  }
  if (existsSync(join(resDir, COLORS_RESOURCE_PATH))) {
    paths.push(COLORS_RESOURCE_PATH);
  }
  return paths.sort();
}

/**
 * Writes every owned resource, returning their paths relative to `resDir` in
 * sorted order.
 */
export function generateAndroidAvatarIcons(
  options: GenerateAndroidAvatarIconsOptions,
): string[] {
  const combinations = traitCombinations(options.scope);
  const colorHexById = colorHexIndex();

  for (const relativePath of ownedResourcePaths(options.resDir)) {
    rmSync(join(options.resDir, relativePath));
  }

  const written: string[] = [];
  const write = (relativePath: string, contents: string): void => {
    const absolutePath = join(options.resDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
    written.push(relativePath);
  };

  for (const eyeStyleId of uniqueEyeStyleIds(combinations)) {
    const eyeStyle = requireEyeStyle(eyeStyleId);
    write(
      `drawable/${OWNED_FILE_PREFIX}fg_${eyeStyleId}.xml`,
      buildForegroundXml(eyeStyle),
    );
    write(
      `drawable/${OWNED_FILE_PREFIX}mono_${eyeStyleId}.xml`,
      buildMonochromeXml(eyeStyle),
    );
  }

  write(COLORS_RESOURCE_PATH, buildColorsXml());

  for (const traits of combinations) {
    const name = androidResourceNameForTraits(traits);
    write(
      `mipmap-anydpi-v26/${name}.xml`,
      buildAdaptiveIconXml(traits, { monochrome: false }),
    );
    write(
      `mipmap-anydpi-v33/${name}.xml`,
      buildAdaptiveIconXml(traits, { monochrome: true }),
    );
    write(
      `mipmap-anydpi/${name}.xml`,
      buildLegacyIconXml(
        requireEyeStyle(traits.eyeStyle),
        requireColorHex(colorHexById, traits.color),
      ),
    );
  }

  return written.sort();
}

function uniqueEyeStyleIds(combinations: AvatarIconTraits[]): string[] {
  return [...new Set(combinations.map((traits) => traits.eyeStyle))];
}

function colorHexIndex(): Map<string, string> {
  return new Map(
    getCharacterComponents().colors.map((color) => [color.id, color.hex]),
  );
}

function requireColorHex(index: Map<string, string>, colorId: string): string {
  const hex = index.get(colorId);
  if (!hex) {
    throw new Error(`Unknown color id: "${colorId}"`);
  }
  return hex;
}

function requireEyeStyle(eyeStyleId: string): EyeStyle {
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

/**
 * Scale that draws one style's pair at its share of the 72dp an adaptive mask
 * keeps visible (see `eyeSpanFraction`). Fitting the longer edge of the
 * measured bounds is what caps a pair taller than it is wide at the same
 * fraction, so an unusually tall pair cannot outgrow a wide one.
 */
function adaptiveScale(eyeStyle: EyeStyle): number {
  const bounds = eyeArtworkBounds(eyeStyle);
  const longestTightDim = Math.max(bounds.width, bounds.height);
  return round(
    (eyeSpanFraction(eyeStyle.id) * MASKED_DP) / longestTightDim,
    SCALE_DECIMALS,
  );
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * The `<group>` that places an eye pair on the canvas. A VectorDrawable group
 * scales about its pivot and then maps that pivot to pivot + translate, so
 * pivoting on the library eye center and translating by the remainder puts the
 * eye center on the canvas center whatever the source viewBox looks like.
 */
function groupOpenTag(eyeStyle: EyeStyle, scale: number): string[] {
  const center = eyeStyle.eyeCenter;
  return [
    "    <group",
    `        android:pivotX="${center.x}"`,
    `        android:pivotY="${center.y}"`,
    `        android:scaleX="${scale}"`,
    `        android:scaleY="${scale}"`,
    `        android:translateX="${CANVAS_DP / 2 - center.x}"`,
    `        android:translateY="${CANVAS_DP / 2 - center.y}">`,
  ];
}

function pathTag(
  fillColor: string,
  pathData: string,
  indent: string,
): string[] {
  return [
    `${indent}<path`,
    `${indent}    android:fillColor="${fillColor}"`,
    `${indent}    android:pathData="${pathData}" />`,
  ];
}

/** Header every generated resource opens its root element with. */
const GENERATED_COMMENT = [
  "    <!--",
  `        Generated by ${GENERATOR_SCRIPT}.`,
  "        Do not edit by hand.",
  "    -->",
];

function vectorOpenTag(): string[] {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    `    android:width="${CANVAS_DP}dp"`,
    `    android:height="${CANVAS_DP}dp"`,
    `    android:viewportWidth="${CANVAS_DP}"`,
    `    android:viewportHeight="${CANVAS_DP}">`,
  ];
}

function xmlDocument(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function eyeGroup(
  eyeStyle: EyeStyle,
  scale: number,
  paths: Array<{ svgPath: string; color: string }>,
): string[] {
  return [
    ...groupOpenTag(eyeStyle, scale),
    ...paths.flatMap((path) => pathTag(path.color, path.svgPath, "        ")),
    "    </group>",
  ];
}

function buildForegroundXml(eyeStyle: EyeStyle): string {
  return xmlDocument([
    ...vectorOpenTag(),
    ...GENERATED_COMMENT,
    ...eyeGroup(eyeStyle, adaptiveScale(eyeStyle), eyeStyle.paths),
    "</vector>",
  ]);
}

/**
 * The themed-icon mask: the pair's sclera paths alone.
 *
 * Monochrome rendering only consumes alpha, and punching the pupils out with
 * even-odd fill leaves crescent slivers because a pupil nearly fills and
 * overhangs its sclera, so the mask is deliberately the silhouette. A style
 * whose sclera is drawn as a fill plus an outline contributes both, and their
 * union is that same silhouette.
 */
function buildMonochromeXml(eyeStyle: EyeStyle): string {
  const sclera = eyeStyle.paths.filter((path) => path.color === SCLERA);
  if (sclera.length === 0) {
    throw new Error(
      `Eye style "${eyeStyle.id}" has no sclera paths to build a themed-icon mask from.`,
    );
  }
  return xmlDocument([
    ...vectorOpenTag(),
    ...GENERATED_COMMENT,
    ...eyeGroup(
      eyeStyle,
      adaptiveScale(eyeStyle),
      sclera.map((path) => ({ svgPath: path.svgPath, color: MONOCHROME_FILL })),
    ),
    "</vector>",
  ]);
}

/**
 * The pre-adaptive fallback, for launchers below API 26. Nothing masks it, so
 * it paints its own square background and draws the pair at the full 108dp
 * canvas rather than the 72dp an adaptive mask reveals.
 */
function buildLegacyIconXml(eyeStyle: EyeStyle, hex: string): string {
  const scale = round(
    adaptiveScale(eyeStyle) * (CANVAS_DP / MASKED_DP),
    LEGACY_SCALE_DECIMALS,
  );
  return xmlDocument([
    ...vectorOpenTag(),
    ...GENERATED_COMMENT,
    ...pathTag(hex, `M0,0h${CANVAS_DP}v${CANVAS_DP}h-${CANVAS_DP}z`, "    "),
    ...eyeGroup(eyeStyle, scale, eyeStyle.paths),
    "</vector>",
  ]);
}

function buildAdaptiveIconXml(
  traits: AvatarIconTraits,
  options: { monochrome: boolean },
): string {
  const layers = [
    `    <background android:drawable="@color/avatar_icon_bg_${traits.color}" />`,
    `    <foreground android:drawable="@drawable/${OWNED_FILE_PREFIX}fg_${traits.eyeStyle}" />`,
  ];
  if (options.monochrome) {
    layers.push(
      `    <monochrome android:drawable="@drawable/${OWNED_FILE_PREFIX}mono_${traits.eyeStyle}" />`,
    );
  }
  return xmlDocument([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
    ...GENERATED_COMMENT,
    ...layers,
    "</adaptive-icon>",
  ]);
}

function buildColorsXml(): string {
  return xmlDocument([
    '<?xml version="1.0" encoding="utf-8"?>',
    "<resources>",
    ...GENERATED_COMMENT,
    ...getCharacterComponents().colors.map(
      (color) =>
        `    <color name="avatar_icon_bg_${color.id}">${color.hex}</color>`,
    ),
    "</resources>",
  ]);
}

function main(argv: string[]): void {
  // Full is the committed state, so a bare run reproduces what is checked in.
  const scope: IconSetScope = argv.includes("--pilot") ? "pilot" : "full";
  const written = generateAndroidAvatarIcons({
    resDir: ANDROID_RES_DIR,
    scope,
  });
  console.log(
    `Generated ${written.length} ${scope} Android icon resources in ${ANDROID_RES_DIR}`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
