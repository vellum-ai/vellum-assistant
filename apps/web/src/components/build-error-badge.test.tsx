import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildErrorBadge } from "@/components/app-viewer-container";

describe("BuildErrorBadge", () => {
  test("renders the last-working-version message", () => {
    const html = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["TS2322: type error"]} />,
    );
    expect(html).toContain("Build error");
    expect(html).toContain("showing last working version");
  });

  test("is overlaid and non-blocking so it never hides the iframe", () => {
    // The container is absolutely positioned and pointer-events-none, so the
    // last-good preview iframe behind it stays fully visible and interactive.
    const html = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["boom"]} />,
    );
    expect(html).toContain("absolute");
    expect(html).toContain("pointer-events-none");
  });

  test("offers a details affordance when buildErrors are present", () => {
    const withErrors = renderToStaticMarkup(
      <BuildErrorBadge buildErrors={["boom"]} />,
    );
    expect(withErrors).toContain("Details");

    const withoutErrors = renderToStaticMarkup(<BuildErrorBadge />);
    expect(withoutErrors).not.toContain("Details");
  });
});
