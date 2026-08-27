/**
 * Run from `clients/ios/`:
 *
 *   cd clients/ios && bun test scripts/__tests__/generate-avatar-icons.test.ts
 *
 * The repo-root `test-preload.ts` guard rejects `bun test` invoked from the
 * repo root, so these run from the client directory.
 *
 * Rasterizing the icons needs the native `@resvg/resvg-js` binding, so the
 * assistant package's dependencies have to be installed first
 * (`bun install --filter=@vellumai/assistant`). CI installs it alongside
 * `@vellumai/web` before running this file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import {
  AVATAR_ICONS_DIR,
  AVATAR_ICONS_XCCONFIG_PATH,
  generateAvatarIcons,
  iconNameForTraits,
  traitCombinations,
  type IconSetScope,
} from "../generate-avatar-icons.js";

/** Scope of the catalog checked into the repo. Narrowing it is a code change. */
const COMMITTED_SCOPE: IconSetScope = "full";

/** Every eye style x color the avatar component library defines. */
const COMMITTED_ICON_COUNT = 9 * 6;

/**
 * Scope of the determinism check. Byte-for-byte stability is a property of the
 * encoder rather than of the set size, so rerunning a 12-set slice proves it
 * for a fraction of the runtime. The drift guard below still pins every
 * committed icon, and needs only one fresh generation to do it.
 */
const DETERMINISM_SCOPE: IconSetScope = "pilot";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * IHDR color type 2: three 8-bit channels and no alpha channel. App Store
 * validation rejects an app icon that carries one (ITMS-90717).
 */
const PNG_COLOR_TYPE_RGB = 2;

/** Offset of the color type byte in the IHDR chunk of any PNG. */
const PNG_COLOR_TYPE_OFFSET = 25;

/** A 1024x1024 icon is tens of KB; anything far smaller is a broken render. */
const MIN_ICON_BYTES = 4096;

/**
 * Rasterizing all 54 icons takes about five seconds on an M-series laptop, and
 * a `macos-15` runner is roughly an order of magnitude slower, so this is a
 * backstop rather than a target. Generation is synchronous, which bun cannot
 * interrupt, so a run past this still finishes and then reports the test
 * failed.
 */
const GENERATION_TIMEOUT_MS = 600_000;

/** The determinism check reruns a 12-set slice: a second or two either way. */
const PILOT_GENERATION_TIMEOUT_MS = 300_000;

/** Width and height of every generated icon, in px. */
const ICON_PX = 1024;

/** Fraction of the icon a pair spans when the table below leaves it alone. */
const DEFAULT_EYE_SPAN_FRACTION = 0.5;

/**
 * Fraction of the icon each eye style's pair is fitted to, pinned as literals.
 *
 * `clients/web/src/components/avatar/app-icon-preview.test.tsx` pins the same
 * numbers against its own independent measurement of the same artwork, so the
 * on-screen preview and the shipped icons cannot drift apart across the bundle
 * boundary between them. A span that moved on one side alone fails here rather
 * than silently in 54 PNGs.
 */
const EXPECTED_EYE_SPAN_FRACTION: Record<string, number> = {
  grumpy: 0.5,
  angry: 0.5,
  curious: 0.5,
  goofy: 0.5,
  surprised: 0.5,
  bashful: 0.4,
  gentle: 0.5,
  quirky: 0.5,
  dazed: 0.55,
};

/**
 * Slack allowed on the measured eye span and center, in px. The generator sizes
 * the artwork from a pixel scan of a probe render, so both land within a pixel
 * of the target rather than exactly on it.
 */
const PLACEMENT_TOLERANCE_PX = 3;

interface GeneratedCatalog {
  iconsDir: string;
  xcconfigPath: string;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "avatar-icons-test-"));
  tempDirs.push(dir);
  return dir;
}

function generateInto(dir: string, scope: IconSetScope): GeneratedCatalog {
  const iconsDir = join(dir, "AvatarIcons.xcassets");
  const xcconfigPath = join(dir, "AvatarIcons.xcconfig");
  generateAvatarIcons({ iconsDir, xcconfigPath, scope });
  return { iconsDir, xcconfigPath };
}

let shared: GeneratedCatalog | undefined;

/** One generation shared by every read-only assertion, since each costs seconds. */
function catalog(): GeneratedCatalog {
  if (!shared) {
    shared = generateInto(makeTempDir(), COMMITTED_SCOPE);
  }
  return shared;
}

/**
 * Relative path to content digest, so two trees can be diffed byte for byte
 * whether the file is JSON or a PNG. Digests rather than the bytes themselves
 * because a mismatch across the whole catalog has to print a diff someone can
 * read.
 */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const relativePath = String(entry);
    const absolutePath = join(dir, relativePath);
    if (statSync(absolutePath).isFile()) {
      files.set(
        relativePath,
        createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
      );
    }
  }
  return files;
}

/** Width and height from the IHDR chunk, which a PNG always opens with. */
function pngDimensions(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function iconSetNames(iconsDir: string): string[] {
  return readdirSync(iconsDir)
    .filter((entry) => entry.endsWith(".appiconset"))
    .sort();
}

/** The eye style an `avatar-eyes-<eye>-<color>.appiconset` draws. */
function eyeStyleOf(setName: string): string {
  const eyeStyle = /^avatar-eyes-([a-z]+)-[a-z]+\.appiconset$/.exec(
    setName,
  )?.[1];
  if (!eyeStyle) {
    throw new Error(`Unexpected icon set name: "${setName}"`);
  }
  return eyeStyle;
}

/** Span the artwork of one eye style is expected to reach, in icon px. */
function expectedSpanPx(eyeStyleId: string): number {
  const fraction = EXPECTED_EYE_SPAN_FRACTION[eyeStyleId];
  if (fraction === undefined) {
    throw new Error(`No expected span for eye style "${eyeStyleId}"`);
  }
  return ICON_PX * fraction;
}

/** Longer edge of the artwork on one generated icon, in px. */
function renderedSpanPx(iconsDir: string, setName: string): number {
  const bounds = artworkBounds(
    readFileSync(join(iconsDir, setName, "icon.png")),
  );
  return Math.max(bounds.width, bounds.height);
}

/**
 * Bounds of everything that is not the flat background field, in px. The field
 * covers the whole canvas under the artwork, so the top-left pixel is its
 * color. The generator writes filter-type 0 scanlines of RGB triples into a
 * single IDAT, so inflating that chunk is the whole decode.
 */
function artworkBounds(png: Buffer): {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} {
  const { width, height } = pngDimensions(png);
  const idatStart = png.indexOf("IDAT", 0, "ascii");
  expect(idatStart).toBeGreaterThan(0);
  const idatLength = png.readUInt32BE(idatStart - 4);
  const raw = inflateSync(
    png.subarray(idatStart + 4, idatStart + 4 + idatLength),
  );

  const stride = 1 + width * 3;
  const background = raw.subarray(1, 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      if (
        raw[offset] === background[0] &&
        raw[offset + 1] === background[1] &&
        raw[offset + 2] === background[2]
      ) {
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
  return {
    width: maxX + 1 - minX,
    height: maxY + 1 - minY,
    centerX: (minX + maxX + 1) / 2,
    centerY: (minY + maxY + 1) / 2,
  };
}

describe("iconNameForTraits", () => {
  /**
   * The literal is the wire contract with the web layer, which pins the same
   * `avatar-eyes-grumpy-green` string in
   * `clients/web/src/utils/avatar-app-icon.test.ts`. Both have to change
   * together, and a rename ships under a new name rather than replacing the
   * artwork behind this one.
   */
  test("builds the avatar-eyes-<eye>-<color> wire name", () => {
    expect(
      iconNameForTraits({
        eyeStyle: "grumpy",
        color: "green",
      }),
    ).toBe("avatar-eyes-grumpy-green");
  });

  test(
    "names every generated icon set",
    () => {
      const expected = traitCombinations(COMMITTED_SCOPE)
        .map((traits) => `${iconNameForTraits(traits)}.appiconset`)
        .sort();
      expect(iconSetNames(catalog().iconsDir)).toEqual(expected);
    },
    GENERATION_TIMEOUT_MS,
  );
});

describe("generateAvatarIcons", () => {
  test(
    "writes an icon set for each trait combination",
    () => {
      // The full scope: 9 eye styles x 6 colors.
      expect(iconSetNames(catalog().iconsDir)).toHaveLength(
        COMMITTED_ICON_COUNT,
      );
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "marks the catalog root so actool reads the directory",
    () => {
      const contents = JSON.parse(
        readFileSync(join(catalog().iconsDir, "Contents.json"), "utf8"),
      );
      expect(contents).toEqual({ info: { author: "xcode", version: 1 } });
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "declares one universal 1024 image per icon set",
    () => {
      const setDir = join(
        catalog().iconsDir,
        "avatar-eyes-grumpy-green.appiconset",
      );
      const contents = JSON.parse(
        readFileSync(join(setDir, "Contents.json"), "utf8"),
      );
      expect(contents.images).toEqual([
        {
          filename: "icon.png",
          idiom: "universal",
          platform: "ios",
          size: "1024x1024",
        },
      ]);
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "renders a 1024x1024 PNG for every icon set",
    () => {
      const { iconsDir } = catalog();
      for (const setName of iconSetNames(iconsDir)) {
        const png = readFileSync(join(iconsDir, setName, "icon.png"));
        expect(pngDimensions(png)).toEqual({
          width: ICON_PX,
          height: ICON_PX,
        });
        expect(png.byteLength).toBeGreaterThan(MIN_ICON_BYTES);
      }
    },
    GENERATION_TIMEOUT_MS,
  );

  test("spans half the icon by default, dazed wider and bashful narrower", () => {
    const libraryIds = traitCombinations(COMMITTED_SCOPE).map(
      (traits) => traits.eyeStyle,
    );
    expect(Object.keys(EXPECTED_EYE_SPAN_FRACTION).sort()).toEqual(
      [...new Set(libraryIds)].sort(),
    );
    expect(EXPECTED_EYE_SPAN_FRACTION.dazed).toBe(0.55);
    expect(EXPECTED_EYE_SPAN_FRACTION.bashful).toBe(0.4);
    for (const [eyeStyleId, fraction] of Object.entries(
      EXPECTED_EYE_SPAN_FRACTION,
    )) {
      if (eyeStyleId === "dazed" || eyeStyleId === "bashful") {
        continue;
      }
      expect(fraction).toBe(DEFAULT_EYE_SPAN_FRACTION);
    }
  });

  test(
    "sizes every eye pair to its share of the icon and centers it",
    () => {
      const { iconsDir } = catalog();
      for (const setName of iconSetNames(iconsDir)) {
        const bounds = artworkBounds(
          readFileSync(join(iconsDir, setName, "icon.png")),
        );
        // The longer edge is the fitted one: width for a pair wider than it is
        // tall, height for one that is not.
        expect(
          Math.abs(
            Math.max(bounds.width, bounds.height) -
              expectedSpanPx(eyeStyleOf(setName)),
          ),
        ).toBeLessThanOrEqual(PLACEMENT_TOLERANCE_PX);
        expect(Math.abs(bounds.centerX - ICON_PX / 2)).toBeLessThanOrEqual(
          PLACEMENT_TOLERANCE_PX,
        );
        expect(Math.abs(bounds.centerY - ICON_PX / 2)).toBeLessThanOrEqual(
          PLACEMENT_TOLERANCE_PX,
        );
      }
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "draws bashful narrower than surprised",
    () => {
      const { iconsDir } = catalog();
      // The two styles are the same shape, so drawing both at the default span
      // would ship two icons a user cannot tell apart. `bashful` is the one
      // the table narrows.
      const bashful = renderedSpanPx(
        iconsDir,
        "avatar-eyes-bashful-green.appiconset",
      );
      const surprised = renderedSpanPx(
        iconsDir,
        "avatar-eyes-surprised-green.appiconset",
      );
      expect(bashful).toBeLessThan(surprised * 0.85);
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "writes every icon without an alpha channel",
    () => {
      const { iconsDir } = catalog();
      for (const setName of iconSetNames(iconsDir)) {
        const png = readFileSync(join(iconsDir, setName, "icon.png"));
        expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
        expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
        expect(png[PNG_COLOR_TYPE_OFFSET]).toBe(PNG_COLOR_TYPE_RGB);
      }
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "opts the build into shipping the whole catalog",
    () => {
      const xcconfig = readFileSync(catalog().xcconfigPath, "utf8");
      expect(xcconfig).toContain(
        "bun clients/ios/scripts/generate-avatar-icons.ts",
      );
      expect(xcconfig.split("\n")).toContain(
        "ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES",
      );
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "is deterministic across reruns",
    () => {
      const dir = makeTempDir();
      const { iconsDir, xcconfigPath } = generateInto(dir, DETERMINISM_SCOPE);
      const first = snapshotTree(iconsDir);
      const firstXcconfig = readFileSync(xcconfigPath, "utf8");

      generateInto(dir, DETERMINISM_SCOPE);
      expect(snapshotTree(iconsDir)).toEqual(first);
      expect(readFileSync(xcconfigPath, "utf8")).toBe(firstXcconfig);
    },
    PILOT_GENERATION_TIMEOUT_MS,
  );
});

describe("committed catalog", () => {
  /**
   * Counts the checked-in tree on its own, so a commit that dropped icon sets
   * reports the count rather than a whole-catalog digest diff.
   */
  test("holds every icon set and nothing else", () => {
    const setNames = iconSetNames(AVATAR_ICONS_DIR);
    expect(setNames).toHaveLength(COMMITTED_ICON_COUNT);
    expect(readdirSync(AVATAR_ICONS_DIR).sort()).toEqual([
      "Contents.json",
      ...setNames,
    ]);
  });

  test(
    "matches a fresh generation",
    () => {
      const { iconsDir, xcconfigPath } = catalog();
      expect(snapshotTree(AVATAR_ICONS_DIR)).toEqual(snapshotTree(iconsDir));
      expect(readFileSync(AVATAR_ICONS_XCCONFIG_PATH, "utf8")).toBe(
        readFileSync(xcconfigPath, "utf8"),
      );
    },
    GENERATION_TIMEOUT_MS,
  );
});
