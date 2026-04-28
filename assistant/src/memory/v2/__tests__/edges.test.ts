/**
 * Tests for `memory/v2/edges.ts` — the read/write/neighbor primitives over
 * `memory/edges.json`.
 *
 * Tests live in temp workspaces (mkdtemp) and never touch `~/.vellum/`.
 * Slug names use generic placeholders (`alice`, `bob`, `topic-x`, ...).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  addEdge,
  getNeighbors,
  readEdges,
  removeEdge,
  validateEdges,
  writeEdges,
} from "../edges.js";
import type { EdgesIndex } from "../types.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-memory-v2-edges-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function edgesFile(): string {
  return join(workspaceDir, "memory", "edges.json");
}

function readEdgesFileRaw(): unknown {
  return JSON.parse(readFileSync(edgesFile(), "utf-8"));
}

// ---------------------------------------------------------------------------
// readEdges
// ---------------------------------------------------------------------------

describe("readEdges", () => {
  test("returns empty index when memory/edges.json is missing", async () => {
    const idx = await readEdges(workspaceDir);
    expect(idx).toEqual({ version: 1, edges: [] });
  });

  test("reads and validates an existing edges.json", async () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    const fixture: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
      ],
    };
    writeFileSync(edgesFile(), JSON.stringify(fixture), "utf-8");
    const idx = await readEdges(workspaceDir);
    expect(idx).toEqual(fixture);
  });

  test("throws on schema violation (e.g. wrong version)", async () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(
      edgesFile(),
      JSON.stringify({ version: 2, edges: [] }),
      "utf-8",
    );
    await expect(readEdges(workspaceDir)).rejects.toThrow();
  });

  test("throws on malformed JSON", async () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(edgesFile(), "not-json", "utf-8");
    await expect(readEdges(workspaceDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeEdges
// ---------------------------------------------------------------------------

describe("writeEdges", () => {
  test("creates memory/ if missing and writes the canonical empty index", async () => {
    await writeEdges(workspaceDir, { version: 1, edges: [] });
    expect(readEdgesFileRaw()).toEqual({ version: 1, edges: [] });
  });

  test("canonicalizes each tuple to [min, max] alphabetical-first ordering", async () => {
    await writeEdges(workspaceDir, {
      version: 1,
      edges: [
        ["bob", "alice"],
        ["delta", "carol"],
      ],
    });
    expect(readEdgesFileRaw()).toEqual({
      version: 1,
      edges: [
        ["alice", "bob"],
        ["carol", "delta"],
      ],
    });
  });

  test("dedupes tuples that collapse to the same canonical form", async () => {
    await writeEdges(workspaceDir, {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "alice"],
        ["alice", "bob"],
      ],
    });
    expect(readEdgesFileRaw()).toEqual({
      version: 1,
      edges: [["alice", "bob"]],
    });
  });

  test("drops self-loops on write", async () => {
    await writeEdges(workspaceDir, {
      version: 1,
      edges: [
        ["alice", "alice"],
        ["alice", "bob"],
      ],
    });
    expect(readEdgesFileRaw()).toEqual({
      version: 1,
      edges: [["alice", "bob"]],
    });
  });

  test("emits deterministically-sorted output regardless of input order", async () => {
    await writeEdges(workspaceDir, {
      version: 1,
      edges: [
        ["zeta", "yankee"],
        ["alice", "bob"],
        ["mike", "lima"],
      ],
    });
    const reread = readEdgesFileRaw() as EdgesIndex;
    expect(reread.edges).toEqual([
      ["alice", "bob"],
      ["lima", "mike"],
      ["yankee", "zeta"],
    ]);
  });

  test("write-then-read round-trip preserves a non-trivial graph", async () => {
    const original: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
        ["carol", "delta"],
        ["alice", "delta"],
      ],
    };
    await writeEdges(workspaceDir, original);
    const reread = await readEdges(workspaceDir);
    // Edges may be reordered by canonicalization, but content is identical.
    expect(new Set(reread.edges.map((e) => e.join("\u0000")))).toEqual(
      new Set(original.edges.map((e) => e.join("\u0000"))),
    );
  });

  test("atomic: leaves no .tmp file behind on success", async () => {
    await writeEdges(workspaceDir, {
      version: 1,
      edges: [["alice", "bob"]],
    });
    const stragglers = readdirSync(join(workspaceDir, "memory")).filter((n) =>
      n.startsWith("edges.json.tmp-"),
    );
    expect(stragglers).toEqual([]);
  });

  test("atomic: a concurrent reader observes the prior file until rename completes", async () => {
    // Seed with a known-good prior file.
    const prior: EdgesIndex = {
      version: 1,
      edges: [["alice", "bob"]],
    };
    await writeEdges(workspaceDir, prior);

    // Race a write against many reads. Each read must observe a fully-formed
    // index — never a partial JSON document.
    const next: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["carol", "delta"],
      ],
    };
    const writePromise = writeEdges(workspaceDir, next);
    const reads = Array.from({ length: 20 }, () => readEdges(workspaceDir));
    const results = await Promise.all([writePromise, ...reads]);

    // Skip the write result (undefined); every read returns one of the two
    // valid indices.
    const possibilities = [
      JSON.stringify(prior),
      JSON.stringify({
        version: 1,
        edges: [
          ["alice", "bob"],
          ["carol", "delta"],
        ],
      }),
    ];
    for (const r of results.slice(1) as EdgesIndex[]) {
      expect(possibilities).toContain(JSON.stringify(r));
    }
  });
});

// ---------------------------------------------------------------------------
// addEdge / removeEdge
// ---------------------------------------------------------------------------

describe("addEdge", () => {
  const empty: EdgesIndex = { version: 1, edges: [] };

  test("adds a new edge in canonical form", () => {
    const next = addEdge(empty, "bob", "alice");
    expect(next.edges).toEqual([["alice", "bob"]]);
  });

  test("does not duplicate an existing edge regardless of argument order", () => {
    const once = addEdge(empty, "alice", "bob");
    const twice = addEdge(once, "bob", "alice");
    expect(twice).toBe(once);
  });

  test("rejects self-loops", () => {
    expect(() => addEdge(empty, "alice", "alice")).toThrow();
  });

  test("does not mutate the input index", () => {
    const idx: EdgesIndex = { version: 1, edges: [["alice", "bob"]] };
    const next = addEdge(idx, "carol", "delta");
    expect(idx.edges).toEqual([["alice", "bob"]]);
    expect(next.edges).toEqual([
      ["alice", "bob"],
      ["carol", "delta"],
    ]);
  });
});

describe("removeEdge", () => {
  test("removes an edge regardless of argument order", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
      ],
    };
    const next = removeEdge(idx, "bob", "alice");
    expect(next.edges).toEqual([["bob", "carol"]]);
  });

  test("returns the same index when the edge is not present", () => {
    const idx: EdgesIndex = { version: 1, edges: [["alice", "bob"]] };
    const next = removeEdge(idx, "carol", "delta");
    expect(next).toBe(idx);
  });

  test("does not mutate the input index", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
      ],
    };
    removeEdge(idx, "alice", "bob");
    expect(idx.edges).toEqual([
      ["alice", "bob"],
      ["bob", "carol"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// getNeighbors
// ---------------------------------------------------------------------------

describe("getNeighbors", () => {
  // Graph used across BFS tests:
  //
  //   alice -- bob -- carol -- delta
  //              \
  //               echo
  //
  // (orphan: foxtrot)
  const graph: EdgesIndex = {
    version: 1,
    edges: [
      ["alice", "bob"],
      ["bob", "carol"],
      ["bob", "echo"],
      ["carol", "delta"],
    ],
  };

  test("hops=1 returns immediate neighbors only", () => {
    expect(getNeighbors(graph, "bob", 1)).toEqual(
      new Set(["alice", "carol", "echo"]),
    );
  });

  test("hops=2 includes second-degree neighbors", () => {
    // From alice: bob (1), then carol+echo (2).
    expect(getNeighbors(graph, "alice", 2)).toEqual(
      new Set(["bob", "carol", "echo"]),
    );
  });

  test("hops=3 reaches the third-degree node", () => {
    // From alice: bob (1), carol+echo (2), delta (3).
    expect(getNeighbors(graph, "alice", 3)).toEqual(
      new Set(["bob", "carol", "echo", "delta"]),
    );
  });

  test("never includes the start slug", () => {
    expect(getNeighbors(graph, "bob", 5).has("bob")).toBe(false);
  });

  test("orphan node returns the empty set", () => {
    expect(getNeighbors(graph, "foxtrot", 5)).toEqual(new Set());
  });

  test("unknown slug returns the empty set", () => {
    expect(getNeighbors(graph, "ghost", 3)).toEqual(new Set());
  });

  test("hops=0 returns the empty set", () => {
    expect(getNeighbors(graph, "alice", 0)).toEqual(new Set());
  });

  test("negative hops returns the empty set without throwing", () => {
    expect(getNeighbors(graph, "alice", -1)).toEqual(new Set());
  });

  test("a cycle is traversed without infinite-looping", () => {
    // Triangle: alice--bob, bob--carol, carol--alice.
    const triangle: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
        ["alice", "carol"],
      ],
    };
    expect(getNeighbors(triangle, "alice", 5)).toEqual(
      new Set(["bob", "carol"]),
    );
  });
});

// ---------------------------------------------------------------------------
// validateEdges
// ---------------------------------------------------------------------------

describe("validateEdges", () => {
  test("ok=true with empty missing list when every endpoint is known", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["bob", "carol"],
      ],
    };
    expect(validateEdges(idx, new Set(["alice", "bob", "carol"]))).toEqual({
      ok: true,
      missing: [],
    });
  });

  test("reports endpoints that are not in knownSlugs", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "bob"],
        ["carol", "delta"],
      ],
    };
    const result = validateEdges(idx, new Set(["alice", "bob"]));
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["carol", "delta"]);
  });

  test("dedupes a missing slug that appears in multiple edges", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["alice", "ghost"],
        ["bob", "ghost"],
      ],
    };
    const result = validateEdges(idx, new Set(["alice", "bob"]));
    expect(result.missing).toEqual(["ghost"]);
  });

  test("returns a sorted missing list for stable output", () => {
    const idx: EdgesIndex = {
      version: 1,
      edges: [
        ["zeta", "alpha"],
        ["mike", "kilo"],
      ],
    };
    const result = validateEdges(idx, new Set());
    expect(result.missing).toEqual(["alpha", "kilo", "mike", "zeta"]);
  });
});
