/**
 * Tests for `assistant/src/memory/v3/edges.ts` — the curated edge-expansion
 * lane.
 *
 * Coverage matrix:
 *   - 1-hop and 2-hop outgoing expansion from a single seed.
 *   - Default hops (2) when omitted.
 *   - Seed excluded from its own `pulled`.
 *   - Multiple seeds: top-level `pulled` is the union; per-seed expansions
 *     attribute correctly; duplicate seeds collapse.
 *   - `extraAdjacency` merges with the curated graph during traversal.
 *   - `extraAdjacency` bridges across hops (curated → extra → curated).
 *   - Cycles in the curated graph (and via extraAdjacency) terminate, bounded
 *     by hops + the visited set.
 *   - Empty seeds / orphan seed → empty result.
 *   - Provider-free: the only I/O is reading fixture concept pages.
 *
 * Tests live in temp workspaces (mkdtemp) and never touch `~/.vellum/`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateEdgeIndex } from "../../v2/edge-index.js";
import { writePage } from "../../v2/page-store.js";
import type { ConceptPage } from "../../v2/types.js";
import { expandEdges } from "../edges.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memory-v3-edges-"));
});

afterEach(() => {
  // The v2 edge index caches module-locally; clear it so the next test's fresh
  // workspace doesn't read a stale snapshot.
  invalidateEdgeIndex();
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makePage(slug: string, edges: string[] = []): ConceptPage {
  return {
    slug,
    frontmatter: { edges, ref_files: [], ref_urls: [] },
    body: "",
  };
}

/** Write a small chain/graph of pages by `{ slug: edges }` map. */
async function writeGraph(graph: Record<string, string[]>): Promise<void> {
  for (const [slug, edges] of Object.entries(graph)) {
    await writePage(workspaceDir, makePage(slug, edges));
  }
}

// ---------------------------------------------------------------------------
// Single-seed expansion
// ---------------------------------------------------------------------------

describe("expandEdges — single seed", () => {
  test("1-hop expansion pulls only direct out-neighbors", async () => {
    // alice -> bob -> carol
    await writeGraph({ alice: ["bob"], bob: ["carol"], carol: [] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 1,
    });

    expect([...pulled].sort()).toEqual(["bob"]);
    expect(expansions).toEqual([{ from: "alice", pulled: ["bob"] }]);
  });

  test("2-hop expansion pulls the 2-hop frontier", async () => {
    // alice -> bob -> carol
    await writeGraph({ alice: ["bob"], bob: ["carol"], carol: [] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
    });

    expect([...pulled].sort()).toEqual(["bob", "carol"]);
    expect(expansions).toEqual([{ from: "alice", pulled: ["bob", "carol"] }]);
  });

  test("defaults to 2 hops when hops is omitted", async () => {
    await writeGraph({ alice: ["bob"], bob: ["carol"], carol: ["dave"] });

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
    });

    // 2-hop reach from alice: bob (1) + carol (2); dave (3) is out of budget.
    expect([...pulled].sort()).toEqual(["bob", "carol"]);
  });

  test("excludes the seed itself from pulled", async () => {
    // Self-referential-ish: a -> b -> a would put `a` back in reach, but the
    // seed must never appear in its own pulled set.
    await writeGraph({ alice: ["bob"], bob: ["alice"] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
    });

    expect(pulled.has("alice")).toBe(false);
    expect([...pulled].sort()).toEqual(["bob"]);
    expect(expansions[0]!.pulled).not.toContain("alice");
  });

  test("orphan seed (no outgoing edges) yields an empty expansion", async () => {
    await writeGraph({ alice: [] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
    });

    expect(pulled.size).toBe(0);
    expect(expansions).toEqual([{ from: "alice", pulled: [] }]);
  });

  test("edges are directed — incoming neighbors are never pulled", async () => {
    // bob -> alice. Seeding alice must NOT pull bob (that's an in-edge).
    await writeGraph({ bob: ["alice"], alice: [] });

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
    });

    expect(pulled.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple seeds
// ---------------------------------------------------------------------------

describe("expandEdges — multiple seeds", () => {
  test("top-level pulled is the union across seeds", async () => {
    await writeGraph({
      alice: ["bob"],
      bob: [],
      carol: ["dave"],
      dave: [],
    });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "carol"],
      hops: 1,
    });

    expect([...pulled].sort()).toEqual(["bob", "dave"]);
    expect(expansions).toEqual([
      { from: "alice", pulled: ["bob"] },
      { from: "carol", pulled: ["dave"] },
    ]);
  });

  test("a slug pulled by two seeds appears once in pulled, once per expansion", async () => {
    // alice -> shared, carol -> shared
    await writeGraph({ alice: ["shared"], carol: ["shared"], shared: [] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "carol"],
      hops: 1,
    });

    expect([...pulled]).toEqual(["shared"]);
    expect(expansions).toEqual([
      { from: "alice", pulled: ["shared"] },
      { from: "carol", pulled: ["shared"] },
    ]);
  });

  test("duplicate seeds collapse to a single expansion entry", async () => {
    await writeGraph({ alice: ["bob"], bob: [] });

    const { expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "alice"],
      hops: 1,
    });

    expect(expansions).toEqual([{ from: "alice", pulled: ["bob"] }]);
  });

  test("empty seed set yields an empty result", async () => {
    await writeGraph({ alice: ["bob"], bob: [] });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: [],
    });

    expect(pulled.size).toBe(0);
    expect(expansions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extraAdjacency injection seam
// ---------------------------------------------------------------------------

describe("expandEdges — extraAdjacency", () => {
  test("merges injected out-edges with the curated graph", async () => {
    // Curated: alice -> bob. Injected: alice -> extra.
    await writeGraph({ alice: ["bob"], bob: [], extra: [] });

    const extraAdjacency = new Map<string, Set<string>>([
      ["alice", new Set(["extra"])],
    ]);

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 1,
      extraAdjacency,
    });

    expect([...pulled].sort()).toEqual(["bob", "extra"]);
    expect(expansions).toEqual([{ from: "alice", pulled: ["bob", "extra"] }]);
  });

  test("injected edges bridge across hops (curated -> extra -> curated)", async () => {
    // Curated: alice -> bob, learned -> dave. Injected: bob -> learned.
    // 2-hop reach: bob (curated, hop 1) -> learned (extra, hop 2)...
    // and learned -> dave is hop 3, out of a 2-hop budget.
    await writeGraph({
      alice: ["bob"],
      bob: [],
      learned: ["dave"],
      dave: [],
    });

    const extraAdjacency = new Map<string, Set<string>>([
      ["bob", new Set(["learned"])],
    ]);

    const twoHop = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
      extraAdjacency,
    });
    expect([...twoHop.pulled].sort()).toEqual(["bob", "learned"]);

    const threeHop = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 3,
      extraAdjacency,
    });
    expect([...threeHop.pulled].sort()).toEqual(["bob", "dave", "learned"]);
  });

  test("absent extraAdjacency leaves the curated walk unchanged", async () => {
    await writeGraph({ alice: ["bob"], bob: ["carol"], carol: [] });

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
    });

    expect([...pulled].sort()).toEqual(["bob", "carol"]);
  });
});

// ---------------------------------------------------------------------------
// Cycle safety
// ---------------------------------------------------------------------------

describe("expandEdges — cycle safety", () => {
  test("a cycle in the curated graph terminates and does not loop", async () => {
    // alice -> bob -> carol -> alice (3-cycle).
    await writeGraph({
      alice: ["bob"],
      bob: ["carol"],
      carol: ["alice"],
    });

    // A generous hop budget would loop forever without a visited set.
    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 100,
    });

    // Reaches bob and carol; alice (the seed) is excluded even though the
    // cycle points back at it.
    expect([...pulled].sort()).toEqual(["bob", "carol"]);
    expect(expansions[0]!.pulled).not.toContain("alice");
  });

  test("a cycle introduced via extraAdjacency also terminates", async () => {
    // Curated: alice -> bob. Injected cycle: bob -> alice.
    await writeGraph({ alice: ["bob"], bob: [] });

    const extraAdjacency = new Map<string, Set<string>>([
      ["bob", new Set(["alice"])],
    ]);

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 100,
      extraAdjacency,
    });

    expect([...pulled].sort()).toEqual(["bob"]);
  });

  test("a self-loop edge does not loop or pull the seed", async () => {
    // alice -> alice (self-loop is dropped by the index, but guard anyway).
    await writeGraph({ alice: ["alice", "bob"], bob: [] });

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice"],
      hops: 2,
    });

    expect(pulled.has("alice")).toBe(false);
    expect([...pulled].sort()).toEqual(["bob"]);
  });
});
