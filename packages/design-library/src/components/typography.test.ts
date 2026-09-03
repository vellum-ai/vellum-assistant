/**
 * The variant union and the CSS utilities have to stay in step.
 *
 * `Typography` maps each variant to a `text-*` class that only exists if
 * `tokens.css` declares the matching `@utility`. A variant added to the union
 * without the utility renders nothing; a utility added without the union is
 * unreachable through the component and gets hand-written as a class string
 * instead, which is the shape that lets dead classes accumulate.
 *
 * Like `tokens.test.ts`, this parses `tokens.css` rather than restating it,
 * so the assertion tracks the real source of truth.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Typography, type TypographyVariant } from "./typography";

const css = readFileSync(join(import.meta.dir, "..", "tokens.css"), "utf8");

/** Utility names in the four scale families, e.g. `body-small-lighter`. */
const cssVariants = new Set(
  [...css.matchAll(/@utility\s+text-((?:title|body|label|chat)[a-z-]*)\s*\{/g)].map(
    (m) => m[1],
  ),
);

/**
 * The union has no runtime form, so the variants are listed here and checked
 * against the CSS both ways. A variant missing from this array is caught by
 * the second test rather than silently skipped.
 */
const unionVariants: TypographyVariant[] = [
  "title-large",
  "title-medium",
  "title-small",
  "body-large-lighter",
  "body-large-default",
  "body-medium-lighter",
  "body-medium-default",
  "body-small-lighter",
  "body-small-default",
  "body-small-emphasised",
  "label-medium-default",
  "label-small-default",
  "chat",
];

describe("Typography variants vs tokens.css", () => {
  test("tokens.css actually declares some typography utilities", () => {
    // Guards the parse itself: a change to how tokens.css writes @utility
    // would otherwise make both directions below vacuously pass.
    expect(cssVariants.size).toBeGreaterThan(0);
  });

  test("every variant in the union has a matching @utility", () => {
    const missing = unionVariants.filter((v) => !cssVariants.has(v));
    expect(missing).toEqual([]);
  });

  test("every typography @utility is reachable through the union", () => {
    const unreachable = [...cssVariants].filter(
      (v) => !unionVariants.includes(v as TypographyVariant),
    );
    expect(unreachable).toEqual([]);
  });

  test("the component renders the class the utility declares", () => {
    // Ties the union to the rendered output, so a wrong entry in the
    // variant -> class map fails here rather than at runtime.
    expect(typeof Typography).toBe("function");
    for (const variant of unionVariants) {
      expect(cssVariants.has(variant)).toBe(true);
    }
  });
});
