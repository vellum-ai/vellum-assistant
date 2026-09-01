/**
 * Drift guard for the generated Android alternate launcher icons.
 *
 * Run from `clients/ios/`:
 *
 *   cd clients/ios && bun test scripts/__tests__/android-avatar-icons.test.ts
 *
 * The repo-root `test-preload.ts` guard rejects `bun test` invoked from the
 * repo root, so these run from the client directory.
 *
 * Measuring the eye artwork needs the native `@resvg/resvg-js` binding, so the
 * assistant package's dependencies have to be installed first
 * (`bun install --filter=@vellumai/assistant`).
 *
 * The committed resources are XML rather than an image format nobody can read,
 * which makes them tempting to hand-edit. Everything below exists so an edit
 * that the generator would not have produced fails here.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCharacterComponents,
  SCLERA,
} from "../../../../packages/avatar-catalog/src/index.js";
import {
  androidResourceNameForTraits,
  eyeArtworkBounds,
  traitCombinations,
  type EyeStyle,
  type IconSetScope,
} from "../avatar-icon-core.js";
import {
  ANDROID_RES_DIR,
  generateAndroidAvatarIcons,
  ownedResourcePaths,
} from "../generate-android-avatar-icons.js";

/** Scope of the resource set checked into the repo. Narrowing it is a code change. */
const COMMITTED_SCOPE: IconSetScope = "full";

/** Side of the canvas an adaptive-icon mask keeps visible, in dp. */
const MASKED_DP = 72;

/**
 * Measuring nine eye styles takes a few seconds on an M-series laptop and a CI
 * runner is roughly an order of magnitude slower, so this is a backstop rather
 * than a target.
 */
const GENERATION_TIMEOUT_MS = 600_000;

/**
 * Styles the transform assertions walk. `quirky` is the one the default
 * launcher icon also draws, and `dazed` and `bashful` are the two the span
 * table moves off the default fraction.
 */
const SAMPLED_EYE_STYLES = ["quirky", "dazed", "bashful"];

const GROUP_ATTRS = [
  "pivotX",
  "pivotY",
  "scaleX",
  "scaleY",
  "translateX",
  "translateY",
] as const;

type GroupTransform = Record<(typeof GROUP_ATTRS)[number], string>;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readCommitted(relativePath: string): string {
  return readFileSync(join(ANDROID_RES_DIR, relativePath), "utf8");
}

function requireEyeStyle(eyeStyleId: string): EyeStyle {
  const eyeStyle = getCharacterComponents().eyeStyles.find(
    (eye) => eye.id === eyeStyleId,
  );
  if (!eyeStyle) {
    throw new Error(`Eye style "${eyeStyleId}" missing from the catalog`);
  }
  return eyeStyle;
}

/**
 * Every path inside the placement group, in document order. The group holds the
 * eye geometry and nothing else, so a legacy fallback's background field stays
 * out of the comparison.
 */
function extractEyePaths(xml: string): Array<{ fill: string; d: string }> {
  const group = /<group\b.*?<\/group>/s.exec(xml)?.[0];
  if (!group) {
    throw new Error("No placement group in the launcher XML");
  }
  const paths: Array<{ fill: string; d: string }> = [];
  for (const match of group.match(/<path\b[^>]*\/>/gs) ?? []) {
    const fill = /android:fillColor="([^"]+)"/.exec(match)?.[1];
    const d = /android:pathData="([^"]+)"/.exec(match)?.[1];
    if (fill === undefined || d === undefined) {
      continue;
    }
    paths.push({ fill, d });
  }
  return paths;
}

function extractTransform(xml: string, relativePath: string): GroupTransform {
  const transform: Record<string, string> = {};
  for (const attr of GROUP_ATTRS) {
    const value = new RegExp(`android:${attr}="([^"]+)"`).exec(xml)?.[1];
    if (value === undefined) {
      throw new Error(`${relativePath} is missing android:${attr}`);
    }
    transform[attr] = value;
  }
  return transform as GroupTransform;
}

function committedTransform(relativePath: string): GroupTransform {
  return extractTransform(readCommitted(relativePath), relativePath);
}

/** Relative path to content digest, so two resource trees diff byte for byte. */
function snapshot(resDir: string): Map<string, string> {
  return new Map(
    ownedResourcePaths(resDir).map((relativePath) => [
      relativePath,
      createHash("sha256")
        .update(readFileSync(join(resDir, relativePath)))
        .digest("hex"),
    ]),
  );
}

/**
 * Fraction of the icon one style's pair is drawn at, recovered from the scale
 * the generator emitted. Reversing the derivation is what lets the span table
 * be pinned through the committed XML rather than through the module that
 * produced it.
 */
function spanFractionOf(eyeStyleId: string): number {
  const bounds = eyeArtworkBounds(requireEyeStyle(eyeStyleId));
  const transform = committedTransform(
    `drawable/avatar_eyes_fg_${eyeStyleId}.xml`,
  );
  return (
    (Number(transform.scaleX) * Math.max(bounds.width, bounds.height)) /
    MASKED_DP
  );
}

function expectedResourcePaths(): string[] {
  const combinations = traitCombinations(COMMITTED_SCOPE);
  const eyeStyleIds = [
    ...new Set(combinations.map((traits) => traits.eyeStyle)),
  ];
  return [
    "values/avatar_icon_colors.xml",
    ...eyeStyleIds.flatMap((eyeStyleId) => [
      `drawable/avatar_eyes_fg_${eyeStyleId}.xml`,
      `drawable/avatar_eyes_mono_${eyeStyleId}.xml`,
    ]),
    ...combinations.flatMap((traits) => {
      const name = androidResourceNameForTraits(traits);
      return [
        `mipmap-anydpi/${name}.xml`,
        `mipmap-anydpi-v26/${name}.xml`,
        `mipmap-anydpi-v33/${name}.xml`,
      ];
    }),
  ].sort();
}

describe("committed Android avatar icons", () => {
  test(
    "match a fresh generation",
    () => {
      const resDir = mkdtempSync(join(tmpdir(), "android-avatar-icons-"));
      tempDirs.push(resDir);
      generateAndroidAvatarIcons({ resDir, scope: COMMITTED_SCOPE });
      expect(snapshot(ANDROID_RES_DIR)).toEqual(snapshot(resDir));
    },
    GENERATION_TIMEOUT_MS,
  );

  /**
   * Counts the checked-in tree on its own, so a commit that dropped resources
   * reports the names rather than a whole-tree digest diff.
   */
  test("hold one resource per trait combination and nothing else", () => {
    expect(ownedResourcePaths(ANDROID_RES_DIR)).toEqual(
      expectedResourcePaths(),
    );
  });

  test("leave the default launcher icons alone", () => {
    for (const relativePath of ownedResourcePaths(ANDROID_RES_DIR)) {
      expect(relativePath).not.toContain("ic_launcher");
    }
  });

  /**
   * An alternate icon looks the same in every flavor, so it must not reach for
   * the flavor-owned default launcher background.
   */
  test("never reference the flavor launcher background", () => {
    for (const relativePath of ownedResourcePaths(ANDROID_RES_DIR)) {
      expect(readCommitted(relativePath)).not.toContain("launcher_background");
    }
  });

  /**
   * The manifest aliases point at `@mipmap/avatar_eyes_<eye>_<color>`, and each
   * of those resolves to the drawables and color named here, so a rename on
   * either side stops the icon resolving at install time.
   */
  test("wire every adaptive icon to its own background color and eye pair", () => {
    const colorHex = new Map(
      getCharacterComponents().colors.map((color) => [color.id, color.hex]),
    );
    for (const traits of traitCombinations(COMMITTED_SCOPE)) {
      const name = androidResourceNameForTraits(traits);
      const background = `<background android:drawable="@color/avatar_icon_bg_${traits.color}" />`;
      const foreground = `<foreground android:drawable="@drawable/avatar_eyes_fg_${traits.eyeStyle}" />`;
      const monochrome = `<monochrome android:drawable="@drawable/avatar_eyes_mono_${traits.eyeStyle}" />`;

      const adaptive = readCommitted(`mipmap-anydpi-v26/${name}.xml`);
      expect(adaptive).toContain(background);
      expect(adaptive).toContain(foreground);
      expect(adaptive).not.toContain("<monochrome");

      const themed = readCommitted(`mipmap-anydpi-v33/${name}.xml`);
      expect(themed).toContain(background);
      expect(themed).toContain(foreground);
      expect(themed).toContain(monochrome);

      // Nothing masks the pre-adaptive fallback, so it paints its own field.
      const legacy = readCommitted(`mipmap-anydpi/${name}.xml`);
      expect(legacy).toContain(
        `android:fillColor="${colorHex.get(traits.color)}"`,
      );
      expect(legacy).toContain('android:pathData="M0,0h108v108h-108z"');
    }

    expect(readCommitted("values/avatar_icon_colors.xml")).toContain(
      '<color name="avatar_icon_bg_green">#4C9B50</color>',
    );
  });
});

describe.each(SAMPLED_EYE_STYLES)("avatar_eyes_*_%s", (eyeStyleId) => {
  const eyeStyle = requireEyeStyle(eyeStyleId);
  const foregroundPath = `drawable/avatar_eyes_fg_${eyeStyleId}.xml`;
  const monochromePath = `drawable/avatar_eyes_mono_${eyeStyleId}.xml`;
  const legacyPath = `mipmap-anydpi/${androidResourceNameForTraits({
    eyeStyle: eyeStyleId,
    color: "green",
  })}.xml`;

  test("the foreground embeds the catalog paths verbatim", () => {
    const embedded = extractEyePaths(readCommitted(foregroundPath));
    expect(embedded).toEqual(
      eyeStyle.paths.map((path) => ({ fill: path.color, d: path.svgPath })),
    );
  });

  test("the legacy fallback embeds the same paths", () => {
    expect(extractEyePaths(readCommitted(legacyPath))).toEqual(
      extractEyePaths(readCommitted(foregroundPath)),
    );
  });

  test("the themed-icon mask is the sclera paths in white", () => {
    const embedded = extractEyePaths(readCommitted(monochromePath));
    expect(embedded).toEqual(
      eyeStyle.paths
        .filter((path) => path.color === SCLERA)
        .map((path) => ({ fill: "#FFFFFF", d: path.svgPath })),
    );
    expect(embedded.length).toBeGreaterThan(0);
  });

  test("every group pivots on the catalog eye center", () => {
    for (const relativePath of [foregroundPath, monochromePath, legacyPath]) {
      const transform = committedTransform(relativePath);
      expect(transform.pivotX).toBe(String(eyeStyle.eyeCenter.x));
      expect(transform.pivotY).toBe(String(eyeStyle.eyeCenter.y));
    }
  });

  test("every group centers the pivot on the 108dp canvas", () => {
    // A VectorDrawable group maps the pivot to pivot + translate, so this sum
    // is the on-canvas position of the eye center and must be the canvas
    // center regardless of where the catalog puts eyeCenter.
    for (const relativePath of [foregroundPath, monochromePath, legacyPath]) {
      const transform = committedTransform(relativePath);
      expect(Number(transform.pivotX) + Number(transform.translateX)).toBe(54);
      expect(Number(transform.pivotY) + Number(transform.translateY)).toBe(54);
    }
  });

  test("the mask shares the foreground transform", () => {
    expect(committedTransform(monochromePath)).toEqual(
      committedTransform(foregroundPath),
    );
  });

  test("scales are uniform and the legacy scale fills the unmasked canvas", () => {
    const adaptive = committedTransform(foregroundPath);
    const legacy = committedTransform(legacyPath);
    expect(adaptive.scaleY).toBe(adaptive.scaleX);
    expect(legacy.scaleY).toBe(legacy.scaleX);
    expect(legacy.translateX).toBe(adaptive.translateX);
    expect(legacy.translateY).toBe(adaptive.translateY);
    // Legacy icons fill the full 108dp canvas while adaptive art targets the
    // 72dp a launcher mask reveals, so the scales differ by exactly 108/72.
    expect(Number(legacy.scaleX)).toBeCloseTo(
      Number(adaptive.scaleX) * 1.5,
      10,
    );
  });
});

describe("alternate icon sizing", () => {
  /**
   * The alternates have to read at the same size as the default launcher icon
   * sitting next to them in the picker.
   *
   * The two numbers are derived rather than copied: the committed default was
   * rounded by hand off the artwork's geometric bounding box, while the
   * generator measures by rasterizing, which reports whole probe pixels and so
   * lands within a rounding step of it.
   */
  test("draw quirky at the default launcher icon's scale", () => {
    const generated = committedTransform("drawable/avatar_eyes_fg_quirky.xml");
    const shipped = committedTransform("drawable/ic_launcher_foreground.xml");
    expect(Number(generated.scaleX)).toBeCloseTo(Number(shipped.scaleX), 3);
  });

  /**
   * `dazed` is framed wider and `bashful` narrower than the default fraction.
   * Pinning the ratios rather than the fractions keeps this honest about the
   * only thing the emitted scale can prove: that the span table reached the
   * XML.
   */
  test(
    "frame dazed wider and bashful narrower than the default fraction",
    () => {
      const quirky = spanFractionOf("quirky");
      expect(spanFractionOf("dazed") / quirky).toBeCloseTo(0.55 / 0.5, 2);
      expect(spanFractionOf("bashful") / quirky).toBeCloseTo(0.4 / 0.5, 2);
    },
    GENERATION_TIMEOUT_MS,
  );
});
