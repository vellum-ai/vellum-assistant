/**
 * Parity guard between the JS hover-capability query and the reveal rules in
 * `tokens.css`.
 *
 * A primitive that drops a hover-only surface in JS and CSS that stands a
 * hover-only affordance down have to switch on the same condition. Two copies
 * of it drift silently, and the failure is invisible on a development machine
 * because it only shows on a device that cannot hover. `reveal.test.ts` owns
 * the shape of those blocks; this file only pins that the constant names the
 * same condition one of them does.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HOVER_ABSENT_MEDIA_QUERY } from "./hover-capability";

/** Comments stripped, so a `@media` inside a doc link is never read as one. */
const css = readFileSync(
  join(import.meta.dir, "..", "tokens.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("HOVER_ABSENT_MEDIA_QUERY", () => {
  test("matches the hoverless reveal block's media condition", () => {
    const conditions = [...css.matchAll(/@media([^{]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((condition) => condition.includes("hover: none"));

    expect(conditions).toEqual([HOVER_ABSENT_MEDIA_QUERY]);
  });

  /* The two halves have to partition the devices between them: a condition
     that narrowed on one side without the other would leave a device getting
     neither the revealed affordance nor the substitute. */
  test("is the exact inverse of the hover reveal block's condition", () => {
    const conditions = [...css.matchAll(/@media([^{]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((condition) => condition.includes("hover: hover"));

    expect(conditions).toEqual([
      HOVER_ABSENT_MEDIA_QUERY.replace("none", "hover"),
    ]);
  });
});
