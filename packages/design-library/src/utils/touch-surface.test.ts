/**
 * Parity guard between the JS touch-surface query and the `touch-mobile`
 * Tailwind variant.
 *
 * A surface that CSS hides and JS replaces has to switch at one width and one
 * pointer kind. Two copies of the condition drift silently: the CSS half moves
 * with a design change, the JS half stays, and there is a viewport where the
 * old surface is hidden and the new one has not taken over. This test parses
 * the variant out of `tokens.css` so the CSS remains the single definition.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOUCH_SURFACE_MEDIA_QUERY } from "./touch-surface";

const css = readFileSync(join(import.meta.dir, "..", "tokens.css"), "utf8");

describe("TOUCH_SURFACE_MEDIA_QUERY", () => {
  test("matches the touch-mobile variant's media condition", () => {
    const variant = css.match(
      /@custom-variant\s+touch-mobile\s*\{\s*@media\s+([^{]+)\{/,
    );
    expect(variant).not.toBeNull();

    const condition = variant?.[1].trim();
    expect(condition).toBe(TOUCH_SURFACE_MEDIA_QUERY);
  });
});
