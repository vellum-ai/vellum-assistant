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
 *
 * A fifth piece lives outside `res`: the generator also owns the
 * `avatar-icon-aliases` marker block in `AndroidManifest.xml`, which declares
 * one disabled `<activity-alias>` per icon. Android picks the launcher icon off
 * the enabled launcher component, so switching icons means enabling one alias
 * and disabling the rest. Each alias is a clone of `.MainActivity`'s launcher,
 * deep-link, and shortcuts surface, read out of the manifest rather than spelled
 * out here, so a new deep link reaches every alias on the next run. Cloning is
 * what keeps those links and the static shortcuts working while an alias, not
 * `.MainActivity`, is the enabled component.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

const ANDROID_MAIN_SRC_DIR = join(
  REPO_ROOT,
  "clients",
  "android",
  "app",
  "src",
  "main",
);

/** Committed output location, regenerated wholesale on every run. */
export const ANDROID_RES_DIR = join(ANDROID_MAIN_SRC_DIR, "res");

/** Manifest holding the generator-owned `<activity-alias>` block. */
export const ANDROID_MANIFEST_PATH = join(
  ANDROID_MAIN_SRC_DIR,
  "AndroidManifest.xml",
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

/** Comments fencing the manifest region this generator rewrites. */
const ALIAS_BLOCK_BEGIN = "<!-- avatar-icon-aliases:begin -->";
const ALIAS_BLOCK_END = "<!-- avatar-icon-aliases:end -->";

/**
 * Manifest-relative name of the activity the aliases point at, and the
 * sub-package their own names sit under. The names resolve against the manifest
 * package, so an alias is `<applicationId>/ai.vellum.assistant.icon.<resource>`
 * at runtime, which is what the plugin toggling them has to address.
 */
const MAIN_ACTIVITY_NAME = ".MainActivity";
const ALIAS_NAME_PREFIX = ".icon.";

/** Child elements of `.MainActivity` every alias has to reproduce. */
const LAUNCHER_ACTION = '<action android:name="android.intent.action.MAIN" />';
const LAUNCHER_CATEGORY =
  '<category android:name="android.intent.category.LAUNCHER" />';
const SHORTCUTS_META_DATA_NAME = 'android:name="android.app.shortcuts"';

export interface GenerateAndroidAvatarIconsOptions {
  resDir: string;
  manifestPath: string;
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
 * Writes every owned resource and rewrites the manifest's alias block,
 * returning the resource paths relative to `resDir` in sorted order.
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

  writeFileSync(
    options.manifestPath,
    renderManifestWithIconAliases(
      readFileSync(options.manifestPath, "utf8"),
      options.scope,
    ),
  );

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

interface ManifestElement {
  /** The element's full text, opening tag through closing tag. */
  text: string;
  /** Whitespace the element's opening tag is indented by. */
  indent: string;
  /** Offset just past the closing tag, where the alias block goes. */
  end: number;
}

/**
 * The `.MainActivity` element. `<activity(?:\s[^>]*)?>` cannot match
 * `<activity-alias`, and `</activity>` cannot match `</activity-alias>`, so the
 * aliases sitting next to it are never mistaken for it.
 */
function findMainActivity(manifest: string): ManifestElement {
  const pattern = /^([ \t]*)<activity(?:\s[^>]*)?>[\s\S]*?<\/activity>/gm;
  for (const match of manifest.matchAll(pattern)) {
    if (!match[0].includes(`android:name="${MAIN_ACTIVITY_NAME}"`)) {
      continue;
    }
    return {
      text: match[0],
      indent: match[1] ?? "",
      end: match.index + match[0].length,
    };
  }
  throw new Error(
    `No <activity android:name="${MAIN_ACTIVITY_NAME}"> element in the manifest.`,
  );
}

/**
 * `.MainActivity`'s intent filters and meta-data, verbatim and in document
 * order. Reading them out of the manifest is what makes a new deep link reach
 * every alias on the next run instead of silently applying to the default
 * launcher component alone.
 */
function mainActivityClonedChildren(mainActivity: ManifestElement): string[] {
  const pattern =
    /^[ \t]*(?:<intent-filter(?:\s[^>]*)?>[\s\S]*?<\/intent-filter>|<meta-data\s[^>]*\/>)/gm;
  const children = mainActivity.text.match(pattern) ?? [];

  const hasLauncherFilter = children.some(
    (child) =>
      child.includes(LAUNCHER_ACTION) && child.includes(LAUNCHER_CATEGORY),
  );
  if (!hasLauncherFilter) {
    throw new Error(
      `${MAIN_ACTIVITY_NAME} has no MAIN/LAUNCHER intent filter to clone.`,
    );
  }
  if (!children.some((child) => child.includes(SHORTCUTS_META_DATA_NAME))) {
    throw new Error(
      `${MAIN_ACTIVITY_NAME} has no ${SHORTCUTS_META_DATA_NAME} meta-data to clone.`,
    );
  }
  return children;
}

/**
 * One alias per icon, disabled so that `.MainActivity` stays the sole enabled
 * launcher component until the picker enables one. Exactly one launcher-bearing
 * component is enabled at a time, so a fresh install and an update both behave
 * the way they do without the block, and an existing home screen pin survives.
 */
function buildActivityAlias(
  traits: AvatarIconTraits,
  children: string[],
  indent: string,
): string[] {
  const name = androidResourceNameForTraits(traits);
  return [
    `${indent}<activity-alias`,
    `${indent}    android:name="${ALIAS_NAME_PREFIX}${name}"`,
    `${indent}    android:targetActivity="${MAIN_ACTIVITY_NAME}"`,
    `${indent}    android:enabled="false"`,
    `${indent}    android:exported="true"`,
    `${indent}    android:icon="@mipmap/${name}"`,
    `${indent}    android:roundIcon="@mipmap/${name}"`,
    `${indent}    android:label="@string/app_name">`,
    "",
    ...children.flatMap((child) => [child, ""]),
    `${indent}</activity-alias>`,
  ];
}

function buildAliasBlock(
  mainActivity: ManifestElement,
  combinations: AvatarIconTraits[],
): string {
  const indent = mainActivity.indent;
  const children = mainActivityClonedChildren(mainActivity);
  return [
    `${indent}${ALIAS_BLOCK_BEGIN}`,
    `${indent}<!--`,
    `${indent}    Generated by ${GENERATOR_SCRIPT}.`,
    `${indent}    Do not edit by hand.`,
    `${indent}-->`,
    "",
    ...combinations.flatMap((traits) => [
      ...buildActivityAlias(traits, children, indent),
      "",
    ]),
    `${indent}${ALIAS_BLOCK_END}`,
  ].join("\n");
}

function findAliasBlock(
  manifest: string,
): { start: number; end: number } | undefined {
  const beginAt = manifest.indexOf(ALIAS_BLOCK_BEGIN);
  if (beginAt < 0) {
    return undefined;
  }
  const endAt = manifest.indexOf(ALIAS_BLOCK_END, beginAt);
  if (endAt < 0) {
    throw new Error(
      `Manifest has ${ALIAS_BLOCK_BEGIN} without a matching ${ALIAS_BLOCK_END}.`,
    );
  }
  return {
    start: manifest.lastIndexOf("\n", beginAt) + 1,
    end: endAt + ALIAS_BLOCK_END.length,
  };
}

/**
 * The manifest with its alias block rewritten, leaving every other byte,
 * `.MainActivity` included, exactly where it was. The block is created directly
 * after `.MainActivity` the first time and replaced in place after that, so
 * rendering an already-rendered manifest returns it unchanged.
 */
export function renderManifestWithIconAliases(
  manifest: string,
  scope: IconSetScope,
): string {
  const mainActivity = findMainActivity(manifest);
  const block = buildAliasBlock(mainActivity, traitCombinations(scope));
  const existing = findAliasBlock(manifest);
  if (existing) {
    return `${manifest.slice(0, existing.start)}${block}${manifest.slice(existing.end)}`;
  }
  return `${manifest.slice(0, mainActivity.end)}\n\n${block}${manifest.slice(mainActivity.end)}`;
}

function main(argv: string[]): void {
  // Full is the committed state, so a bare run reproduces what is checked in.
  const scope: IconSetScope = argv.includes("--pilot") ? "pilot" : "full";
  const written = generateAndroidAvatarIcons({
    resDir: ANDROID_RES_DIR,
    manifestPath: ANDROID_MANIFEST_PATH,
    scope,
  });
  console.log(
    `Generated ${written.length} ${scope} Android icon resources in ${ANDROID_RES_DIR}`,
  );
  console.log(`Rewrote the alias block in ${ANDROID_MANIFEST_PATH}`);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
