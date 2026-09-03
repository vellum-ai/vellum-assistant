import { describe, expect, test } from "bun:test";

import { resolveSiblingStorybookUrl } from "./sibling-storybook";

const at = (url: string) => {
  const { protocol, hostname, pathname } = new URL(url);
  return { protocol, hostname, pathname };
};

describe("resolveSiblingStorybookUrl", () => {
  test("swaps the prefix when served from the hosted bucket", () => {
    expect(
      resolveSiblingStorybookUrl(at("https://storybook.vellum.ai/web/main/")),
    ).toBe("/design-library/main/");
  });

  test("keeps the version segment", () => {
    expect(
      resolveSiblingStorybookUrl(at("https://storybook.vellum.ai/web/0.3.0/")),
    ).toBe("/design-library/0.3.0/");
  });

  test("resolves from a deep path inside the hosted build", () => {
    expect(
      resolveSiblingStorybookUrl(
        at("https://storybook.vellum.ai/web/main/iframe.html"),
      ),
    ).toBe("/design-library/main/");
  });

  test("points at the sibling dev port on localhost", () => {
    expect(resolveSiblingStorybookUrl(at("http://localhost:6007/"))).toBe(
      "http://localhost:6006/",
    );
    expect(resolveSiblingStorybookUrl(at("http://127.0.0.1:6007/"))).toBe(
      "http://127.0.0.1:6006/",
    );
  });

  test("prefers the hosted prefix over the dev port when both could match", () => {
    expect(
      resolveSiblingStorybookUrl(at("http://localhost:8099/web/main/")),
    ).toBe("/design-library/main/");
  });

  test("falls back to the hosted origin for an unrecognized location", () => {
    expect(resolveSiblingStorybookUrl(at("https://example.com/"))).toBe(
      "https://storybook.vellum.ai/design-library/main/",
    );
    expect(
      resolveSiblingStorybookUrl({
        protocol: "file:",
        hostname: "",
        pathname: "/Users/dev/storybook-static/index.html",
      }),
    ).toBe("https://storybook.vellum.ai/design-library/main/");
  });
});
