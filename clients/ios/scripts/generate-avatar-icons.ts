#!/usr/bin/env bun
/**
 * Generates the asset catalog behind the iOS avatar alternate app icons, plus
 * the xcconfig that opts the build into shipping every icon set in it.
 *
 * Run from anywhere in the repo:
 *
 *   bun clients/ios/scripts/generate-avatar-icons.ts
 *   bun clients/ios/scripts/generate-avatar-icons.ts --pilot
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
 * a solid field in the trait color with the eye style's paths centered on top,
 * sized to that style's share of the icon (see {@link eyeSpanFraction}). The
 * PNGs carry no alpha channel at all; `encodeOpaqueRgbPng` below documents why.
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

import { getCharacterComponents } from "../../../packages/avatar-catalog/src/index.js";
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
 * `--pilot` narrows a local run to a 12-set slice, which rasterizes in a couple
 * of seconds. `grumpy` is the widest, flattest eye pair in the library and
 * `gentle` the closest to square, so between them they cover both ends of what
 * the placement below has to fit.
 */
const PILOT_EYE_STYLES = ["grumpy", "gentle"];

/**
 * Contact sheet cell size, in px. 180 is the largest size iOS ever draws an app
 * icon at, so the preview shows the artwork at the size it is read.
 */
const CONTACT_SHEET_CELL_PX = 180;

/** Every color in the palette is a 6-digit sRGB hex, and goes straight to SVG. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type IconSetScope = "pilot" | "full";

export interface AvatarIconTraits {
  eyeStyle: string;
  color: string;
}

type EyeStyle = ReturnType<typeof getCharacterComponents>["eyeStyles"][number];

/** Tight bounds of an eye style's artwork, in its own source viewBox units. */
interface EyeBounds {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export interface GenerateAvatarIconsOptions {
  iconsDir: string;
  xcconfigPath: string;
  scope: IconSetScope;
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

/** Trait pairs in scope, in a stable eye, color order. */
export function traitCombinations(scope: IconSetScope): AvatarIconTraits[] {
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
  if (!HEX_COLOR_PATTERN.test(hex)) {
    throw new Error(
      `Expected a 6-digit hex color for "${colorId}", got "${hex}"`,
    );
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

/** An eye style's paths, verbatim, under one shared affine transform. */
function eyePathsSvg(eyeStyle: EyeStyle, transform: string): string {
  return eyeStyle.paths
    .map(
      (path) =>
        `<path d="${path.svgPath}" fill="${path.color}" transform="${transform}"/>`,
    )
    .join("");
}

const eyeBoundsCache = new Map<string, EyeBounds>();

/**
 * Tight bounds of an eye style's artwork, measured by rasterizing it on its own
 * and scanning for covered pixels. Measuring through the same rasterizer that
 * writes the icons puts the bounds where the artwork is drawn rather than where
 * its path data nominally reaches, and the result is a pure function of the
 * path data, so the placement it feeds stays byte-reproducible.
 */
function eyeArtworkBounds(eyeStyle: EyeStyle): EyeBounds {
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
function eyeSpanFraction(eyeStyleId: string): number {
  return EYE_SPAN_FRACTION_OVERRIDES[eyeStyleId] ?? DEFAULT_EYE_SPAN_FRACTION;
}

/**
 * One solid trait-color square with the eye pair centered on it, as SVG markup.
 * Shared by the icons themselves and by the contact sheet, so the preview shows
 * the same framing that ships.
 *
 * The eyes are scaled so their measured bounds span this style's share of the
 * cell (see {@link eyeSpanFraction}) and centered on it. Taking the smaller of
 * the two ratios is what caps a pair taller than it is wide at that same
 * fraction of the cell height, so an unusually tall pair cannot outgrow a wide
 * one.
 */
function iconCellSvg(
  traits: AvatarIconTraits,
  hex: string,
  x: number,
  y: number,
  size: number,
): string {
  const eyeStyle = requireEyeStyle(traits.eyeStyle);
  const bounds = eyeArtworkBounds(eyeStyle);
  const span = size * eyeSpanFraction(eyeStyle.id);
  const scale = Math.min(span / bounds.width, span / bounds.height);
  const translateX = x + size / 2 - (bounds.minX + bounds.width / 2) * scale;
  const translateY = y + size / 2 - (bounds.minY + bounds.height / 2) * scale;
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${hex}"/>` +
    eyePathsSvg(
      eyeStyle,
      `matrix(${scale},0,0,${scale},${translateX},${translateY})`,
    )
  );
}

function renderSvg(body: string, width: number, height: number) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  const Resvg = getResvg();
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render();
}

function rasterize(body: string, width: number, height: number): Buffer {
  return Buffer.from(renderSvg(body, width, height).asPng());
}

/**
 * Rasterizes to a PNG with no alpha channel at all, which `asPng()` cannot do:
 * it always writes RGBA. See `encodeOpaqueRgbPng` for why the alpha has to go.
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
 * per pixel.
 *
 * This is the authoritative statement of why the icons carry no alpha channel:
 * App Store validation rejects an app icon that has one (ITMS-90717), a failure
 * that would otherwise only surface at TestFlight upload. That is also why the
 * tinted background is baked into the pixels rather than left to the catalog.
 *
 * Throws on any translucent pixel rather than flattening it: the icons are
 * drawn on an opaque background rect, so a translucent pixel means the
 * composition regressed and the dropped alpha would change what ships.
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
  // Full is the committed state, so a bare run reproduces what is checked in.
  const scope: IconSetScope = argv.includes("--pilot") ? "pilot" : "full";
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
