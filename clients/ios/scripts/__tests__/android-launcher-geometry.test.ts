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

import { getCharacterComponents } from "../../../../assistant/src/avatar/character-components.js";

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
