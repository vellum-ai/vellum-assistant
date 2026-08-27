/**
 * Drift guard for the iOS default app icon geometry.
 *
 * The quirky eye pair is duplicated by design between the avatar component
 * library, the three Icon Composer bundles, and the widget extension's asset
 * catalog, which draws the app's mark on the New Chat surfaces; asset catalogs
 * cannot import TypeScript, so the geometry is embedded verbatim and this test
 * pins the copies to the library. A change to the quirky eye style, or a hand
 * edit to any one copy's SVG, fails here until every copy agrees again.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCharacterComponents } from "../../../../assistant/src/avatar/character-components.js";

const IOS_APP_DIR = join(import.meta.dir, "../../App");

const EYE_SVGS = [
  "App/AppIcon.icon/Assets/eyes.svg",
  "App/AppIcon-Dev.icon/Assets/eyes.svg",
  "App/AppIcon-Staging.icon/Assets/eyes.svg",
  // The widget extension draws the same mark on its New Chat surfaces.
  "VoiceActivity/Assets.xcassets/VellumAppIconEyes.imageset/eyes.svg",
];

function extractPaths(svg: string): Array<{ fill: string; d: string }> {
  const paths: Array<{ fill: string; d: string }> = [];
  const pathTag = /<path\b[^>]*\/>/gs;
  for (const match of svg.match(pathTag) ?? []) {
    const fill = /fill="([^"]+)"/.exec(match)?.[1];
    const d = /\bd="([^"]+)"/.exec(match)?.[1];
    if (fill !== undefined && d !== undefined) {
      paths.push({ fill, d });
    }
  }
  return paths;
}

describe("ios default icon geometry", () => {
  const quirky = getCharacterComponents().eyeStyles.find(
    (style) => style.id === "quirky",
  );
  if (!quirky) {
    throw new Error("quirky eye style missing from the component library");
  }

  const contents = EYE_SVGS.map((relativePath) =>
    readFileSync(join(IOS_APP_DIR, relativePath), "utf8"),
  );

  test("every copy of eyes.svg is the same file byte for byte", () => {
    for (const [index, copy] of contents.entries()) {
      if (index === 0) {
        continue;
      }
      expect(copy).toBe(contents[0]);
    }
  });

  test("eyes.svg embeds the library quirky paths verbatim", () => {
    const embedded = extractPaths(contents[0]);
    expect(embedded.length).toBe(quirky.paths.length);
    for (const [index, libraryPath] of quirky.paths.entries()) {
      expect(embedded[index]?.d).toBe(libraryPath.svgPath);
      expect(embedded[index]?.fill).toBe(libraryPath.color);
    }
  });

  test("eyes.svg keeps the library source viewBox", () => {
    const { width, height } = quirky.sourceViewBox;
    expect(contents[0]).toContain(
      `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    );
  });
});
