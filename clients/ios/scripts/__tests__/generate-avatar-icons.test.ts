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
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AVATAR_ICONS_DIR,
  AVATAR_ICONS_XCCONFIG_PATH,
  generateAvatarIcons,
  iconNameForTraits,
  traitCombinations,
  type IconSetScope,
} from "../generate-avatar-icons.js";

/** Scope of the catalog checked into the repo. Widening it is a code change. */
const COMMITTED_SCOPE: IconSetScope = "pilot";

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
 * Rasterizing the committed set takes seconds, well past the 5s default, and
 * CI runners are slower than a laptop.
 */
const GENERATION_TIMEOUT_MS = 120_000;

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

function generateInto(dir: string): GeneratedCatalog {
  const iconsDir = join(dir, "AvatarIcons.xcassets");
  const xcconfigPath = join(dir, "AvatarIcons.xcconfig");
  generateAvatarIcons({ iconsDir, xcconfigPath, scope: COMMITTED_SCOPE });
  return { iconsDir, xcconfigPath };
}

let shared: GeneratedCatalog | undefined;

/** One generation shared by every read-only assertion, since each costs seconds. */
function catalog(): GeneratedCatalog {
  if (!shared) {
    shared = generateInto(makeTempDir());
  }
  return shared;
}

/**
 * Relative path to base64 contents, so two trees can be diffed byte for byte
 * whether the file is JSON or a PNG.
 */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const relativePath = String(entry);
    const absolutePath = join(dir, relativePath);
    if (statSync(absolutePath).isFile()) {
      files.set(relativePath, readFileSync(absolutePath).toString("base64"));
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

describe("iconNameForTraits", () => {
  test("builds the avatar-<body>-<eye>-<color> wire name", () => {
    expect(
      iconNameForTraits({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
    ).toBe("avatar-blob-grumpy-green");
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
      // The pilot scope: 2 body shapes x 2 eye styles x 6 colors.
      expect(iconSetNames(catalog().iconsDir)).toHaveLength(2 * 2 * 6);
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
        "avatar-blob-grumpy-green.appiconset",
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
        expect(pngDimensions(png)).toEqual({ width: 1024, height: 1024 });
        expect(png.byteLength).toBeGreaterThan(MIN_ICON_BYTES);
      }
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
      const { iconsDir, xcconfigPath } = generateInto(dir);
      const first = snapshotTree(iconsDir);
      const firstXcconfig = readFileSync(xcconfigPath, "utf8");

      generateInto(dir);
      expect(snapshotTree(iconsDir)).toEqual(first);
      expect(readFileSync(xcconfigPath, "utf8")).toBe(firstXcconfig);
    },
    GENERATION_TIMEOUT_MS,
  );
});

describe("committed catalog", () => {
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
