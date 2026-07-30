import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import sitemap from "@/app/docs/sitemap";
import {
  discoverDocsPages,
  discoverDocsRoutes,
  REDIRECT_STUB_ROUTES,
} from "@/lib/discover-docs-routes";

const DOCS_APP_DIR = path.join(process.cwd(), "src", "app", "docs");

/**
 * Independently counts routable page.tsx files, applying the same exclusions
 * the discovery walk documents: dynamic segments, private folders (both `_`
 * and URL-encoded `%5F` prefixes), and the api subtree directly under /docs.
 */
function countPageFiles(dir: string, atDocsRoot: boolean): number {
  let count = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (entry.name === "page.tsx" || entry.name === "page.ts")
    ) {
      count += 1;
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }
    if (
      entry.name.startsWith("[") ||
      entry.name.startsWith("_") ||
      entry.name.toLowerCase().startsWith("%5f")
    ) {
      continue;
    }
    if (atDocsRoot && entry.name === "api") {
      continue;
    }

    const isRouteGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
    count += countPageFiles(
      path.join(dir, entry.name),
      atDocsRoot && isRouteGroup,
    );
  }

  return count;
}

describe("discoverDocsRoutes", () => {
  const routes = discoverDocsRoutes();

  test("discovers one route per routable page.tsx file", () => {
    expect(routes.length).toBe(countPageFiles(DOCS_APP_DIR, true));
  });

  test("includes known routes at every depth", () => {
    expect(routes).toContain("/docs");
    expect(routes).toContain("/docs/pricing");
    expect(routes).toContain("/docs/releases");
    expect(routes).toContain("/docs/skills-reference/computer-use");
    expect(routes).toContain("/docs/key-concepts/web-search/perplexity");
  });

  test("strips route groups from URLs", () => {
    for (const route of routes) {
      expect(route).not.toContain("(");
      expect(route).not.toContain(")");
    }
  });

  test("returns unique routes", () => {
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("discoverDocsPages", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-discovery-"));

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function addPage(...segments: string[]): void {
    const dir = path.join(fixtureRoot, ...segments);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "page.tsx"), "export default () => null;");
  }

  addPage();
  addPage("(group)", "guide");
  addPage("api");
  addPage("api", "nested");
  addPage("_private");
  addPage("%5Fencoded");
  addPage("[slug]");

  const pages = discoverDocsPages(fixtureRoot);

  test("pairs each route with its on-disk page file", () => {
    expect(pages).toEqual([
      { pageFile: path.join(fixtureRoot, "page.tsx"), route: "/docs" },
      {
        pageFile: path.join(fixtureRoot, "(group)", "guide", "page.tsx"),
        route: "/docs/guide",
      },
    ]);
  });

  test("excludes the api subtree, private folders, %5F-encoded folders, and dynamic segments", () => {
    const routes = pages.map((page) => page.route);
    expect(routes).not.toContain("/docs/api");
    expect(routes).not.toContain("/docs/api/nested");
    expect(routes).not.toContain("/docs/_private");
    expect(routes).not.toContain("/docs/%5Fencoded");
    expect(routes).not.toContain("/docs/_encoded");
  });

  test("every page file discovered in the real docs tree exists on disk", () => {
    const realPages = discoverDocsPages();
    expect(realPages.length).toBeGreaterThan(0);
    for (const { pageFile } of realPages) {
      expect(fs.existsSync(pageFile)).toBe(true);
    }
  });
});

describe("docs sitemap", () => {
  const entries = sitemap();

  test("lists every discovered route except redirect stubs", () => {
    const expected = discoverDocsRoutes().filter(
      (route) => !REDIRECT_STUB_ROUTES.has(route),
    );
    expect(entries.map((entry) => entry.url)).toEqual(
      expected.map((route) => `https://www.vellum.ai${route}`),
    );
  });

  test("excludes the key-concepts redirect stub", () => {
    expect(discoverDocsRoutes()).toContain("/docs/getting-started/key-concepts");
    expect(entries.map((entry) => entry.url)).not.toContain(
      "https://www.vellum.ai/docs/getting-started/key-concepts",
    );
  });

  test("marks every entry weekly", () => {
    for (const entry of entries) {
      expect(entry.changeFrequency).toBe("weekly");
    }
  });
});
