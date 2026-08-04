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
const PAIRS = [
  { glyph: "--system-positive-on-weak", fill: "--system-positive-weak" },
  { glyph: "--system-negative-on-weak", fill: "--system-negative-weak" },
];

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
  test("tokens.css exposes the known theme blocks", () => {
    expect([...themes.keys()]).toEqual(expect.arrayContaining(KNOWN_THEMES));
  });

  for (const [theme, tokens] of themes) {
    for (const { glyph, fill } of PAIRS) {
      test(`${theme} ${glyph} clears ${MIN_CONTRAST}:1 on ${fill}`, () => {
        expect(tokens[glyph]).toBeDefined();
        expect(
          contrastRatio(tokens[glyph], tokens[fill]),
        ).toBeGreaterThanOrEqual(MIN_CONTRAST);
      });
    }
  }

  test("dark --system-negative-on-weak stays divergent from --system-negative-strong", () => {
    const dark = themes.get("dark")!;
    // Do not "tidy up" this divergence: --system-negative-strong measures
    // 2.86:1 on the dark --system-negative-weak, under the 3:1 floor, which
    // is why the dark on-weak token is a lighter tone than the other themes'.
    expect(
      contrastRatio(
        dark["--system-negative-strong"],
        dark["--system-negative-weak"],
      ),
    ).toBeLessThan(MIN_CONTRAST);
    expect(dark["--system-negative-on-weak"]).not.toBe(
      dark["--system-negative-strong"],
    );
  });
});
