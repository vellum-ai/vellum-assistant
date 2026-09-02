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
 * that the generator would not have produced fails here. The same goes for the
 * generator-owned `<activity-alias>` block in `AndroidManifest.xml`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCharacterComponents,
  SCLERA,
} from "../../../../packages/avatar-catalog/src/index.js";
import {
  androidResourceNameForTraits,
  assertUnderscoreSafeIds,
  eyeArtworkBounds,
  requireEyeStyle,
  traitCombinations,
  type IconSetScope,
} from "../avatar-icon-core.js";
import {
  ANDROID_MANIFEST_PATH,
  ANDROID_RES_DIR,
  generateAndroidAvatarIcons,
  ownedResourcePaths,
  renderManifestWithIconAliases,
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

/** Comments fencing the generator-owned region of the manifest. */
const ALIAS_BLOCK_BEGIN = "<!-- avatar-icon-aliases:begin -->";
const ALIAS_BLOCK_END = "<!-- avatar-icon-aliases:end -->";

/** Number of icons the picker offers. The block adds the primary alias to them. */
const EXPECTED_ICON_ALIAS_COUNT = 54;

/** The launcher entry at rest, drawn with the default launcher artwork. */
const PRIMARY_ALIAS_NAME = ".icon.primary";

const LAUNCHER_ACTION = '<action android:name="android.intent.action.MAIN" />';
const LAUNCHER_CATEGORY =
  '<category android:name="android.intent.category.LAUNCHER" />';
const VIEW_ACTION = '<action android:name="android.intent.action.VIEW" />';
const SHORTCUTS_META_DATA_NAME = 'android:name="android.app.shortcuts"';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readCommitted(relativePath: string): string {
  return readFileSync(join(ANDROID_RES_DIR, relativePath), "utf8");
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

function committedManifest(): string {
  return readFileSync(ANDROID_MANIFEST_PATH, "utf8");
}

/** The owned region of a manifest, opening marker line through closing marker. */
function aliasBlockOf(manifest: string): string {
  const beginAt = manifest.indexOf(ALIAS_BLOCK_BEGIN);
  const endAt = manifest.indexOf(ALIAS_BLOCK_END);
  if (beginAt < 0 || endAt < beginAt) {
    throw new Error("The manifest has no avatar-icon-aliases block");
  }
  return manifest.slice(
    manifest.lastIndexOf("\n", beginAt) + 1,
    endAt + ALIAS_BLOCK_END.length,
  );
}

/** An element's attributes without those of anything nested inside it. */
function openingTagOf(element: string): string {
  const tag = /^[ \t]*<[\w-]+(?:\s[^>]*)?>/.exec(element)?.[0];
  if (!tag) {
    throw new Error(`No opening tag in: ${element.slice(0, 80)}`);
  }
  return tag;
}

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`android:${name}="([^"]*)"`).exec(
    openingTagOf(element),
  )?.[1];
}

function mainActivityOf(manifest: string): string {
  const element = /^[ \t]*<activity(?:\s[^>]*)?>[\s\S]*?<\/activity>/m.exec(
    manifest,
  )?.[0];
  if (!element || attribute(element, "name") !== ".MainActivity") {
    throw new Error("The manifest has no .MainActivity element");
  }
  return element;
}

function aliasElementsOf(manifest: string): string[] {
  return (
    aliasBlockOf(manifest).match(
      /^[ \t]*<activity-alias(?:\s[^>]*)?>[\s\S]*?<\/activity-alias>/gm,
    ) ?? []
  );
}

/** Trims each line so nesting depth stays out of a content comparison. */
function normalizeIndentation(element: string): string {
  return element
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

function intentFiltersOf(element: string): string[] {
  return (
    element.match(
      /^[ \t]*<intent-filter(?:\s[^>]*)?>[\s\S]*?<\/intent-filter>/gm,
    ) ?? []
  ).map(normalizeIndentation);
}

function metaDataOf(element: string): string[] {
  return (element.match(/^[ \t]*<meta-data\s[^>]*\/>/gm) ?? []).map(
    normalizeIndentation,
  );
}

interface FreshGeneration {
  resDir: string;
  manifestPath: string;
}

let freshGeneration: FreshGeneration | undefined;

/**
 * One generator run into a throwaway tree, shared by every test that reads it.
 * Rasterizing nine eye styles is the slow part, so it happens once.
 */
function generateFresh(): FreshGeneration {
  if (freshGeneration) {
    return freshGeneration;
  }
  const root = mkdtempSync(join(tmpdir(), "android-avatar-icons-"));
  tempDirs.push(root);
  const resDir = join(root, "res");
  const manifestPath = join(root, "AndroidManifest.xml");
  copyFileSync(ANDROID_MANIFEST_PATH, manifestPath);
  generateAndroidAvatarIcons({ resDir, manifestPath, scope: COMMITTED_SCOPE });
  freshGeneration = { resDir, manifestPath };
  return freshGeneration;
}

describe("androidResourceNameForTraits", () => {
  /**
   * Android resource names admit underscores rather than dashes, so this is the
   * wire name with every separator swapped. The literal is pinned because a
   * drawable that changes name stops resolving from the manifest entry that
   * references it.
   */
  test("builds the avatar_eyes_<eye>_<color> resource name", () => {
    expect(
      androidResourceNameForTraits({
        eyeStyle: "grumpy",
        color: "green",
      }),
    ).toBe("avatar_eyes_grumpy_green");
  });

  /** Whole-string dash to underscore translation only round-trips while this holds. */
  test("accepts every id in the current library", () => {
    expect(() => assertUnderscoreSafeIds()).not.toThrow();
  });
});

describe("committed Android avatar icons", () => {
  test(
    "match a fresh generation",
    () => {
      expect(snapshot(ANDROID_RES_DIR)).toEqual(
        snapshot(generateFresh().resDir),
      );
    },
    GENERATION_TIMEOUT_MS,
  );

  test(
    "survive a second generator run untouched",
    () => {
      const { resDir, manifestPath } = generateFresh();
      const resources = snapshot(resDir);
      const manifest = readFileSync(manifestPath, "utf8");
      generateAndroidAvatarIcons({
        resDir,
        manifestPath,
        scope: COMMITTED_SCOPE,
      });
      expect(snapshot(resDir)).toEqual(resources);
      expect(readFileSync(manifestPath, "utf8")).toBe(manifest);
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

describe("the manifest activity-alias block", () => {
  const manifest = committedManifest();
  const mainActivity = mainActivityOf(manifest);
  const aliases = aliasElementsOf(manifest);

  test("matches a fresh render of the committed manifest", () => {
    expect(renderManifestWithIconAliases(manifest, COMMITTED_SCOPE)).toBe(
      manifest,
    );
  });

  /**
   * Rendering replaces the block when the markers are there and creates it
   * directly after `.MainActivity` when they are not, so stripping the block and
   * rendering again has to land it back exactly where it was.
   */
  test("is recreated in place after being deleted", () => {
    const withoutBlock = manifest.replace(`\n\n${aliasBlockOf(manifest)}`, "");
    expect(withoutBlock).not.toContain(ALIAS_BLOCK_BEGIN);
    expect(renderManifestWithIconAliases(withoutBlock, COMMITTED_SCOPE)).toBe(
      manifest,
    );
  });

  test("declares the primary alias first, then one alias per icon", () => {
    expect(aliases.map((alias) => attribute(alias, "name"))).toEqual([
      PRIMARY_ALIAS_NAME,
      ...traitCombinations(COMMITTED_SCOPE).map(
        (traits) => `.icon.${androidResourceNameForTraits(traits)}`,
      ),
    ]);
    expect(aliases).toHaveLength(EXPECTED_ICON_ALIAS_COUNT + 1);
  });

  /**
   * Exactly one launcher-bearing component is enabled at rest, and it is the
   * primary alias, so a fresh install shows the default launcher icon. The
   * picker enables one alternate and disables the rest, never touching
   * `.MainActivity`.
   */
  test("enables the primary alias alone", () => {
    expect(
      aliases
        .filter((alias) => attribute(alias, "enabled") === "true")
        .map((alias) => attribute(alias, "name")),
    ).toEqual([PRIMARY_ALIAS_NAME]);
    for (const alias of aliases.slice(1)) {
      expect(attribute(alias, "enabled")).toBe("false");
    }
  });

  test("points every alias at MainActivity", () => {
    for (const alias of aliases) {
      expect(attribute(alias, "targetActivity")).toBe(".MainActivity");
      expect(attribute(alias, "exported")).toBe("true");
      expect(attribute(alias, "label")).toBe("@string/app_name");
    }
  });

  test("draws the primary alias with the default launcher icons", () => {
    const [primary] = aliases;
    expect(attribute(primary ?? "", "icon")).toBe("@mipmap/ic_launcher");
    expect(attribute(primary ?? "", "roundIcon")).toBe(
      "@mipmap/ic_launcher_round",
    );
  });

  test("draws every alternate alias with its own icon", () => {
    for (const alias of aliases.slice(1)) {
      const resource = attribute(alias, "name")?.replace(".icon.", "");
      expect(attribute(alias, "icon")).toBe(`@mipmap/${resource}`);
      expect(attribute(alias, "roundIcon")).toBe(`@mipmap/${resource}`);
    }
  });

  /**
   * An alias exists to carry a launcher icon and nothing more. Deep links
   * resolve through the always-enabled `.MainActivity`, so cloning its VIEW
   * filters onto 55 components would only multiply the App Links verification
   * surface.
   */
  test("gives every alias one MAIN/LAUNCHER filter and no deep links", () => {
    for (const alias of aliases) {
      const filters = intentFiltersOf(alias);
      expect(filters).toHaveLength(1);
      expect(filters[0]).toContain(LAUNCHER_ACTION);
      expect(filters[0]).toContain(LAUNCHER_CATEGORY);
      expect(filters[0]).not.toContain(VIEW_ACTION);
    }
  });

  /**
   * A launcher reads the static shortcuts off the component it launched, so the
   * long-press menu would empty out for whoever picked an alias without them.
   */
  test("clones MainActivity's shortcuts meta-data onto every alias", () => {
    const shortcuts = metaDataOf(mainActivity).filter((meta) =>
      meta.includes(SHORTCUTS_META_DATA_NAME),
    );
    expect(shortcuts).toHaveLength(1);
    for (const alias of aliases) {
      expect(metaDataOf(alias)).toEqual(shortcuts);
    }
  });
});

describe("MainActivity", () => {
  const mainActivity = mainActivityOf(committedManifest());

  /**
   * The generator owns the alias block and nothing else. Every alias targets
   * `.MainActivity`, and the static shortcuts, the voice notification, and the
   * Quick Settings tile all name its class explicitly, so it is enabled at all
   * times and stays hand-maintained outside the generated region.
   */
  test("stays the always-enabled target the generator never touches", () => {
    expect(attribute(mainActivity, "name")).toBe(".MainActivity");
    expect(attribute(mainActivity, "exported")).toBe("true");
    expect(openingTagOf(mainActivity)).not.toContain("android:enabled");
  });

  /** The launcher entry belongs to the aliases; a second one shows two icons. */
  test("declares no MAIN/LAUNCHER intent filter", () => {
    expect(
      intentFiltersOf(mainActivity).filter(
        (filter) =>
          filter.includes(LAUNCHER_ACTION) &&
          filter.includes(LAUNCHER_CATEGORY),
      ),
    ).toHaveLength(0);
  });

  /**
   * The aliases carry no VIEW filter, so deep links resolve through
   * `.MainActivity` alone and it has to keep at least one. How many it declares
   * is a deep-link concern rather than an icon one, and the generator itself
   * only enforces that they are still there.
   */
  test("keeps its deep-link filters", () => {
    expect(
      intentFiltersOf(mainActivity).filter((filter) =>
        filter.includes(VIEW_ACTION),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("keeps the static shortcuts meta-data", () => {
    expect(
      metaDataOf(mainActivity).filter((meta) =>
        meta.includes(SHORTCUTS_META_DATA_NAME),
      ),
    ).toHaveLength(1);
  });
});

/**
 * The alias block only holds up while `.MainActivity` keeps its side of the
 * split, and a manifest edit is the one thing that can break it, so rendering
 * refuses rather than emitting a block that silently drops an entry point.
 */
describe("rendering a MainActivity that broke the split", () => {
  const manifest = committedManifest();

  function withMutatedMainActivity(
    mutate: (element: string) => string,
  ): string {
    const element = mainActivityOf(manifest);
    return manifest.replace(element, () => mutate(element));
  }

  test("refuses a MainActivity that took the launcher entry back", () => {
    const mutated = withMutatedMainActivity((element) =>
      element.replace("<intent-filter>", () =>
        [
          "<intent-filter>",
          `                ${LAUNCHER_ACTION}`,
          `                ${LAUNCHER_CATEGORY}`,
          "            </intent-filter>",
          "",
          "            <intent-filter>",
        ].join("\n"),
      ),
    );
    expect(() =>
      renderManifestWithIconAliases(mutated, COMMITTED_SCOPE),
    ).toThrow(/MAIN\/LAUNCHER/);
  });

  test("refuses a MainActivity that lost its deep links", () => {
    const mutated = withMutatedMainActivity((element) =>
      element.replace(
        /[ \t]*<intent-filter(?:\s[^>]*)?>[\s\S]*?<\/intent-filter>/g,
        "",
      ),
    );
    expect(() =>
      renderManifestWithIconAliases(mutated, COMMITTED_SCOPE),
    ).toThrow(/deep-link VIEW intent filter/);
  });

  test("refuses a MainActivity that lost its shortcuts meta-data", () => {
    const mutated = withMutatedMainActivity((element) =>
      element.replace(/[ \t]*<meta-data\s[^>]*\/>/, ""),
    );
    expect(() =>
      renderManifestWithIconAliases(mutated, COMMITTED_SCOPE),
    ).toThrow(/android\.app\.shortcuts/);
  });
});
