#!/usr/bin/env bun
/**
 * Generates the asset catalog behind the iOS avatar alternate app icons, plus
 * the xcconfig that opts the build into shipping every icon set in it.
 *
 * Run from anywhere in the repo:
 *
 *   bun clients/ios/scripts/generate-avatar-icons.ts
 *   bun clients/ios/scripts/generate-avatar-icons.ts --full
 *   bun clients/ios/scripts/generate-avatar-icons.ts --contact-sheet /tmp/avatar-icons.png
 *
 * Rasterizing the icons needs the native `@resvg/resvg-js` binding, so the
 * assistant package's dependencies have to be installed first:
 * `bun install --filter=@vellumai/assistant`.
 *
 * Every run deletes and recreates the whole catalog, and the output is
 * deterministic, so regenerating an unchanged catalog produces byte-identical
 * files. `clients/ios/scripts/__tests__/generate-avatar-icons.test.ts` holds a
 * drift guard that fails when the committed set stops matching a fresh run.
 *
 * Each entry is a classic `.appiconset` holding a single opaque 1024x1024 PNG:
 * a background rect tinted from the trait color, with the composed character
 * centered on top. App icons may not be transparent, which is why the
 * background is baked into the pixels rather than left to the catalog, and why
 * the icons are written as color type 2 (RGB) PNGs with no alpha channel at
 * all. App Store validation rejects an app icon that carries one
 * (ITMS-90717), a failure that would otherwise only surface at upload time.
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
import { deflateSync } from "node:zlib";

import { getCharacterComponents } from "../../../assistant/src/avatar/character-components.js";
import { renderCharacterPng } from "../../../assistant/src/avatar/png-renderer.js";
import { getResvg } from "../../../assistant/src/avatar/resvg-lazy.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Committed output locations, both regenerated wholesale on every run. */
export const AVATAR_ICONS_DIR = join(
  REPO_ROOT,
  "clients",
  "ios",
  "App",
  "App",
  "AvatarIcons.xcassets",
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

/** Width and height of each rendered icon, in px. */
const ICON_PX = 1024;

/** Fraction of the canvas the character occupies, leaving a tinted margin. */
const CHARACTER_CANVAS_FRACTION = 0.7;

/** How far the background tint is blended from the trait color toward white. */
const BACKGROUND_WHITE_BLEND = 0.65;

const ICON_IMAGE_NAME = "icon.png";

/** Bytes every PNG opens with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** IHDR color type 2: three 8-bit channels and no alpha channel. */
const PNG_COLOR_TYPE_RGB = 2;

/**
 * Deflate level for the icon IDAT, pinned so regenerating an unchanged catalog
 * stays byte-identical. Level 9 also happens to be the one level where Bun and
 * Node emit the same bytes.
 */
const PNG_DEFLATE_LEVEL = 9;

/** Provenance block every `Contents.json` in an asset catalog carries. */
const CATALOG_INFO = { author: "xcode", version: 1 };

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
 * Icon set name for a character trait triple. The web layer derives the same
 * name when it asks iOS to switch icons, so this format is a wire contract:
 * changing it breaks every already-installed app until both sides ship
 * together.
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
 * Writes the whole asset catalog plus the xcconfig that ships it, returning the
 * generated icon set names in generation order.
 */
export function generateAvatarIcons(
  options: GenerateAvatarIconsOptions,
): string[] {
  const combinations = traitCombinations(options.scope);
  const colorHexById = colorHexIndex();

  rmSync(options.iconsDir, { recursive: true, force: true });
  mkdirSync(options.iconsDir, { recursive: true });
  writeFileSync(join(options.iconsDir, "Contents.json"), buildCatalogJson());

  const names: string[] = [];
  for (const traits of combinations) {
    const hex = requireColorHex(colorHexById, traits.color);
    const name = iconNameForTraits(traits);
    const setDir = join(options.iconsDir, `${name}.appiconset`);
    mkdirSync(setDir, { recursive: true });
    writeFileSync(join(setDir, "Contents.json"), buildIconSetJson());
    writeFileSync(join(setDir, ICON_IMAGE_NAME), renderIconPng(traits, hex));
    names.push(name);
  }

  mkdirSync(dirname(options.xcconfigPath), { recursive: true });
  writeFileSync(options.xcconfigPath, buildXcconfig());

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

/** Catalog root marker, matching what Xcode writes for `Assets.xcassets`. */
function buildCatalogJson(): string {
  return `${JSON.stringify({ info: CATALOG_INFO }, null, 2)}\n`;
}

/**
 * Single-size app icon manifest. One 1024x1024 universal entry covers every
 * iOS idiom, so each alternate is one PNG rather than a per-device ladder.
 */
function buildIconSetJson(): string {
  const contents = {
    images: [
      {
        filename: ICON_IMAGE_NAME,
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      },
    ],
    info: CATALOG_INFO,
  };
  return `${JSON.stringify(contents, null, 2)}\n`;
}

function buildXcconfig(): string {
  return [
    "// AvatarIcons.xcconfig is generated by",
    "// clients/ios/scripts/generate-avatar-icons.ts. Do not edit by hand.",
    "//",
    "// Regenerate with:",
    `//   ${GENERATOR_COMMAND}`,
    "//",
    "// Ships every icon set in App/App/AvatarIcons.xcassets as an alternate",
    "// app icon. actool writes them into CFBundleIcons ->",
    "// CFBundleAlternateIcons, which AppIconPlugin.swift reads back.",
    "",
    "ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES",
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

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One tinted square with the character centered on it, as SVG markup. Shared by
 * the icons themselves and by the contact sheet, so the preview shows the same
 * framing that ships.
 */
function iconCellSvg(
  traits: AvatarIconTraits,
  hex: string,
  x: number,
  y: number,
  size: number,
): string {
  const characterPx = Math.round(size * CHARACTER_CANVAS_FRACTION);
  const inset = (size - characterPx) / 2;
  const character = renderCharacterPng(
    traits.bodyShape,
    traits.eyeStyle,
    traits.color,
    characterPx,
  ).toString("base64");
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${toHex(backgroundTint(hex))}"/>` +
    `<image x="${x + inset}" y="${y + inset}" width="${characterPx}" height="${characterPx}" xlink:href="data:image/png;base64,${character}"/>`
  );
}

function renderSvg(body: string, width: number, height: number) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  const Resvg = getResvg();
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
}

function rasterize(body: string, width: number, height: number): Buffer {
  return Buffer.from(renderSvg(body, width, height).asPng());
}

/**
 * Rasterizes to a PNG with no alpha channel at all. `asPng()` always writes
 * RGBA, and App Store validation rejects app icons carrying an alpha channel
 * (ITMS-90717), a failure that only surfaces at TestFlight upload.
 */
function rasterizeOpaqueRgb(
  body: string,
  width: number,
  height: number,
): Buffer {
  const rendered = renderSvg(body, width, height);
  return encodeOpaqueRgbPng(rendered.pixels, rendered.width, rendered.height);
}

function renderIconPng(traits: AvatarIconTraits, hex: string): Buffer {
  return rasterizeOpaqueRgb(
    iconCellSvg(traits, hex, 0, 0, ICON_PX),
    ICON_PX,
    ICON_PX,
  );
}

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

/** The CRC-32 every PNG chunk carries, over its type bytes plus its payload. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.byteLength);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

/**
 * Encodes an RGBA pixel buffer as a color type 2 PNG, dropping the alpha byte
 * per pixel. Throws on any translucent pixel rather than flattening it: the
 * icons are drawn on an opaque background rect, so a translucent pixel means
 * the composition regressed and the dropped alpha would change what ships.
 */
function encodeOpaqueRgbPng(
  rgba: Buffer,
  width: number,
  height: number,
): Buffer {
  const rowBytes = width * 3;
  // Each scanline is a filter-type byte (0, None) followed by its pixels.
  const raw = Buffer.alloc(height * (1 + rowBytes));
  let target = 0;
  for (let y = 0; y < height; y += 1) {
    raw[target] = 0;
    target += 1;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const alpha = rgba[source + 3]!;
      if (alpha !== 0xff) {
        throw new Error(
          `Pixel (${x}, ${y}) is translucent (alpha ${alpha}). App icons must be fully opaque.`,
        );
      }
      raw[target] = rgba[source]!;
      raw[target + 1] = rgba[source + 1]!;
      raw[target + 2] = rgba[source + 2]!;
      target += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Bit depth.
  header[9] = PNG_COLOR_TYPE_RGB;
  header[10] = 0; // Deflate compression, the only method PNG defines.
  header[11] = 0; // Adaptive filtering, the only method PNG defines.
  header[12] = 0; // No interlacing.

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: PNG_DEFLATE_LEVEL })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Renders a grid preview of the generated set. Development aid only, so it must
 * land outside the working tree: the committed catalog is the only place icon
 * PNGs belong.
 */
function writeContactSheet(
  outputPath: string,
  combinations: AvatarIconTraits[],
): void {
  const resolved = resolve(outputPath);
  if (resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error(
      `Refusing to write a contact sheet inside the repository: ${resolved}. ` +
        `Pass a path outside ${REPO_ROOT}, for example ${join(tmpdir(), "avatar-icons.png")}.`,
    );
  }

  const colorHexById = colorHexIndex();
  const columns = getCharacterComponents().colors.length;
  const rows = Math.ceil(combinations.length / columns);
  const width = columns * CONTACT_SHEET_CELL_PX;
  const height = rows * CONTACT_SHEET_CELL_PX;

  const cells = combinations.map((traits, index) => {
    return iconCellSvg(
      traits,
      requireColorHex(colorHexById, traits.color),
      (index % columns) * CONTACT_SHEET_CELL_PX,
      Math.floor(index / columns) * CONTACT_SHEET_CELL_PX,
      CONTACT_SHEET_CELL_PX,
    );
  });

  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, rasterize(cells.join(""), width, height));
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

function main(argv: string[]): void {
  const scope: IconSetScope = argv.includes("--full") ? "full" : "pilot";
  const contactSheetPath = parseContactSheetPath(argv);

  const names = generateAvatarIcons({
    iconsDir: AVATAR_ICONS_DIR,
    xcconfigPath: AVATAR_ICONS_XCCONFIG_PATH,
    scope,
  });

  const kilobytes = Math.round(totalBytes(AVATAR_ICONS_DIR) / 1024);
  console.log(
    `Generated ${names.length} ${scope} icon sets (${kilobytes} KB) in ${AVATAR_ICONS_DIR}`,
  );
  console.log(`Wrote ${AVATAR_ICONS_XCCONFIG_PATH}`);

  if (contactSheetPath) {
    writeContactSheet(contactSheetPath, traitCombinations(scope));
    console.log(`Wrote contact sheet to ${resolve(contactSheetPath)}`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
