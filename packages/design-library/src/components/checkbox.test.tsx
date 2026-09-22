/**
 * Tests for the Checkbox primitive.
 *
 * No DOM environment: assert the HTML the component emits so the
 * unchecked box keeps a visible field fill and element border.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Checkbox } from "./checkbox";

describe("Checkbox rendering", () => {
  test("unchecked box uses field fill and tertiary border", () => {
    const html = renderToStaticMarkup(
      <Checkbox
        checked={false}
        label="Mark this address verified"
        onCheckedChange={() => {}}
      />,
    );

    expect(html).toContain("bg-[var(--field-bg)]");
    expect(html).toContain("border-2");
    expect(html).toContain("border-[var(--content-tertiary)]");
    expect(html).not.toContain("border-[var(--border-base)]");
    expect(html).toContain("Mark this address verified");
  });

  test("checked box keeps the primary fill", () => {
    const html = renderToStaticMarkup(
      <Checkbox checked label="Verified" onCheckedChange={() => {}} />,
    );

    expect(html).toContain("data-[state=checked]:bg-[var(--primary-active)]");
  });
});
