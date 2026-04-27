/**
 * Tests for the `memory_v2/validate` IPC route.
 *
 * The route is read-only — it walks `memory/concepts/<slug>.md` and
 * `memory/edges.json`, returning per-page parse failures, oversized pages,
 * and broken edge endpoints. We exercise three scenarios:
 *   1. clean workspace: zero violations across all categories.
 *   2. broken edges: an edge whose endpoint has no concept page surfaces under
 *      `missingEdgeEndpoints`.
 *   3. oversized page: a body exceeding `memory.v2.max_page_chars` surfaces
 *      under `oversizedPages` (we override the cap via a config.json fixture
 *      so the test stays small).
 *   4. parse failure: a concept page with malformed YAML frontmatter surfaces
 *      under `parseFailures` without aborting the rest of the report.
 *
 * Tests run against the per-file temp workspace set up by
 * `assistant/src/__tests__/test-preload.ts` (VELLUM_WORKSPACE_DIR points at a
 * mkdtemp dir). They never touch `~/.vellum/`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateConfigCache } from "../../../config/loader.js";
import { writeEdges } from "../../../memory/v2/edges.js";
import { writePage } from "../../../memory/v2/page-store.js";
import { getWorkspaceDir } from "../../../util/platform.js";
import { memoryV2ValidateRoute } from "../memory-v2-validate.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Cast the route result to the documented shape for ergonomic assertions. */
type ValidateResult = {
  pageCount: number;
  edgeCount: number;
  missingEdgeEndpoints: { from: string; to: string }[];
  oversizedPages: { slug: string; chars: number }[];
  parseFailures: { slug: string; error: string }[];
};

async function runRoute(
  params: Record<string, unknown> = {},
): Promise<ValidateResult> {
  return (await memoryV2ValidateRoute.handler(params)) as ValidateResult;
}

function workspace(): string {
  return getWorkspaceDir();
}

function memoryDir(): string {
  return join(workspace(), "memory");
}

/**
 * Write a `config.json` that overrides a specific config path. Mirrors what
 * the user's `~/.vellum/workspace/config.json` looks like in production. We
 * invalidate the loader cache after each write so the test sees fresh values.
 */
function writeWorkspaceConfig(json: Record<string, unknown>): void {
  mkdirSync(workspace(), { recursive: true });
  writeFileSync(
    join(workspace(), "config.json"),
    JSON.stringify(json, null, 2),
    "utf-8",
  );
  invalidateConfigCache();
}

// ---------------------------------------------------------------------------
// Test isolation — each test starts with a fresh memory/ tree under the
// per-file temp workspace, plus a clean config cache so loadConfig() picks up
// any fixture written below.
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(memoryDir(), { recursive: true, force: true });
  rmSync(join(workspace(), "config.json"), { force: true });
  invalidateConfigCache();
  mkdirSync(join(memoryDir(), "concepts"), { recursive: true });
});

afterEach(() => {
  rmSync(memoryDir(), { recursive: true, force: true });
  rmSync(join(workspace(), "config.json"), { force: true });
  invalidateConfigCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memoryV2ValidateRoute", () => {
  test("method is 'memory_v2/validate'", () => {
    expect(memoryV2ValidateRoute.method).toBe("memory_v2/validate");
  });

  test("rejects unknown params", async () => {
    await expect(runRoute({ extra: 1 })).rejects.toThrow();
  });

  test("clean workspace returns zero violations", async () => {
    await writePage(workspace(), {
      slug: "alice",
      frontmatter: { edges: ["bob"], ref_files: [] },
      body: "Alice prefers VS Code.",
    });
    await writePage(workspace(), {
      slug: "bob",
      frontmatter: { edges: ["alice"], ref_files: [] },
      body: "Bob prefers vim.",
    });
    await writeEdges(workspace(), {
      version: 1,
      edges: [["alice", "bob"]],
    });

    const result = await runRoute();

    expect(result.pageCount).toBe(2);
    expect(result.edgeCount).toBe(1);
    expect(result.missingEdgeEndpoints).toEqual([]);
    expect(result.oversizedPages).toEqual([]);
    expect(result.parseFailures).toEqual([]);
  });

  test("clean empty workspace reports zero of everything", async () => {
    const result = await runRoute();

    expect(result).toEqual({
      pageCount: 0,
      edgeCount: 0,
      missingEdgeEndpoints: [],
      oversizedPages: [],
      parseFailures: [],
    });
  });

  test("missing edge endpoint surfaces with both slugs", async () => {
    await writePage(workspace(), {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [] },
      body: "Alice page only.",
    });
    // `bob` is referenced by the edge but no concept page exists for it.
    await writeEdges(workspace(), {
      version: 1,
      edges: [["alice", "bob"]],
    });

    const result = await runRoute();

    expect(result.pageCount).toBe(1);
    expect(result.edgeCount).toBe(1);
    expect(result.missingEdgeEndpoints).toEqual([{ from: "alice", to: "bob" }]);
    expect(result.oversizedPages).toEqual([]);
    expect(result.parseFailures).toEqual([]);
  });

  test("oversized page surfaces under oversizedPages", async () => {
    // Override max_page_chars to a tiny value so we can exceed it cheaply
    // without writing a 5KB body. Weights are unchanged from defaults.
    writeWorkspaceConfig({
      memory: { v2: { max_page_chars: 32 } },
    });

    await writePage(workspace(), {
      slug: "tiny",
      frontmatter: { edges: [], ref_files: [] },
      body: "x".repeat(50),
    });
    await writePage(workspace(), {
      slug: "fits",
      frontmatter: { edges: [], ref_files: [] },
      body: "ok",
    });

    const result = await runRoute();

    expect(result.pageCount).toBe(2);
    expect(result.oversizedPages).toEqual([{ slug: "tiny", chars: 50 }]);
    expect(result.parseFailures).toEqual([]);
  });

  test("parse failure surfaces without aborting other categories", async () => {
    // Hand-write a page with malformed YAML in the frontmatter — readPage
    // will throw. The route must capture that and continue.
    writeFileSync(
      join(memoryDir(), "concepts", "broken.md"),
      "---\nedges: [unterminated\n---\nbody",
      "utf-8",
    );
    await writePage(workspace(), {
      slug: "ok",
      frontmatter: { edges: [], ref_files: [] },
      body: "Healthy page.",
    });
    // Edge points at the broken page so we also exercise the missing-endpoint
    // path: the broken page is not in `knownSlugs`, so the edge is reported.
    await writeEdges(workspace(), {
      version: 1,
      edges: [["broken", "ok"]],
    });

    const result = await runRoute();

    expect(result.pageCount).toBe(1);
    expect(result.edgeCount).toBe(1);
    expect(result.parseFailures).toHaveLength(1);
    expect(result.parseFailures[0]?.slug).toBe("broken");
    expect(result.parseFailures[0]?.error).toBeTruthy();
    expect(result.missingEdgeEndpoints).toEqual([{ from: "broken", to: "ok" }]);
  });
});
