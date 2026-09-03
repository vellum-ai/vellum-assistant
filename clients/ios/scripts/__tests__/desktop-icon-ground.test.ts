/**
 * Drift guard tying the desktop icon grounds to the iOS bundles.
 *
 * macOS and Linux each keep their own copy of the same Icon Composer manifests,
 * and a hand edit to one mirror leaves the two platforms shipping different
 * greens. The manifests also carry the same Display P3 encoding the iOS bundles
 * do, so an environment's ground is one value across every client. Windows has
 * no manifest to pin: it ships hand-rendered per-environment ICO assets, so
 * this guard decodes every image inside each one and reads its ground back
 * rather than trusting that whoever changed the palette also re-rendered the
 * icons. A hand render can mix sizes, so one entry is not evidence for the rest.
 * Linux derives its ground at build time instead, so the guard runs that
 * script's own conversion rather than a copy that could drift away from it.
 * The same conversion carries each ground over to the Android flavors, which
 * spell it as plain sRGB hex, so the two encodings cannot drift apart.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { P3_SPELLING, readIconFill } from "./icon-bundle-fixtures";

const CLIENTS_DIR = join(import.meta.dir, "../../..");

/** Every environment with a desktop icon manifest. */
const ENVIRONMENTS = ["production", "staging", "dev", "local"] as const;

/** The environments the standard palette covers, and their iOS bundle. */
const STANDARDIZED = [
  { environment: "production", icon: "AppIcon.icon" },
  { environment: "staging", icon: "AppIcon-Staging.icon" },
  { environment: "dev", icon: "AppIcon-Dev.icon" },
] as const;

/** The desktop manifests keep the fill at the top level, not per appearance. */
function readDesktopFill(platform: string, environment: string): string {
  const path = join(
    CLIENTS_DIR,
    platform,
    "build-resources/icons",
    environment,
    "icon.json",
  );
  return JSON.parse(readFileSync(path, "utf8")).fill.solid;
}

/** The launcher background an Android flavor declares, in plain sRGB hex. */
function flavorLauncherBackground(environment: string): string {
  const path = join(
    CLIENTS_DIR,
    "android/app/src",
    environment,
    "res/values/colors.xml",
  );
  const hex = /name="launcher_background"\s*>\s*(#[0-9A-Fa-f]{6})\s*</.exec(
    readFileSync(path, "utf8"),
  )?.[1];
  if (!hex) {
    throw new Error(`${environment} declares no launcher_background`);
  }
  return hex.toUpperCase();
}

function toHex(components: number[]): string {
  const digits = components
    .map((component) => component.toString(16).padStart(2, "0"))
    .join("");
  return `#${digits}`.toUpperCase();
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface DecodedPng {
  width: number;
  height: number;
  /** Row-major RGBA bytes. */
  pixels: Buffer;
}

interface IcoEntry {
  /** The entry's declared width, which the ICO header records as 0 for 256. */
  size: number;
  png: Buffer;
}

/** Every image the ICO carries, smallest first; they are all 32bpp PNGs. */
function readIcoEntries(environment: string): IcoEntry[] {
  const ico = readFileSync(
    join(CLIENTS_DIR, "windows/build-resources/icons", environment, "icon.ico"),
  );
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const record = 6 + index * 16;
    const offset = ico.readUInt32LE(record + 12);
    const png = ico.subarray(offset, offset + ico.readUInt32LE(record + 8));
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    return { size: ico[record] || 256, png };
  }).sort((left, right) => left.size - right.size);
}

/** The bytes an unfiltered scanline adds back, Paeth included. */
function unfilter(
  filter: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) {
    return 0;
  }
  if (filter === 1) {
    return left;
  }
  if (filter === 2) {
    return up;
  }
  if (filter === 3) {
    return (left + up) >> 1;
  }
  if (filter !== 4) {
    throw new Error(`unknown PNG scanline filter ${filter}`);
  }
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

/** Enough of the PNG spec to read an 8-bit RGBA entry: no palette, no interlace. */
function decodePng(png: Buffer): DecodedPng {
  let width = 0;
  let height = 0;
  const deflated: Buffer[] = [];
  for (let cursor = 8; cursor < png.length;) {
    const length = png.readUInt32BE(cursor);
    const type = png.toString("ascii", cursor + 4, cursor + 8);
    const data = png.subarray(cursor + 8, cursor + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]);
    } else if (type === "IDAT") {
      deflated.push(data);
    }
    cursor += length + 12;
  }
  const raw = inflateSync(Buffer.concat(deflated));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] as number;
    const scanline = row * (stride + 1) + 1;
    for (let byte = 0; byte < stride; byte += 1) {
      const left = byte >= 4 ? (pixels[row * stride + byte - 4] as number) : 0;
      const up = row > 0 ? (pixels[(row - 1) * stride + byte] as number) : 0;
      const upLeft =
        byte >= 4 && row > 0
          ? (pixels[(row - 1) * stride + byte - 4] as number)
          : 0;
      pixels[row * stride + byte] =
        ((raw[scanline + byte] as number) +
          unfilter(filter, left, up, upLeft)) &
        0xff;
    }
  }
  return { width, height, pixels };
}

/** The V mark covers part of every entry, so the ground is the modal pixel. */
function dominantOpaqueColor({ width, height, pixels }: DecodedPng): number[] {
  const counts = new Map<number, number>();
  for (let index = 0; index < width * height * 4; index += 4) {
    if (pixels[index + 3] !== 0xff) {
      continue;
    }
    const packed =
      ((pixels[index] as number) << 16) |
      ((pixels[index + 1] as number) << 8) |
      (pixels[index + 2] as number);
    counts.set(packed, (counts.get(packed) ?? 0) + 1);
  }
  let dominant = 0;
  let seen = 0;
  for (const [packed, count] of counts) {
    if (count > seen) {
      seen = count;
      dominant = packed;
    }
  }
  expect(seen).toBeGreaterThan(0);
  return [(dominant >> 16) & 0xff, (dominant >> 8) & 0xff, dominant & 0xff];
}

function linearize(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4;
}

function quantize(component: number): number {
  const clamped = Math.min(1, Math.max(0, component));
  const encoded =
    clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/**
 * A second implementation of the rotation `generate-icon.sh` renders through:
 * both spaces share the sRGB transfer pair, so only the primaries move. Two
 * implementations agreeing is the point, so this one stays written out here.
 */
function p3ToSrgb(fill: string): number[] {
  const [r = 0, g = 0, b = 0] = fill
    .replace("display-p3:", "")
    .split(",")
    .map((component) => linearize(Number(component)));
  const x =
    0.4865709486482162 * r + 0.26566769316909306 * g + 0.1982172852343625 * b;
  const y =
    0.2289745640697488 * r + 0.6917385218365064 * g + 0.079286914093745 * b;
  const z = 0.04511338185890264 * g + 1.043944368900976 * b;
  return [
    3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z,
    0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
  ].map(quantize);
}

const GENERATE_ICON = join(CLIENTS_DIR, "linux/scripts/generate-icon.sh");

/** The conversion Linux actually ships, run through the script that ships it. */
function renderedSrgb(fill: string): number[] {
  const { exitCode, stdout, stderr } = Bun.spawnSync({
    cmd: ["bash", GENERATE_ICON, "--print-srgb", fill],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exitCode !== 0) {
    throw new Error(`generate-icon --print-srgb failed: ${stderr.toString()}`);
  }
  const printed = stdout.toString().trim();
  expect(printed).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  return printed.slice(4, -1).split(",").map(Number);
}

describe("desktop icon ground", () => {
  for (const environment of ENVIRONMENTS) {
    test(`${environment} reads the same on macOS and Linux`, () => {
      expect(readDesktopFill("macos", environment)).toBe(
        readDesktopFill("linux", environment),
      );
    });
  }

  for (const { environment, icon } of STANDARDIZED) {
    test(`${environment} matches ${icon}`, () => {
      expect(readDesktopFill("macos", environment)).toBe(readIconFill(icon));
    });
  }

  for (const { environment, icon } of STANDARDIZED) {
    test(`Linux and every ${environment} Windows ICO image render ${icon}'s ground`, () => {
      const fill = readIconFill(icon);
      // The shipped awk and this file's rotation are independent conversions;
      // demanding both catches a drift in either one.
      const ground = renderedSrgb(fill);
      expect(ground).toEqual(p3ToSrgb(fill));
      const entries = readIcoEntries(environment);
      expect(entries.length).toBeGreaterThan(0);
      // Keying by size names the offending image when one entry drifts alone.
      expect(
        Object.fromEntries(
          entries.map(({ size, png }) => [
            `${size}px`,
            dominantOpaqueColor(decodePng(png)),
          ]),
        ),
      ).toEqual(
        Object.fromEntries(entries.map(({ size }) => [`${size}px`, ground])),
      );
    });
  }

  for (const { environment, icon } of STANDARDIZED) {
    // The P3 surfaces above and the sRGB surfaces Android and the web share are
    // two spellings of one ground, so each cluster staying self-consistent is
    // only half the guard: this converts across the seam and pins the result.
    test(`${icon} converts to the ${environment} Android launcher hex`, () => {
      expect(toHex(p3ToSrgb(readIconFill(icon)))).toBe(
        flavorLauncherBackground(environment),
      );
    });
  }

  test("local keeps its own ground in the spelling the renderers parse", () => {
    expect(readDesktopFill("macos", "local")).toMatch(P3_SPELLING);
  });

  test("the four grounds are actually different", () => {
    const grounds = ENVIRONMENTS.map((environment) =>
      readDesktopFill("macos", environment),
    );
    expect(new Set(grounds).size).toBe(ENVIRONMENTS.length);
  });
});
