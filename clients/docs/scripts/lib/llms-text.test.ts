import { describe, expect, test } from "bun:test";

import { buildLlmsText } from "./llms-text";

describe("buildLlmsText", () => {
  test("lists pages sorted by route with .md URLs and descriptions", () => {
    const text = buildLlmsText([
      {
        route: "/docs/pricing",
        title: "Pricing",
        description: "Vellum pricing",
      },
      {
        route: "/docs/getting-started",
        title: "Getting Started",
        description: "Install Vellum",
      },
    ]);

    const bullets = text
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(bullets).toEqual([
      "- [Getting Started](https://www.vellum.ai/docs/getting-started.md): Install Vellum",
      "- [Pricing](https://www.vellum.ai/docs/pricing.md): Vellum pricing",
    ]);
  });

  test("maps the docs index route to index.md and omits empty descriptions", () => {
    const text = buildLlmsText([
      { route: "/docs", title: "Vellum Docs", description: "" },
    ]);

    expect(text).toContain("- [Vellum Docs](https://www.vellum.ai/docs/index.md)");
    expect(text).not.toContain("index.md):");
  });

  test("starts with the header and ends with a single trailing newline", () => {
    const text = buildLlmsText([]);

    expect(text.startsWith("# Vellum Docs\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  test("throws for a route outside /docs", () => {
    expect(() =>
      buildLlmsText([{ route: "/blog/post", title: "Post", description: "" }]),
    ).toThrow("No markdown alternate path");
  });
});
