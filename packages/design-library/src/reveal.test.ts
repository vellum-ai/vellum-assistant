/**
 * Guard on the one invariant the reveal rules in `tokens.css` exist to hold: a
 * control is only ever hidden where the device can hover to bring it back.
 *
 * `hover` and `pointer` are independent media features and neither follows from
 * viewport width, so a control hidden outside `@media (hover: hover)` is a
 * control some real device (an iPad in landscape reports `hover: none` at
 * 1024px) cannot reach at all. That failure is invisible on a development
 * machine, which is why it is asserted here rather than reviewed.
 *
 * https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
 * https://www.w3.org/WAI/WCAG22/Understanding/pointer-gestures.html
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments stripped, so a selector never carries the prose above it. */
const css = readFileSync(join(import.meta.dir, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The top-level `@media` blocks, as `[condition, body]` pairs. */
function mediaBlocks(source: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = [];
  const pattern = /@media([^{]+)\{/g;

  let match = pattern.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;

    while (depth > 0 && index < source.length) {
      if (source[index] === "{") {
        depth += 1;
      } else if (source[index] === "}") {
        depth -= 1;
      }
      index += 1;
    }

    blocks.push({
      condition: match[1].trim(),
      body: source.slice(start, index - 1),
    });
    pattern.lastIndex = index;
    match = pattern.exec(source);
  }

  return blocks;
}

/** Selectors in `body` whose declaration block hides what it matches. */
function hidingSelectors(body: string): string[] {
  const hiding: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;

  let match = pattern.exec(body);
  while (match !== null) {
    const declarations = match[2];
    if (/opacity:\s*0\s*(;|$)/.test(declarations)) {
      hiding.push(match[1].replace(/\s+/g, " ").trim());
    }
    match = pattern.exec(body);
  }

  return hiding;
}

/** Selectors of the rules `body` holds directly, ignoring anything nested. */
function topLevelSelectors(body: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let text = "";

  for (const character of body) {
    if (character === "{") {
      if (depth === 0) {
        selectors.push(text.replace(/\s+/g, " ").trim());
      }
      depth += 1;
      text = "";
    } else if (character === "}") {
      depth -= 1;
      text = "";
    } else if (depth === 0) {
      text += character;
    }
  }

  return selectors;
}

describe("hover reveal", () => {
  test("hides a reveal affordance only where the device can hover", () => {
    const offenders = mediaBlocks(css)
      .filter(({ condition }) => !condition.includes("hover: hover"))
      .flatMap(({ condition, body }) =>
        hidingSelectors(body)
          .filter((selector) => /\[data-reveal\]/.test(selector))
          .map((selector) => `@media ${condition} { ${selector} }`),
      );

    expect(offenders).toEqual([]);
  });

  /* Two condition lists, one for the affordance and an inverse one for the
     occupant sharing its slot, drift: a condition added to one side leaves both
     painted in the same cell. One condition owning both states cannot. */
  test("reveals the affordance and stands the occupant down on one condition", () => {
    const hover = mediaBlocks(css).filter(({ condition }) =>
      condition.includes("hover: hover"),
    );

    expect(hover).toHaveLength(1);
    expect(topLevelSelectors(hover[0].body)).toHaveLength(1);
    expect(hover[0].body).toContain("[data-reveal]");
    expect(hover[0].body).toContain("[data-reveal-yield]");
  });

  /* `:has()` reached Safari in 15.4, so a rule keyed on it is dropped whole by
     the WKWebView on an iOS 15.0 device. Where hover is unavailable that rule is
     the one bringing a yielding occupant back, and losing it hides the occupant
     on exactly the devices the block exists for. */
  test("restores the yielding occupant without asking `:has()`", () => {
    const hoverless = mediaBlocks(css).filter(({ condition }) =>
      condition.includes("hover: none"),
    );

    expect(hoverless).toHaveLength(1);
    expect(hoverless[0].body).toContain("[data-reveal-yield]");
    expect(hoverless[0].body).not.toContain(":has(");
  });

  /* The base rule outside any media query, which is what makes the affordance
     visible by default and the yielding occupant the hidden one. */
  test("hides the yielding occupant by default, not the affordance", () => {
    const base = css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const hidden = hidingSelectors(base);

    expect(hidden).toContain("[data-reveal-yield]");
    expect(hidden).not.toContain("[data-reveal]");
  });
});
