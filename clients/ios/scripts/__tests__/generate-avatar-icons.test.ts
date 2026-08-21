/**
 * Run from `clients/ios/`:
 *
 *   cd clients/ios && bun test scripts/__tests__/generate-avatar-icons.test.ts
 *
 * The repo-root `test-preload.ts` guard rejects `bun test` invoked from the
 * repo root, so these run from the client directory.
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

import { getCharacterComponents } from "../../../../assistant/src/avatar/character-components.js";
import {
  AVATAR_ICONS_DIR,
  AVATAR_ICONS_XCCONFIG_PATH,
  generateAvatarIcons,
  iconNameForTraits,
  traitCombinations,
} from "../generate-avatar-icons.js";

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

function generatePilotInto(dir: string): {
  iconsDir: string;
  xcconfigPath: string;
} {
  const iconsDir = join(dir, "AvatarIcons");
  const xcconfigPath = join(dir, "AvatarIcons.xcconfig");
  generateAvatarIcons({ iconsDir, xcconfigPath, scope: "pilot" });
  return { iconsDir, xcconfigPath };
}

/** Relative path to file contents, so two trees can be diffed byte for byte. */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const relativePath = String(entry);
    const absolutePath = join(dir, relativePath);
    if (statSync(absolutePath).isFile()) {
      files.set(relativePath, readFileSync(absolutePath, "utf8"));
    }
  }
  return files;
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

  test("names every generated bundle", () => {
    const { iconsDir } = generatePilotInto(makeTempDir());
    const bundles = readdirSync(iconsDir).sort();
    const expected = traitCombinations("pilot")
      .map((traits) => `${iconNameForTraits(traits)}.icon`)
      .sort();
    expect(bundles).toEqual(expected);
  });
});

describe("generateAvatarIcons", () => {
  test("writes an Icon Composer bundle for each trait combination", () => {
    const { iconsDir } = generatePilotInto(makeTempDir());
    expect(readdirSync(iconsDir)).toHaveLength(2 * 2 * 6);
  });

  test("emits the tinted background fill and the composed character SVG", () => {
    const { iconsDir } = generatePilotInto(makeTempDir());
    const bundleDir = join(iconsDir, "avatar-blob-grumpy-green.icon");

    const icon = JSON.parse(readFileSync(join(bundleDir, "icon.json"), "utf8"));
    expect(icon.fill.solid).toBe("display-p3:0.75294,0.86275,0.76078,1.00000");
    expect(icon.groups[0].layers[0]["image-name"]).toBe("avatar.svg");
    expect(icon.groups[0].layers[0].position.scale).toBe(1.4);

    const svg = readFileSync(join(bundleDir, "Assets", "avatar.svg"), "utf8");
    const blob = getCharacterComponents().bodyShapes.find(
      (body) => body.id === "blob",
    );
    expect(blob).toBeDefined();
    expect(svg).toContain(blob!.svgPath);
    expect(svg).toContain('fill="#4C9B50"');
  });

  test("lists every bundle in the generated xcconfig", () => {
    const { xcconfigPath } = generatePilotInto(makeTempDir());
    const xcconfig = readFileSync(xcconfigPath, "utf8");

    expect(xcconfig).toContain(
      "bun clients/ios/scripts/generate-avatar-icons.ts",
    );
    const setting = xcconfig
      .split("\n")
      .find((line) =>
        line.startsWith("ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "),
      );
    expect(setting).toBeDefined();
    const names = setting!
      .slice("ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = ".length)
      .split(" ");
    expect(names).toEqual(traitCombinations("pilot").map(iconNameForTraits));
  });

  test("is deterministic across reruns", () => {
    const dir = makeTempDir();
    const { iconsDir, xcconfigPath } = generatePilotInto(dir);
    const first = snapshotTree(iconsDir);
    const firstXcconfig = readFileSync(xcconfigPath, "utf8");

    generatePilotInto(dir);
    expect(snapshotTree(iconsDir)).toEqual(first);
    expect(readFileSync(xcconfigPath, "utf8")).toBe(firstXcconfig);
  });
});

describe("committed pilot set", () => {
  test("matches a fresh generation", () => {
    const { iconsDir, xcconfigPath } = generatePilotInto(makeTempDir());
    expect(snapshotTree(AVATAR_ICONS_DIR)).toEqual(snapshotTree(iconsDir));
    expect(readFileSync(AVATAR_ICONS_XCCONFIG_PATH, "utf8")).toBe(
      readFileSync(xcconfigPath, "utf8"),
    );
  });
});
