/**
 * Tests for the memory v2 route handlers in `memory-v2-routes.ts`.
 *
 * Currently focused on `memory_v2_list_concept_pages`:
 *   - empty workspace → returns no pages
 *   - populated workspace → surfaces slug, bodyBytes, edgeCount, updatedAtMs
 *   - corrupt page on disk → logged-and-skipped, does not poison listing
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { writePage } from "../../../memory/v2/page-store.js";
import type { ConceptPage } from "../../../memory/v2/types.js";
import type { MemoryV2ListConceptPagesResult } from "../memory-v2-routes.js";
import { ROUTES } from "../memory-v2-routes.js";
import type { RouteDefinition } from "../types.js";

// ─── Setup ─────────────────────────────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memv2-list-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("memory_v2_list_concept_pages handler", () => {
  test("returns empty list for an empty workspace", async () => {
    const handler = findHandler("memory_v2_list_concept_pages");
    const result = (await handler({
      body: {},
    })) as MemoryV2ListConceptPagesResult;

    expect(result).toEqual({ pages: [] });
  });

  test("returns slugs, body bytes, edge counts, and mtimes for populated workspace", async () => {
    const before = Date.now();

    const pages: ConceptPage[] = [
      {
        slug: "alice",
        frontmatter: { edges: ["bob", "carol"], ref_files: [], ref_urls: [] },
        body: "Alice prefers VS Code.\n",
      },
      {
        slug: "bob",
        frontmatter: { edges: [], ref_files: [], ref_urls: [] },
        body: "Bob ships at end of day.\nLikes async standups.\n",
      },
      {
        slug: "people/carol",
        frontmatter: { edges: ["alice"], ref_files: [], ref_urls: [] },
        body: "Carol leads the platform team.\n",
      },
    ];
    for (const page of pages) {
      await writePage(workspaceDir, page);
    }

    const handler = findHandler("memory_v2_list_concept_pages");
    const result = (await handler({
      body: {},
    })) as MemoryV2ListConceptPagesResult;

    expect(result.pages).toHaveLength(3);

    const bySlug = new Map(result.pages.map((p) => [p.slug, p]));

    const alice = bySlug.get("alice");
    expect(alice).toBeDefined();
    expect(alice!.bodyBytes).toBe(Buffer.byteLength(pages[0]!.body, "utf8"));
    expect(alice!.edgeCount).toBe(2);
    expect(alice!.updatedAtMs).toBeGreaterThanOrEqual(before);
    // updatedAtMs must be an integer on the wire — Swift clients decode it as
    // Int64 and a sub-millisecond float (which fs.Stats.mtimeMs returns by
    // default) breaks JSONDecoder strict number parsing.
    expect(Number.isInteger(alice!.updatedAtMs)).toBe(true);

    const bob = bySlug.get("bob");
    expect(bob).toBeDefined();
    expect(bob!.bodyBytes).toBe(Buffer.byteLength(pages[1]!.body, "utf8"));
    expect(bob!.edgeCount).toBe(0);
    expect(bob!.updatedAtMs).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(bob!.updatedAtMs)).toBe(true);

    const carol = bySlug.get("people/carol");
    expect(carol).toBeDefined();
    expect(carol!.bodyBytes).toBe(Buffer.byteLength(pages[2]!.body, "utf8"));
    expect(carol!.edgeCount).toBe(1);
    expect(carol!.updatedAtMs).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(carol!.updatedAtMs)).toBe(true);
  });

  test("tolerates a single corrupt page — returns valid pages and skips the broken one", async () => {
    await writePage(workspaceDir, {
      slug: "valid-page",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "Body of the valid page.\n",
    });

    // A `.md` file with frontmatter that fails schema validation — `edges`
    // must be a list of strings, not a single number — so `readPage` throws.
    const conceptsDir = join(workspaceDir, "memory", "concepts");
    await mkdir(conceptsDir, { recursive: true });
    await writeFile(
      join(conceptsDir, "broken.md"),
      "---\nedges: 42\n---\nbroken body\n",
      "utf-8",
    );

    const handler = findHandler("memory_v2_list_concept_pages");
    const result = (await handler({
      body: {},
    })) as MemoryV2ListConceptPagesResult;

    expect(result.pages).toHaveLength(1);
    expect(result.pages.map((p) => p.slug)).toEqual(["valid-page"]);
  });
});
