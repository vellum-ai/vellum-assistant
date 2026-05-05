/**
 * Tests for `memory/v2/edge-index.ts` — the in-memory directed edge index
 * derived from concept-page frontmatter.
 *
 * Tests live in temp workspaces (mkdtemp) and never touch `~/.vellum/`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getEdgeIndex,
  getReachable,
  invalidateEdgeIndex,
  totalEdgeCount,
  validateEdgeTargets,
} from "../edge-index.js";
import { deletePage, writePage } from "../page-store.js";
import type { ConceptPage } from "../types.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memory-v2-edge-index-"));
});

afterEach(() => {
  invalidateEdgeIndex();
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function makePage(slug: string, edges: string[] = [], body = ""): ConceptPage {
  return {
    slug,
    frontmatter: { edges, ref_files: [] },
    body,
  };
}

// ---------------------------------------------------------------------------
// getEdgeIndex
// ---------------------------------------------------------------------------

describe("getEdgeIndex", () => {
  test("returns empty maps when no concept pages exist", async () => {
    const idx = await getEdgeIndex(workspaceDir);
    expect(idx.outgoing.size).toBe(0);
    expect(idx.incoming.size).toBe(0);
  });

  test("derives outgoing and incoming adjacency from page frontmatter", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob", ["carol"]));
    await writePage(workspaceDir, makePage("carol"));

    const idx = await getEdgeIndex(workspaceDir);

    expect(Array.from(idx.outgoing.get("alice") ?? new Set<string>())).toEqual([
      "bob",
    ]);
    expect(Array.from(idx.outgoing.get("bob") ?? new Set<string>())).toEqual([
      "carol",
    ]);
    expect(idx.outgoing.get("carol")).toBeUndefined();

    expect(Array.from(idx.incoming.get("bob") ?? new Set<string>())).toEqual([
      "alice",
    ]);
    expect(Array.from(idx.incoming.get("carol") ?? new Set<string>())).toEqual([
      "bob",
    ]);
    expect(idx.incoming.get("alice")).toBeUndefined();
  });

  test("[A,B] and [B,A] coexist as distinct directed edges", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob", ["alice"]));

    const idx = await getEdgeIndex(workspaceDir);

    expect(Array.from(idx.outgoing.get("alice") ?? new Set<string>())).toEqual([
      "bob",
    ]);
    expect(Array.from(idx.outgoing.get("bob") ?? new Set<string>())).toEqual([
      "alice",
    ]);
    expect(Array.from(idx.incoming.get("alice") ?? new Set<string>())).toEqual([
      "bob",
    ]);
    expect(Array.from(idx.incoming.get("bob") ?? new Set<string>())).toEqual([
      "alice",
    ]);
  });

  test("self-loops are dropped silently", async () => {
    await writePage(workspaceDir, makePage("alice", ["alice", "bob"]));
    await writePage(workspaceDir, makePage("bob"));

    const idx = await getEdgeIndex(workspaceDir);

    expect(Array.from(idx.outgoing.get("alice") ?? new Set<string>())).toEqual([
      "bob",
    ]);
    expect(idx.incoming.get("alice")).toBeUndefined();
  });

  test("caches the result across calls within a workspace", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob"));

    const first = await getEdgeIndex(workspaceDir);
    const second = await getEdgeIndex(workspaceDir);

    // Same instance — module-level cache returns the prior build.
    expect(second).toBe(first);
  });

  test("writePage invalidates the cache so subsequent reads see fresh state", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob"));

    const before = await getEdgeIndex(workspaceDir);
    expect([...(before.outgoing.get("alice") ?? [])]).toEqual(["bob"]);

    await writePage(workspaceDir, makePage("alice", ["bob", "carol"]));
    await writePage(workspaceDir, makePage("carol"));

    const after = await getEdgeIndex(workspaceDir);
    expect(after).not.toBe(before);
    expect(
      Array.from(after.outgoing.get("alice") ?? new Set<string>()).sort(),
    ).toEqual(["bob", "carol"]);
  });

  test("deletePage invalidates the cache", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob"));

    const before = await getEdgeIndex(workspaceDir);
    expect(before.outgoing.has("alice")).toBe(true);

    await deletePage(workspaceDir, "alice");

    const after = await getEdgeIndex(workspaceDir);
    expect(after.outgoing.has("alice")).toBe(false);
    expect(after.incoming.has("bob")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getReachable
// ---------------------------------------------------------------------------

describe("getReachable", () => {
  // Directed graph used across BFS tests:
  //
  //   alice → bob → carol → delta
  //              ↘
  //               echo
  //
  // (orphan: foxtrot)
  async function setupGraph(): Promise<void> {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob", ["carol", "echo"]));
    await writePage(workspaceDir, makePage("carol", ["delta"]));
    await writePage(workspaceDir, makePage("delta"));
    await writePage(workspaceDir, makePage("echo"));
    await writePage(workspaceDir, makePage("foxtrot"));
  }

  test("direction='out' walks outgoing edges only", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "alice", 3, "out")).toEqual(
      new Set(["bob", "carol", "echo", "delta"]),
    );
  });

  test("direction='in' walks incoming edges only", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "delta", 3, "in")).toEqual(
      new Set(["carol", "bob", "alice"]),
    );
    // Going outward from delta yields nothing — it's a sink.
    expect(getReachable(idx, "delta", 5, "out")).toEqual(new Set());
  });

  test("hops=1 returns immediate neighbors only", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "bob", 1, "out")).toEqual(
      new Set(["carol", "echo"]),
    );
  });

  test("never includes the start slug", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "bob", 5, "out").has("bob")).toBe(false);
  });

  test("orphan node returns the empty set", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "foxtrot", 5, "out")).toEqual(new Set());
    expect(getReachable(idx, "foxtrot", 5, "in")).toEqual(new Set());
  });

  test("hops<=0 returns the empty set without throwing", async () => {
    await setupGraph();
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "alice", 0, "out")).toEqual(new Set());
    expect(getReachable(idx, "alice", -1, "out")).toEqual(new Set());
  });

  test("a directed cycle is traversed without infinite-looping", async () => {
    // A → B → A (two distinct directed edges)
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob", ["alice"]));
    const idx = await getEdgeIndex(workspaceDir);
    expect(getReachable(idx, "alice", 5, "out")).toEqual(new Set(["bob"]));
    expect(getReachable(idx, "bob", 5, "out")).toEqual(new Set(["alice"]));
  });
});

// ---------------------------------------------------------------------------
// validateEdgeTargets
// ---------------------------------------------------------------------------

describe("validateEdgeTargets", () => {
  test("ok=true when every outgoing target has a known slug", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob"]));
    await writePage(workspaceDir, makePage("bob"));

    const idx = await getEdgeIndex(workspaceDir);
    const result = validateEdgeTargets(idx, new Set(["alice", "bob"]));
    expect(result).toEqual({ ok: true, missing: [] });
  });

  test("flags outgoing targets that don't correspond to a known slug", async () => {
    await writePage(workspaceDir, makePage("alice", ["ghost", "bob"]));
    await writePage(workspaceDir, makePage("bob", ["phantom"]));

    const idx = await getEdgeIndex(workspaceDir);
    const result = validateEdgeTargets(idx, new Set(["alice", "bob"]));

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      { from: "alice", to: "ghost" },
      { from: "bob", to: "phantom" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// totalEdgeCount
// ---------------------------------------------------------------------------

describe("totalEdgeCount", () => {
  test("returns the sum of every page's outgoing fanout", async () => {
    await writePage(workspaceDir, makePage("alice", ["bob", "carol"]));
    await writePage(workspaceDir, makePage("bob", ["carol"]));
    await writePage(workspaceDir, makePage("carol"));

    const idx = await getEdgeIndex(workspaceDir);
    expect(totalEdgeCount(idx)).toBe(3);
  });

  test("returns 0 for an empty graph", async () => {
    const idx = await getEdgeIndex(workspaceDir);
    expect(totalEdgeCount(idx)).toBe(0);
  });
});
