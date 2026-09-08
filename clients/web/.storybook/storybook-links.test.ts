import { describe, expect, test } from "bun:test";

import {
  STORYBOOKS,
  resolveStorybookUrl,
  siblingOf,
  type StorybookId,
} from "@vellumai/design-library/storybook-links";

// The two Storybooks share one resolver, so this suite covers both toolbars.
// `packages/design-library` cannot host it: its vitest config declares only the
// `storybook` browser project, so a plain unit test there is never collected.

const at = (url: string) => {
  const { protocol, hostname, pathname } = new URL(url);
  return { protocol, hostname, pathname };
};

describe("siblingOf", () => {
  test("pairs the two Storybooks", () => {
    expect(siblingOf("web")).toBe("design-library");
    expect(siblingOf("design-library")).toBe("web");
  });
});

describe("resolveStorybookUrl", () => {
  const targets: StorybookId[] = ["design-library", "web"];

  test("swaps the prefix when served from the hosted bucket", () => {
    for (const target of targets) {
      expect(
        resolveStorybookUrl(
          target,
          at(`https://storybook.vellum.ai/${siblingOf(target)}/main/`),
        ),
      ).toBe(`/${target}/main/`);
    }
  });

  test("keeps the version segment", () => {
    expect(
      resolveStorybookUrl(
        "design-library",
        at("https://storybook.vellum.ai/web/0.3.0/"),
      ),
    ).toBe("/design-library/0.3.0/");
  });

  test("resolves from a deep path inside the hosted build", () => {
    expect(
      resolveStorybookUrl(
        "design-library",
        at("https://storybook.vellum.ai/web/main/iframe.html"),
      ),
    ).toBe("/design-library/main/");
  });

  test("points at the target's dev port on localhost", () => {
    for (const target of targets) {
      const port = STORYBOOKS[target].devPort;
      expect(resolveStorybookUrl(target, at("http://localhost:9999/"))).toBe(
        `http://localhost:${port}/`,
      );
      expect(resolveStorybookUrl(target, at("http://127.0.0.1:9999/"))).toBe(
        `http://127.0.0.1:${port}/`,
      );
    }
  });

  test("prefers the hosted prefix over the dev port when both could match", () => {
    expect(
      resolveStorybookUrl(
        "design-library",
        at("http://localhost:8099/web/main/"),
      ),
    ).toBe("/design-library/main/");
  });

  test("falls back to the hosted origin for an unrecognized location", () => {
    for (const target of targets) {
      expect(resolveStorybookUrl(target, at("https://example.com/"))).toBe(
        `https://storybook.vellum.ai/${target}/main/`,
      );
      expect(
        resolveStorybookUrl(target, {
          protocol: "file:",
          hostname: "",
          pathname: "/Users/dev/storybook-static/index.html",
        }),
      ).toBe(`https://storybook.vellum.ai/${target}/main/`);
    }
  });

  test("the two dev ports are distinct", () => {
    expect(STORYBOOKS["design-library"].devPort).not.toBe(
      STORYBOOKS.web.devPort,
    );
  });
});
