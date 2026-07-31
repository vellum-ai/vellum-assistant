import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverDocsPages,
  REDIRECT_STUB_ROUTES,
} from "../src/lib/discover-docs-routes";
import { extractDocsPageFromHtml } from "../src/lib/docs/search/extract";
import type { DocsSearchChunk, DocsSearchIndexFile } from "../src/lib/docs/search/types";
import { loadPageModule, renderPage } from "./lib/docs-pages";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DOCS_PAGES_ROOT = join(ROOT, "src", "app", "docs");
const OUTPUT_PATH = join(ROOT, "public", "docs", "search-index.json");

interface GeneratedIndex {
  index: DocsSearchIndexFile;
  pageCount: number;
  skippedRoutes: string[];
}

async function generateIndex(): Promise<GeneratedIndex> {
  const chunks: DocsSearchChunk[] = [];
  const skippedRoutes: string[] = [];
  let pageCount = 0;

  for (const { pageFile, route } of discoverDocsPages(DOCS_PAGES_ROOT)) {
    // Redirect stubs carry no content of their own; their targets are indexed.
    if (REDIRECT_STUB_ROUTES.has(route)) {
      skippedRoutes.push(`${route} (redirect stub)`);
      continue;
    }

    // Request-time pages (e.g. /docs/releases) serve content fetched per
    // request, so there is nothing stable to index at build time.
    const pageModule = await loadPageModule(pageFile);
    if (pageModule.dynamic === "force-dynamic") {
      skippedRoutes.push(`${route} (force-dynamic)`);
      continue;
    }

    const rendered = await renderPage(pageFile);
    if (!rendered) {
      skippedRoutes.push(`${route} (suspended request-time page)`);
      continue;
    }

    chunks.push(...extractDocsPageFromHtml(route, rendered.html));
    pageCount += 1;
  }

  return {
    index: {
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks,
    },
    pageCount,
    skippedRoutes,
  };
}

async function main() {
  const { index, pageCount, skippedRoutes } = await generateIndex();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  for (const skipped of skippedRoutes) {
    console.log(`[docs-search] Skipped ${skipped}`);
  }
  console.log(
    `[docs-search] Indexed ${pageCount} pages into ${index.chunks.length} chunks -> ${OUTPUT_PATH}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : "unknown error";
  console.error(`[docs-search] Failed to generate docs index: ${message}`);
  process.exitCode = 1;
});
