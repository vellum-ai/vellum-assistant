/**
 * Contrast guard for the `--system-*-on-weak` glyph colours.
 *
 * WCAG 2.2 SC 1.4.11 (Non-text Contrast) requires 3:1 for graphical objects
 * such as status glyphs. Each `--system-*-on-weak` token is painted on its
 * matching `--system-*-weak` fill, so the pair has to clear 3:1 in every
 * theme. This file parses tokens.css itself rather than restating the
 * palette, so the assertions track the real source of truth.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIN_CONTRAST = 3;
const KNOWN_THEMES = ["light", "dark", "velvet"];
const TONES = ["positive", "negative"];

const css = readFileSync(join(import.meta.dir, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * Every top-level theme block, keyed by its `data-theme` value. The light
 * block is written as `:root,\n[data-theme="light"]`; the trailing bare
 * `:root` block holds typography tokens and is deliberately not matched.
 */
function parseThemes(source: string): Map<string, Record<string, string>> {
  const themes = new Map<string, Record<string, string>>();
  for (const match of source.matchAll(
    /^(?::root,\s*)?\[data-theme="([^"]+)"\]\s*\{/gm,
  )) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = source.indexOf("\n}", bodyStart);
    if (bodyEnd === -1) {
      throw new Error(`Unterminated theme block: ${match[1]}`);
    }
    const declarations: Record<string, string> = {};
    for (const declaration of source
      .slice(bodyStart, bodyEnd)
      .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      declarations[declaration[1]] = declaration[2].trim();
    }
    themes.set(match[1], declarations);
  }
  return themes;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    throw new Error(`Expected a 6-digit hex colour, got: ${hex}`);
  }
  const value = Number.parseInt(match[1], 16);
  const r = srgbToLinear(((value >> 16) & 0xff) / 255);
  const g = srgbToLinear(((value >> 8) & 0xff) / 255);
  const b = srgbToLinear((value & 0xff) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

const themes = parseThemes(css);

describe("system on-weak tokens", () => {
  // Exact rather than a superset, so adding a theme block forces an update
  // here and with it a look at the rows the loop below generates for it.
  test("tokens.css exposes exactly the known theme blocks", () => {
    expect([...themes.keys()].sort()).toEqual([...KNOWN_THEMES].sort());
  });

  for (const [theme, tokens] of themes) {
    for (const tone of TONES) {
      const glyph = `--system-${tone}-on-weak`;
      const fill = `--system-${tone}-weak`;
      test(`${theme} ${glyph} clears ${MIN_CONTRAST}:1 on ${fill}`, () => {
        expect(tokens[glyph]).toBeDefined();
        expect(
          contrastRatio(tokens[glyph], tokens[fill]),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      });
    }
  }

  // Contrast alone cannot catch this: an on-weak token left behind by an edit
  // to its -strong counterpart can still clear 3:1 while showing the wrong
  // colour next to every other use of that tone. The exception is derived
  // rather than listed, so a pairing only escapes the equality check while its
  // -strong tone genuinely fails on the -weak fill. Lighten a -weak fill until
  // -strong clears the floor and the pairing is held to equality again.
  test("each -on-weak token copies its -strong counterpart unless -strong fails", () => {
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const [theme, tokens] of themes) {
      for (const tone of TONES) {
        const strong = tokens[`--system-${tone}-strong`];
        const weak = tokens[`--system-${tone}-weak`];
        const onWeak = tokens[`--system-${tone}-on-weak`];
        const pairing = `${theme}:${tone}`;
        if (contrastRatio(strong, weak) >= MIN_CONTRAST) {
          actual[pairing] = onWeak;
          expected[pairing] = strong;
        } else {
          actual[pairing] = onWeak === strong ? "copies -strong" : "diverges";
          expected[pairing] = "diverges";
        }
      }
    }
    expect(actual).toEqual(expected);
  });
});
