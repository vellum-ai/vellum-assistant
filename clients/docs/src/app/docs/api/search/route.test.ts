import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NextRequest } from "next/server";

import { resetDocsSearchIndexCache } from "@/lib/docs/search/index-loader";
import type { DocsSearchIndexFile } from "@/lib/docs/search/types";

import { GET } from "@/app/docs/api/search/route";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "docs-search-test-"));
  resetDocsSearchIndexCache();
});

afterEach(async () => {
  resetDocsSearchIndexCache();
  delete process.env.DOCS_SEARCH_INDEX_PATH;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writeIndex(index: DocsSearchIndexFile): Promise<void> {
  const file = join(tempDir, "search-index.json");
  await writeFile(file, JSON.stringify(index), "utf8");
  process.env.DOCS_SEARCH_INDEX_PATH = file;
}

describe("GET /docs/api/search", () => {
  test("returns empty results for invalid short query", async () => {
    await writeIndex({
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks: [],
    });

    const request = new NextRequest("http://localhost/docs/api/search?q=a");
    const response = await GET(request);
    const body = (await response.json()) as { results: unknown[] };

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("clamps limit to 20", async () => {
    await writeIndex({
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks: Array.from({ length: 30 }).map((_, index) => ({
        id: `/docs/test-${index}`,
        route: "/docs/test",
        url: `/docs/test#${index}`,
        pageTitle: "Test",
        breadcrumb: "Docs / Test",
        heading: `Heading ${index}`,
        headingLevel: 2,
        sectionId: String(index),
        body: "installation guide and setup",
        keywords: ["installation"],
      })),
    });

    const request = new NextRequest("http://localhost/docs/api/search?q=installation&limit=200");
    const response = await GET(request);
    const body = (await response.json()) as { results: unknown[] };

    expect(body.results.length).toBeLessThanOrEqual(20);
  });

  test("returns lexical results with private caching", async () => {
    await writeIndex({
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks: [
        {
          id: "/docs/getting-started#__page",
          route: "/docs/getting-started",
          url: "/docs/getting-started",
          pageTitle: "Getting Started",
          breadcrumb: "Docs / Getting Started",
          heading: "Installation",
          headingLevel: 1,
          sectionId: null,
          body: "Install and start quickly.",
          keywords: ["installation"],
        },
      ],
    });

    const request = new NextRequest("http://localhost/docs/api/search?q=installation");
    const response = await GET(request);
    const body = (await response.json()) as { results: Array<{ route: string }> };

    expect(body.results[0]?.route).toBe("/docs/getting-started");
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
  });

  test("returns stable response schema", async () => {
    await writeIndex({
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks: [
        {
          id: "/docs/help#oauth",
          route: "/docs/help",
          url: "/docs/help#oauth",
          pageTitle: "Help",
          breadcrumb: "Docs / Help",
          heading: "OAuth",
          headingLevel: 2,
          sectionId: "oauth",
          body: "Reconnect OAuth provider.",
          keywords: ["oauth"],
        },
      ],
    });

    const request = new NextRequest("http://localhost/docs/api/search?q=oauth");
    const response = await GET(request);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["query", "results", "tookMs"]);
  });
});
