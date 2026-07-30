import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { extractDocsPageFromHtml } from "../src/lib/docs/search/extract";
import type { DocsSearchChunk, DocsSearchIndexFile } from "../src/lib/docs/search/types";
import { listPageFiles, loadPageModule, renderPage, routeFromPageFile } from "./lib/docs-pages";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
// Crawl the entire /docs subtree. Any Next route group living under docs/
// (currently (documentation), (releases)) gets its pages indexed. Route-group
// segments live in parentheses and do not affect the URL, so we strip them
// when deriving the route. The api/ subtree holds route handlers, not pages.
const DOCS_PAGES_ROOT = join(ROOT, "src", "app", "docs");
const API_SUBTREE = join(DOCS_PAGES_ROOT, "api") + sep;
const OUTPUT_PATH = join(ROOT, "public", "docs", "search-index.json");

interface GeneratedIndex {
  index: DocsSearchIndexFile;
  pageCount: number;
  skippedRoutes: string[];
}

async function generateIndex(): Promise<GeneratedIndex> {
  const pageFiles = (await listPageFiles(DOCS_PAGES_ROOT))
    .filter((pageFile) => !pageFile.startsWith(API_SUBTREE))
    .sort();
  const chunks: DocsSearchChunk[] = [];
  const skippedRoutes: string[] = [];
  let pageCount = 0;

  for (const pageFile of pageFiles) {
    const route = routeFromPageFile(pageFile, DOCS_PAGES_ROOT, "/docs");

    // Request-time pages (e.g. /docs/releases) serve content fetched per
    // request, so there is nothing stable to index at build time.
    const pageModule = await loadPageModule(pageFile);
    if (pageModule.dynamic === "force-dynamic") {
      skippedRoutes.push(`${route} (force-dynamic)`);
      continue;
    }

    const rendered = await renderPage(pageFile);
    if (!rendered) {
      skippedRoutes.push(`${route} (redirect)`);
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
