#!/usr/bin/env bun
/**
 * Generates the Icon Composer bundles behind the iOS avatar alternate app
 * icons, plus the xcconfig that lists their names.
 *
 * Run from anywhere in the repo:
 *
 *   bun clients/ios/scripts/generate-avatar-icons.ts
 *   bun clients/ios/scripts/generate-avatar-icons.ts --full
 *   bun clients/ios/scripts/generate-avatar-icons.ts --contact-sheet /tmp/avatar-icons.png
 *
 * Every run deletes and recreates the whole output directory, and the output is
 * deterministic, so regenerating an unchanged catalog produces byte-identical
 * files. `clients/ios/scripts/__tests__/generate-avatar-icons.test.ts` holds a
 * drift guard that fails when the committed set stops matching a fresh run.
 *
 * The bundle layout mirrors `clients/ios/App/App/AppIcon.icon/`: an `icon.json`
 * whose `fill.solid` paints the background and an SVG layer under `Assets/`.
 */

import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { getCharacterComponents } from "../../../assistant/src/avatar/character-components.js";
import { composeSvg } from "../../../assistant/src/avatar/svg-compositor.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Committed output locations, both regenerated wholesale on every run. */
export const AVATAR_ICONS_DIR = join(
  REPO_ROOT,
  "clients",
  "ios",
  "App",
  "App",
  "AvatarIcons",
);
export const AVATAR_ICONS_XCCONFIG_PATH = join(
  REPO_ROOT,
  "clients",
  "ios",
  "App",
  "App",
  "Config",
  "AvatarIcons.xcconfig",
);

const GENERATOR_COMMAND = "bun clients/ios/scripts/generate-avatar-icons.ts";

/** Width and height of the composed character SVG, in px. */
const SVG_SIZE = 512;

/** Icon Composer lays layers out on a 1024-point square canvas. */
const ICON_CANVAS_POINTS = 1024;

/** Fraction of the canvas the character occupies, leaving a tinted margin. */
const CHARACTER_CANVAS_FRACTION = 0.7;

const CHARACTER_SCALE =
  (ICON_CANVAS_POINTS * CHARACTER_CANVAS_FRACTION) / SVG_SIZE;

/** How far the background tint is blended from the trait color toward white. */
const BACKGROUND_WHITE_BLEND = 0.65;

const LAYER_IMAGE_NAME = "avatar.svg";
const LAYER_NAME = "avatar";
const ASSETS_DIR_NAME = "Assets";

/**
 * The pilot set covers both face-placement paths: `blob` uses its body's own
 * face center, `ghost` is remapped through `faceCenterOverrides`.
 */
const PILOT_BODY_SHAPES = ["blob", "ghost"];
const PILOT_EYE_STYLES = ["grumpy", "gentle"];

const CONTACT_SHEET_CELL_PX = 240;

export type IconSetScope = "pilot" | "full";

export interface AvatarIconTraits {
  bodyShape: string;
  eyeStyle: string;
  color: string;
}

export interface GenerateAvatarIconsOptions {
  iconsDir: string;
  xcconfigPath: string;
  scope: IconSetScope;
}

/**
 * Bundle name for a character trait triple. The web layer derives the same name
 * when it asks iOS to switch icons, so this format is a wire contract: changing
 * it breaks every already-installed app until both sides ship together.
 */
export function iconNameForTraits(traits: AvatarIconTraits): string {
  return `avatar-${traits.bodyShape}-${traits.eyeStyle}-${traits.color}`;
}

/** Trait triples in scope, in a stable body, eye, color order. */
export function traitCombinations(scope: IconSetScope): AvatarIconTraits[] {
  const components = getCharacterComponents();
  const allBodyShapes = components.bodyShapes.map((body) => body.id);
  const allEyeStyles = components.eyeStyles.map((eye) => eye.id);

  const bodyShapes =
    scope === "full"
      ? allBodyShapes
      : assertKnownIds(PILOT_BODY_SHAPES, allBodyShapes, "body shape");
  const eyeStyles =
    scope === "full"
      ? allEyeStyles
      : assertKnownIds(PILOT_EYE_STYLES, allEyeStyles, "eye style");

  const combinations: AvatarIconTraits[] = [];
  for (const bodyShape of bodyShapes) {
    for (const eyeStyle of eyeStyles) {
      for (const color of components.colors) {
        combinations.push({ bodyShape, eyeStyle, color: color.id });
      }
    }
  }
  return combinations;
}

/**
 * Writes every bundle in scope plus the alternate-name xcconfig, returning the
 * generated bundle names in generation order.
 */
export function generateAvatarIcons(
  options: GenerateAvatarIconsOptions,
): string[] {
  const combinations = traitCombinations(options.scope);
  const colorHexById = new Map(
    getCharacterComponents().colors.map((color) => [color.id, color.hex]),
  );

  rmSync(options.iconsDir, { recursive: true, force: true });
  mkdirSync(options.iconsDir, { recursive: true });

  const names: string[] = [];
  for (const traits of combinations) {
    const hex = colorHexById.get(traits.color);
    if (!hex) {
      throw new Error(`Unknown color id: "${traits.color}"`);
    }

    const name = iconNameForTraits(traits);
    const bundleDir = join(options.iconsDir, `${name}.icon`);
    mkdirSync(join(bundleDir, ASSETS_DIR_NAME), { recursive: true });
    writeFileSync(join(bundleDir, "icon.json"), buildIconJson(hex));
    writeFileSync(
      join(bundleDir, ASSETS_DIR_NAME, LAYER_IMAGE_NAME),
      `${composeSvg(traits.bodyShape, traits.eyeStyle, traits.color, SVG_SIZE)}\n`,
    );
    names.push(name);
  }

  mkdirSync(dirname(options.xcconfigPath), { recursive: true });
  writeFileSync(options.xcconfigPath, buildXcconfig(names));

  return names;
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

/**
 * Serialized with a fixed key order and no timestamps so reruns are
 * byte-identical. Icon Composer writes these files unformatted by Prettier
 * standards, and the existing `AppIcon.icon/icon.json` matches this shape.
 */
function buildIconJson(colorHex: string): string {
  const icon = {
    fill: { solid: toDisplayP3(backgroundTint(colorHex)) },
    groups: [
      {
        "blend-mode": "normal",
        layers: [
          {
            "fill-specializations": [{ appearance: "dark", value: "none" }],
            glass: false,
            "image-name": LAYER_IMAGE_NAME,
            name: LAYER_NAME,
            position: {
              scale: CHARACTER_SCALE,
              "translation-in-points": [0, 0],
            },
          },
        ],
        lighting: "individual",
        name: "Group",
        shadow: { kind: "neutral", opacity: 0.5 },
        specular: true,
        translucency: { enabled: false, value: 0 },
      },
    ],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  };
  return `${JSON.stringify(icon, null, 2)}\n`;
}

function buildXcconfig(names: string[]): string {
  return [
    "// AvatarIcons.xcconfig is generated by",
    "// clients/ios/scripts/generate-avatar-icons.ts. Do not edit by hand.",
    "//",
    "// Regenerate with:",
    `//   ${GENERATOR_COMMAND}`,
    "//",
    "// Lists every bundle in App/App/AvatarIcons/.",
    "",
    `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = ${names.join(" ")}`,
    "",
  ].join("\n");
}

function parseHex(hex: string): [number, number, number] {
  const digits = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(`Expected a 6-digit hex color, got "${hex}"`);
  }
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

function backgroundTint(hex: string): [number, number, number] {
  const [red, green, blue] = parseHex(hex);
  const blend = (channel: number): number => {
    return Math.round(channel + (255 - channel) * BACKGROUND_WHITE_BLEND);
  };
  return [blend(red), blend(green), blend(blue)];
}

function toDisplayP3(rgb: [number, number, number]): string {
  const channels = rgb.map((channel) => (channel / 255).toFixed(5)).join(",");
  return `display-p3:${channels},1.00000`;
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Renders a grid preview of the generated set. Development aid only: the sheet
 * is a PNG, and this repo commits no binary avatar assets, so it must land
 * outside the working tree.
 */
async function writeContactSheet(
  outputPath: string,
  combinations: AvatarIconTraits[],
): Promise<void> {
  const resolved = resolve(outputPath);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error(
      `Refusing to write a contact sheet inside the repository: ${resolved}. ` +
        `Pass a path outside ${REPO_ROOT}, for example ${join(tmpdir(), "avatar-icons.png")}.`,
    );
  }

  const { renderCharacterPng } =
    await import("../../../assistant/src/avatar/png-renderer.js");
  const { getResvg } =
    await import("../../../assistant/src/avatar/resvg-lazy.js");

  const colors = getCharacterComponents().colors;
  const colorHexById = new Map(colors.map((color) => [color.id, color.hex]));
  const columns = colors.length;
  const rows = Math.ceil(combinations.length / columns);
  const width = columns * CONTACT_SHEET_CELL_PX;
  const height = rows * CONTACT_SHEET_CELL_PX;
  const characterPx = Math.round(
    CONTACT_SHEET_CELL_PX * CHARACTER_CANVAS_FRACTION,
  );
  const inset = (CONTACT_SHEET_CELL_PX - characterPx) / 2;

  const cells = combinations.map((traits, index) => {
    const hex = colorHexById.get(traits.color);
    if (!hex) {
      throw new Error(`Unknown color id: "${traits.color}"`);
    }
    const x = (index % columns) * CONTACT_SHEET_CELL_PX;
    const y = Math.floor(index / columns) * CONTACT_SHEET_CELL_PX;
    const png = renderCharacterPng(
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
      characterPx,
    ).toString("base64");
    return (
      `<rect x="${x}" y="${y}" width="${CONTACT_SHEET_CELL_PX}" height="${CONTACT_SHEET_CELL_PX}" fill="${toHex(backgroundTint(hex))}"/>` +
      `<image x="${x + inset}" y="${y + inset}" width="${characterPx}" height="${characterPx}" xlink:href="data:image/png;base64,${png}"/>`
    );
  });

  const sheetSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells.join("")}</svg>`;

  const Resvg = getResvg();
  const sheet = new Resvg(sheetSvg, { fitTo: { mode: "width", value: width } });
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, Buffer.from(sheet.render().asPng()));
}

function parseContactSheetPath(argv: string[]): string | undefined {
  const flagIndex = argv.indexOf("--contact-sheet");
  if (flagIndex === -1) {
    return undefined;
  }
  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--contact-sheet requires a file path argument");
  }
  return value;
}

function totalBytes(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(entry));
    const stats = statSync(path);
    if (stats.isFile()) {
      bytes += stats.size;
    }
  }
  return bytes;
}

async function main(argv: string[]): Promise<void> {
  const scope: IconSetScope = argv.includes("--full") ? "full" : "pilot";
  const contactSheetPath = parseContactSheetPath(argv);

  const names = generateAvatarIcons({
    iconsDir: AVATAR_ICONS_DIR,
    xcconfigPath: AVATAR_ICONS_XCCONFIG_PATH,
    scope,
  });

  const kilobytes = Math.round(totalBytes(AVATAR_ICONS_DIR) / 1024);
  console.log(
    `Generated ${names.length} ${scope} icon bundles (${kilobytes} KB) in ${AVATAR_ICONS_DIR}`,
  );
  console.log(`Wrote ${AVATAR_ICONS_XCCONFIG_PATH}`);

  if (contactSheetPath) {
    await writeContactSheet(contactSheetPath, traitCombinations(scope));
    console.log(`Wrote contact sheet to ${resolve(contactSheetPath)}`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
