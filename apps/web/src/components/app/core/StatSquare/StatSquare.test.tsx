/**
 * Tests for the StatSquare primitive — uses static-markup rendering so the
 * suite stays isolated from RTL DOM cleanup ordering. See `SkillRow.test.tsx`
 * for the rationale.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StatSquare } from "@/components/app/core/StatSquare/StatSquare.js";

describe("StatSquare", () => {
  test("renders value and label", () => {
    const html = renderToStaticMarkup(
      createElement(StatSquare, { value: "42", label: "Tokens" }),
    );
    expect(html).toContain("42");
    expect(html).toContain("Tokens");
  });

  test("applies the negative tone class to the value", () => {
    const html = renderToStaticMarkup(
      createElement(StatSquare, {
        value: "-0.04",
        label: "Balance",
        tone: "negative",
      }),
    );
    expect(html).toContain("--system-negative-strong");
  });

  test("applies the muted tone class to the value", () => {
    const html = renderToStaticMarkup(
      createElement(StatSquare, {
        value: "—",
        label: "Pending",
        tone: "muted",
      }),
    );
    expect(html).toContain("--content-tertiary");
  });

  test("uses the surface-base background token", () => {
    const html = renderToStaticMarkup(
      createElement(StatSquare, { value: "42", label: "Tokens" }),
    );
    expect(html).toContain("bg-[var(--surface-base)]");
  });
});
