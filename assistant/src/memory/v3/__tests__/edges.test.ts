/**
 * Tests for `assistant/src/memory/v3/edges.ts` — the curated edge-expansion
 * lane.
 *
 * Coverage matrix:
 *   - 1-hop and 2-hop outgoing expansion from a single seed.
 *   - Default hops (2) when omitted.
 *   - Seed excluded from its own `pulled`, and from another seed's `pulled`
 *     when one seed is reachable from another (seeds-excluded contract).
 *   - Multiple seeds: top-level `pulled` is the union; per-seed expansions
 *     attribute correctly; duplicate seeds collapse.
 *   - Per-seed cap spends slots on unique neighbors, not duplicates an earlier
 *     seed already pulled (recall at the cap).
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

// ---------------------------------------------------------------------------
// Expansion bounds
// ---------------------------------------------------------------------------
//
// These constants mirror the (intentionally module-private) caps in `edges.ts`.
// The seed set handed to this lane is the union of every upstream lane's
// candidates, so on a mature corpus it can run to thousands of slugs; expanding
// all of them to their full neighborhood balloons the downstream gate's pool.
// The lane caps the seeds expanded, the per-seed fan-out, and the total union.
const MAX_SEEDS_EXPANDED = 150;
const MAX_PULLS_PER_SEED = 32;
const MAX_TOTAL_PULLS = 400;

/** Zero-padded slug so lexical sort matches numeric order (`topics/000`..). */
function topicSlug(domain: string, i: number): string {
  return `${domain}/${String(i).padStart(4, "0")}`;
}

describe("expandEdges — bounds", () => {
  test("expands at most MAX_SEEDS_EXPANDED seeds, dropping the tail", async () => {
    // More seeds than the cap, each a 1-hop edge to its own private target.
    const seedCount = MAX_SEEDS_EXPANDED + 50;
    const graph: Record<string, string[]> = {};
    const seeds: string[] = [];
    for (let i = 0; i < seedCount; i++) {
      const seed = topicSlug("people", i);
      const target = topicSlug("targets", i);
      graph[seed] = [target];
      graph[target] = [];
      seeds.push(seed);
    }
    await writeGraph(graph);

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds,
      hops: 1,
    });

    // Only the first MAX_SEEDS_EXPANDED seeds yield an expansion entry; the
    // 200-seed input is truncated to the cap.
    expect(expansions).toHaveLength(MAX_SEEDS_EXPANDED);
    expect(expansions.map((e) => e.from)).toEqual(
      seeds.slice(0, MAX_SEEDS_EXPANDED),
    );
    // Each surviving seed contributes exactly its one target, so the union is
    // one slug per expanded seed and stays under the total ceiling.
    expect(pulled.size).toBe(MAX_SEEDS_EXPANDED);
    expect(pulled.size).toBeLessThanOrEqual(MAX_TOTAL_PULLS);
  });

  test("caps a single hub seed's fan-out at MAX_PULLS_PER_SEED", async () => {
    // One hub seed pointing at far more 1-hop neighbors than the per-seed cap.
    const fanOut = MAX_PULLS_PER_SEED + 40;
    const graph: Record<string, string[]> = {};
    const targets: string[] = [];
    for (let i = 0; i < fanOut; i++) {
      const target = topicSlug("topics", i);
      targets.push(target);
      graph[target] = [];
    }
    graph["hub"] = targets;
    await writeGraph(graph);

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["hub"],
      hops: 1,
    });

    // The hub's neighborhood is truncated to the per-seed cap, deterministically
    // keeping the lexicographically-first targets.
    expect(expansions).toHaveLength(1);
    expect(expansions[0]!.from).toBe("hub");
    expect(expansions[0]!.pulled).toHaveLength(MAX_PULLS_PER_SEED);
    expect(expansions[0]!.pulled).toEqual(
      [...targets].sort().slice(0, MAX_PULLS_PER_SEED),
    );
    expect(pulled.size).toBe(MAX_PULLS_PER_SEED);
  });

  test("bounds the total pulled union at MAX_TOTAL_PULLS across many seeds", async () => {
    // Enough seeds, each with a per-seed-cap-sized private fan-out, that the
    // unbounded union would be seedCount * MAX_PULLS_PER_SEED slugs — far past
    // the total ceiling (ceil(400/32) = 13 seeds fills it). Each seed's targets
    // are disjoint, so nothing collapses via de-dup and the only thing holding
    // the union down is the cap.
    const seedCount = 20;
    const graph: Record<string, string[]> = {};
    const seeds: string[] = [];
    for (let s = 0; s < seedCount; s++) {
      const seed = topicSlug("people", s);
      const targets: string[] = [];
      for (let t = 0; t < MAX_PULLS_PER_SEED; t++) {
        // Globally-unique target slug per (seed, target) pair.
        const target = topicSlug("targets", s * MAX_PULLS_PER_SEED + t);
        targets.push(target);
        graph[target] = [];
      }
      graph[seed] = targets;
      seeds.push(seed);
    }
    await writeGraph(graph);

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds,
      hops: 1,
    });

    // The union is held at the ceiling exactly — never overshot — even though
    // the seeds collectively reach far more slugs.
    expect(pulled.size).toBe(MAX_TOTAL_PULLS);
    // Every emitted expansion entry lists only slugs that made it into the
    // bounded union, so the trace never claims an un-pulled slug.
    for (const expansion of expansions) {
      for (const slug of expansion.pulled) {
        expect(pulled.has(slug)).toBe(true);
      }
    }
  });

  test("maxTotalPulls overrides the default union ceiling", async () => {
    // 20 seeds × 32 disjoint targets = 640 reachable, far past any cap. A low
    // per-call maxTotalPulls must bound the union to that value, not the 400
    // default; an omitted or invalid value falls back to the default.
    const seedCount = 20;
    const graph: Record<string, string[]> = {};
    const seeds: string[] = [];
    for (let s = 0; s < seedCount; s++) {
      const seed = topicSlug("people", s);
      const targets: string[] = [];
      for (let t = 0; t < MAX_PULLS_PER_SEED; t++) {
        const target = topicSlug("targets", s * MAX_PULLS_PER_SEED + t);
        targets.push(target);
        graph[target] = [];
      }
      graph[seed] = targets;
      seeds.push(seed);
    }
    await writeGraph(graph);

    const capped = await expandEdges({
      workspaceDir,
      seeds,
      hops: 1,
      maxTotalPulls: 40,
    });
    expect(capped.pulled.size).toBeLessThanOrEqual(40);

    // Omitted → the 400 default; an invalid (negative) value also falls back.
    const dflt = await expandEdges({ workspaceDir, seeds, hops: 1 });
    expect(dflt.pulled.size).toBe(MAX_TOTAL_PULLS);
    const invalid = await expandEdges({
      workspaceDir,
      seeds,
      hops: 1,
      maxTotalPulls: -5,
    });
    expect(invalid.pulled.size).toBe(MAX_TOTAL_PULLS);
  });

  test("duplicate slugs across seeds don't waste the total budget", async () => {
    // Two seeds, both pointing at the same shared target plus one private each.
    // The shared slug is counted once, so the union is 3 — well under the cap,
    // and both seeds still get a faithful expansion entry.
    await writeGraph({
      "people/alice": ["topics/shared", "topics/alice-only"],
      "people/bob": ["topics/shared", "topics/bob-only"],
      "topics/shared": [],
      "topics/alice-only": [],
      "topics/bob-only": [],
    });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["people/alice", "people/bob"],
      hops: 1,
    });

    expect([...pulled].sort()).toEqual([
      "topics/alice-only",
      "topics/bob-only",
      "topics/shared",
    ]);
    expect(pulled.size).toBeLessThanOrEqual(MAX_TOTAL_PULLS);
    expect(expansions).toEqual([
      { from: "people/alice", pulled: ["topics/alice-only", "topics/shared"] },
      { from: "people/bob", pulled: ["topics/bob-only", "topics/shared"] },
    ]);
  });

  test("a seed reachable from another seed is excluded from pulled", async () => {
    // alice -> bob, and bob is itself a seed. bob is a confident hit in its own
    // right, not a neighbor, so it must never appear in the pulled union — even
    // though alice's outgoing walk reaches it. bob's own private neighbor is
    // still pulled.
    await writeGraph({
      alice: ["bob"],
      bob: ["carol"],
      carol: [],
    });

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "bob"],
      hops: 1,
    });

    expect(pulled.has("bob")).toBe(false);
    expect([...pulled].sort()).toEqual(["carol"]);
    // alice reaches only bob, which is a seed, so alice contributes nothing.
    expect(expansions).toEqual([
      { from: "alice", pulled: [] },
      { from: "bob", pulled: ["carol"] },
    ]);
  });

  test("a seed two hops from another seed is still excluded from pulled", async () => {
    // alice -> mid -> bob. With a 2-hop walk alice reaches bob, but bob is a
    // seed and must not leak into pulled; the intermediate `mid` is a genuine
    // neighbor and is kept.
    await writeGraph({
      alice: ["mid"],
      mid: ["bob"],
      bob: [],
    });

    const { pulled } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "bob"],
      hops: 2,
    });

    expect(pulled.has("bob")).toBe(false);
    expect([...pulled].sort()).toEqual(["mid"]);
  });

  test("per-seed cap is spent on unique neighbors, not duplicates", async () => {
    // alice pulls 16 shared `dup/*` neighbors. bob reaches those same 16 dups
    // plus 32 unique `fresh/*` neighbors. bob's per-seed budget is
    // MAX_PULLS_PER_SEED (32) because the union is nowhere near the total cap.
    //
    // The old slice took bob's lexicographically-first 32 reached slugs — the
    // 16 already-pulled dups plus only the first 16 fresh — wasting 16 budget
    // slots on duplicates and dropping the other 16 unique neighbors. Filtering
    // already-pulled slugs before the slice spends all 32 slots on fresh
    // neighbors, so every unique one is retained (recall north star).
    const dupCount = 16;
    const freshCount = MAX_PULLS_PER_SEED; // 32, so old code drops 16 unique.
    const dups: string[] = [];
    const fresh: string[] = [];
    const graph: Record<string, string[]> = {};
    for (let i = 0; i < dupCount; i++) {
      const slug = topicSlug("dup", i);
      dups.push(slug);
      graph[slug] = [];
    }
    for (let i = 0; i < freshCount; i++) {
      const slug = topicSlug("fresh", i);
      fresh.push(slug);
      graph[slug] = [];
    }
    // "dup/*" sorts before "fresh/*", so the old front-of-list slice is exactly
    // the 16 dups + first 16 fresh.
    graph["alice"] = [...dups];
    graph["bob"] = [...dups, ...fresh];
    await writeGraph(graph);

    const { pulled, expansions } = await expandEdges({
      workspaceDir,
      seeds: ["alice", "bob"],
      hops: 1,
    });

    // All 32 unique fresh neighbors survive — none dropped to a duplicate slot.
    for (const slug of fresh) expect(pulled.has(slug)).toBe(true);
    // A unique neighbor the old code would have dropped (past the first 16) is
    // now retained.
    expect(pulled.has(topicSlug("fresh", freshCount - 1))).toBe(true);
    // Union is the 16 dups + 32 fresh, all distinct.
    expect(pulled.size).toBe(dupCount + freshCount);

    // bob's budget (32 fresh slots) is fully spent on unique neighbors; the
    // dups it also reaches stay in its trace for faithful attribution but did
    // not consume the budget.
    const bobExpansion = expansions.find((e) => e.from === "bob")!;
    expect(bobExpansion.pulled).toEqual([...dups, ...fresh].sort());
    // Every trace slug is genuinely in the union.
    for (const slug of bobExpansion.pulled) expect(pulled.has(slug)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Seed ranking by lane trust
// ---------------------------------------------------------------------------

describe("expandEdges — seed ranking", () => {
  test("ranks tree/dense/sparse seeds ahead of hot before the seed cap", async () => {
    // 200 seeds (> the 150 cap), each with a private 1-hop edge. In candidate
    // order the first 150 are hot (recency) and the last 50 are tree (LLM-
    // chosen). Without ranking the cap would expand all 150 hot and drop every
    // tree seed; with laneBySlug the tree seeds must be expanded first.
    const hotCount = 150;
    const treeCount = 50;
    const graph: Record<string, string[]> = {};
    const seeds: string[] = [];
    const laneBySlug = new Map<string, string>();
    for (let i = 0; i < hotCount; i++) {
      const seed = topicSlug("hot", i);
      graph[seed] = [topicSlug("hot-targets", i)];
      graph[topicSlug("hot-targets", i)] = [];
      seeds.push(seed);
      laneBySlug.set(seed, "hot");
    }
    for (let i = 0; i < treeCount; i++) {
      const seed = topicSlug("tree", i);
      graph[seed] = [topicSlug("tree-targets", i)];
      graph[topicSlug("tree-targets", i)] = [];
      seeds.push(seed);
      laneBySlug.set(seed, "tree");
    }
    await writeGraph(graph);

    const { expansions } = await expandEdges({
      workspaceDir,
      seeds,
      hops: 1,
      laneBySlug,
    });

    const expandedFrom = expansions.map((e) => e.from);
    // The seed cap still holds.
    expect(expandedFrom).toHaveLength(MAX_SEEDS_EXPANDED);
    // Every tree seed survives the cap (ranked ahead of hot) and leads the
    // order, keeping candidate order within the tier (stable sort).
    const treeSeeds = seeds.slice(hotCount);
    expect(expandedFrom.slice(0, treeCount)).toEqual(treeSeeds);
    // The dropped seeds are the tail-end hot seeds, not any tree seed.
    const droppedHot = seeds.slice(hotCount - treeCount, hotCount);
    for (const h of droppedHot) expect(expandedFrom).not.toContain(h);
  });

  test("without laneBySlug, seeds keep candidate order", async () => {
    const graph: Record<string, string[]> = {};
    const seeds: string[] = [];
    for (let i = 0; i < MAX_SEEDS_EXPANDED + 10; i++) {
      const seed = topicSlug("people", i);
      graph[seed] = [topicSlug("targets", i)];
      graph[topicSlug("targets", i)] = [];
      seeds.push(seed);
    }
    await writeGraph(graph);

    const { expansions } = await expandEdges({ workspaceDir, seeds, hops: 1 });
    expect(expansions.map((e) => e.from)).toEqual(
      seeds.slice(0, MAX_SEEDS_EXPANDED),
    );
  });
});
