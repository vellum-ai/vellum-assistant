/**
 * Tests for the SkillRow primitive.
 *
 * Mirrors the static-markup approach used by the Card primitive's tests:
 * we render to HTML via `react-dom/server` and assert on the resulting
 * markup. This keeps the suite isolated from RTL DOM cleanup ordering
 * (the workspace's bun test setup does not call `cleanup()` between
 * tests, so multiple RTL renders in the same file can bleed into each
 * other's queries).
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillRow } from "@/components/app/core/SkillRow/SkillRow.js";

describe("SkillRow", () => {
  test("renders title and subtitle", () => {
    const html = renderToStaticMarkup(
      createElement(SkillRow, { title: "Plan", subtitle: "Pro" }),
    );
    expect(html).toContain("Plan");
    expect(html).toContain("Pro");
  });

  test("renders the action slot when provided", () => {
    const html = renderToStaticMarkup(
      createElement(SkillRow, {
        title: "Plan",
        action: createElement("button", { type: "button" }, "Manage"),
      }),
    );
    expect(html).toContain("<button");
    expect(html).toContain("Manage");
  });

  test("omits the subtitle node when subtitle is not provided", () => {
    const html = renderToStaticMarkup(
      createElement(SkillRow, { title: "Plan" }),
    );
    expect(html).toContain("Plan");
    // No body-small-default span (only the title's body-medium-default).
    expect(html).not.toContain("text-body-small-default");
  });

  test("uses the surface-base background token", () => {
    const html = renderToStaticMarkup(
      createElement(SkillRow, { title: "Plan" }),
    );
    expect(html).toContain("bg-[var(--surface-base)]");
  });
});
