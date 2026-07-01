import { describe, expect, test } from "bun:test";

import type { MemoryGraph } from "@/domains/intelligence/memory-graph/types";

import { buildForceLayout } from "./build-force-layout";

function graph(over: Partial<MemoryGraph>): MemoryGraph {
  return {
    backend: "memory-v3",
    supported: true,
    nodes: [],
    edges: [],
    ...over,
  };
}

describe("buildForceLayout", () => {
  test("returns an empty layout for an empty graph", () => {
    expect(buildForceLayout(graph({}))).toEqual({ nodes: [], edges: [] });
  });

  test("is deterministic — identical input lays out identically", () => {
    const g = graph({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      edges: [
        { source: "a", target: "b", kind: "link" },
        { source: "b", target: "c", kind: "learned" },
      ],
    });
    expect(buildForceLayout(g)).toEqual(buildForceLayout(g));
  });

  test("drops self-loops and edges to unknown nodes", () => {
    const layout = buildForceLayout(
      graph({
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        edges: [
          { source: "a", target: "b", kind: "link" },
          { source: "a", target: "a", kind: "link" }, // self-loop
          { source: "a", target: "ghost", kind: "learned" }, // dangling
        ],
      }),
    );
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ fromId: "a", toId: "b", kind: "link" });
  });

  test("carries kind/degree and sizes higher-degree nodes larger", () => {
    const layout = buildForceLayout(
      graph({
        nodes: [
          { id: "hub", label: "Hub", kind: "concept" },
          { id: "x", label: "X", kind: "skill" },
          { id: "y", label: "Y", kind: "capability" },
          { id: "z", label: "Z" },
        ],
        edges: [
          { source: "hub", target: "x" },
          { source: "hub", target: "y" },
          { source: "hub", target: "z" },
        ],
      }),
    );
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    expect(byId.get("hub")?.degree).toBe(3);
    expect(byId.get("x")?.degree).toBe(1);
    expect(byId.get("hub")!.radius).toBeGreaterThan(byId.get("x")!.radius);
    // Unknown kind falls back to "other".
    expect(byId.get("z")?.kind).toBe("other");
    expect(byId.get("x")?.kind).toBe("skill");
  });

  test("resolves overlaps — no two nodes end up interpenetrating", () => {
    const nodes = Array.from({ length: 14 }, (_, i) => ({
      id: `n${i}`,
      label: `N${i}`,
    }));
    const layout = buildForceLayout(graph({ nodes }));
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        // Allow a small epsilon below the exact sum of radii.
        expect(dist).toBeGreaterThanOrEqual(a.radius + b.radius - 0.5);
      }
    }
  });
});
