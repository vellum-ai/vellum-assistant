import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DocsSearchIndexFile } from "@/lib/docs/search/types";

const EMPTY_INDEX: DocsSearchIndexFile = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  chunks: [],
};

let cachedIndex: DocsSearchIndexFile | null = null;

function getIndexPath(): string {
  return process.env.DOCS_SEARCH_INDEX_PATH ?? join(process.cwd(), "public", "docs", "search-index.json");
}

export async function loadDocsSearchIndex(): Promise<DocsSearchIndexFile> {
  if (cachedIndex) {
    return cachedIndex;
  }

  try {
    const raw = await readFile(getIndexPath(), "utf8");
    const parsed = JSON.parse(raw) as DocsSearchIndexFile;

    if (!Array.isArray(parsed.chunks)) {
      cachedIndex = EMPTY_INDEX;
      return cachedIndex;
    }

    cachedIndex = parsed;
    return cachedIndex;
  } catch {
    cachedIndex = EMPTY_INDEX;
    return cachedIndex;
  }
}

export function resetDocsSearchIndexCache(): void {
  cachedIndex = null;
}
