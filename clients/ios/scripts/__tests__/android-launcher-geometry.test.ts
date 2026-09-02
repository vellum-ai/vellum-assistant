/**
 * Drift guard for the Android launcher icon geometry.
 *
 * The quirky eye pair is duplicated by design across the avatar component
 * library and three Android launcher XMLs (the adaptive foreground plus the
 * two pre-adaptive fallbacks). Android resources cannot import TypeScript, so
 * the geometry is embedded verbatim and this test pins the copies to the
 * library: a change to the quirky eye style, or a hand edit to any one
 * launcher XML, fails here until every copy agrees again.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCharacterComponents } from "../../../../packages/avatar-catalog/src/index.js";

const ANDROID_RES = join(import.meta.dir, "../../../android/app/src/main/res");

const LAUNCHER_XMLS = [
  "drawable/ic_launcher_foreground.xml",
  "mipmap-anydpi/ic_launcher.xml",
  "mipmap-anydpi/ic_launcher_round.xml",
];

function extractEyePaths(xml: string): Array<{ fill: string; d: string }> {
  const paths: Array<{ fill: string; d: string }> = [];
  const pathTag = /<path\b[^>]*\/>/gs;
  for (const match of xml.match(pathTag) ?? []) {
    const fill = /android:fillColor="([^"]+)"/.exec(match)?.[1];
    const d = /android:pathData="([^"]+)"/.exec(match)?.[1];
    if (fill === undefined || d === undefined) {
      continue;
    }
    if (fill.startsWith("@color/")) {
      // The pre-adaptive launchers paint their own background path from the
      // flavor's launcher_background resource; only literal-color paths are
      // eye geometry.
      continue;
    }
    paths.push({ fill, d });
  }
  return paths;
}

describe("android launcher icon geometry", () => {
  const quirky = getCharacterComponents().eyeStyles.find(
    (style) => style.id === "quirky",
  );
  if (!quirky) {
    throw new Error("quirky eye style missing from the component library");
  }

  for (const relativePath of LAUNCHER_XMLS) {
    test(`${relativePath} embeds the library quirky paths verbatim`, () => {
      const xml = readFileSync(join(ANDROID_RES, relativePath), "utf8");
      const embedded = extractEyePaths(xml);
      expect(embedded.length).toBe(quirky.paths.length);
      for (const [index, libraryPath] of quirky.paths.entries()) {
        expect(embedded[index]?.d).toBe(libraryPath.svgPath);
        expect(embedded[index]?.fill).toBe(libraryPath.color);
      }
    });
  }
});

describe("android themed icon mask", () => {
  const quirky = getCharacterComponents().eyeStyles.find(
    (style) => style.id === "quirky",
  );
  if (!quirky) {
    throw new Error("quirky eye style missing from the component library");
  }

  test("ic_launcher_monochrome.xml embeds the two outer sclera paths verbatim", () => {
    const xml = readFileSync(
      join(ANDROID_RES, "drawable/ic_launcher_monochrome.xml"),
      "utf8",
    );
    const embedded = extractEyePaths(xml);
    const expected = [quirky.paths[0].svgPath, quirky.paths[3].svgPath];
    expect(embedded.length).toBe(expected.length);
    for (const [index, d] of expected.entries()) {
      expect(embedded[index]?.d).toBe(d);
    }
  });
});

describe("android launcher icon transforms", () => {
  const quirky = getCharacterComponents().eyeStyles.find(
    (style) => style.id === "quirky",
  );
  if (!quirky) {
    throw new Error("quirky eye style missing from the component library");
  }

  const GROUP_ATTRS = [
    "pivotX",
    "pivotY",
    "scaleX",
    "scaleY",
    "translateX",
    "translateY",
  ] as const;

  function extractTransform(relativePath: string): Record<string, string> {
    const xml = readFileSync(join(ANDROID_RES, relativePath), "utf8");
    const transform: Record<string, string> = {};
    for (const attr of GROUP_ATTRS) {
      const value = new RegExp(`android:${attr}="([^"]+)"`).exec(xml)?.[1];
      if (value === undefined) {
        throw new Error(`${relativePath} is missing android:${attr}`);
      }
      transform[attr] = value;
    }
    return transform;
  }

  const adaptive = extractTransform("drawable/ic_launcher_foreground.xml");
  const monochrome = extractTransform("drawable/ic_launcher_monochrome.xml");
  const legacy = extractTransform("mipmap-anydpi/ic_launcher.xml");
  const legacyRound = extractTransform("mipmap-anydpi/ic_launcher_round.xml");

  test("every launcher group pivots on the library eye center", () => {
    for (const transform of [adaptive, monochrome, legacy, legacyRound]) {
      expect(transform.pivotX).toBe(String(quirky.eyeCenter.x));
      expect(transform.pivotY).toBe(String(quirky.eyeCenter.y));
    }
  });

  test("the monochrome mask shares the adaptive foreground transform", () => {
    expect(monochrome).toEqual(adaptive);
  });

  test("both legacy fallbacks share one transform", () => {
    expect(legacyRound).toEqual(legacy);
  });

  test("every launcher group centers the pivot on the 108dp canvas", () => {
    // A VectorDrawable group maps the pivot to pivot + translate, so this sum
    // is the on-canvas position of the eye center and must be the canvas
    // center regardless of where the library puts eyeCenter.
    for (const transform of [adaptive, monochrome, legacy, legacyRound]) {
      expect(Number(transform.pivotX) + Number(transform.translateX)).toBe(54);
      expect(Number(transform.pivotY) + Number(transform.translateY)).toBe(54);
    }
  });

  test("scales are uniform and the legacy scale fills the unmasked canvas", () => {
    expect(adaptive.scaleY).toBe(adaptive.scaleX);
    expect(legacy.scaleY).toBe(legacy.scaleX);
    expect(legacy.translateX).toBe(adaptive.translateX);
    expect(legacy.translateY).toBe(adaptive.translateY);
    const adaptiveScale = Number(adaptive.scaleX);
    const legacyScale = Number(legacy.scaleX);
    // Legacy icons fill the full 108dp canvas while adaptive art targets the
    // 72dp a launcher mask reveals, so the scales differ by exactly 108/72.
    expect(legacyScale).toBeCloseTo(adaptiveScale * 1.5, 10);
  });
});
