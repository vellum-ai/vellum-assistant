import { describe, expect, test } from "bun:test";

import { detectClusters } from "./detect-clusters";

function nodes(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

function edge(fromId: string, toId: string): { fromId: string; toId: string } {
  return { fromId, toId };
}

/** A closed triangle over three node ids. */
function triangle(a: string, b: string, c: string) {
  return [edge(a, b), edge(b, c), edge(c, a)];
}

describe("detectClusters", () => {
  test("two disconnected triangles yield exactly 2 clusters", () => {
    const clusters = detectClusters(nodes("a", "b", "c", "d", "e", "f"), [
      ...triangle("a", "b", "c"),
      ...triangle("d", "e", "f"),
    ]);
    // All six nodes are assigned, split into exactly two distinct clusters.
    expect(clusters.size).toBe(6);
    expect(new Set(clusters.values()).size).toBe(2);
    // Each triangle shares one cluster; the two triangles differ.
    expect(clusters.get("a")).toBe(clusters.get("b"));
    expect(clusters.get("b")).toBe(clusters.get("c"));
    expect(clusters.get("d")).toBe(clusters.get("e"));
    expect(clusters.get("e")).toBe(clusters.get("f"));
    expect(clusters.get("a")).not.toBe(clusters.get("d"));
  });

  test("one bridge edge merges the two triangles into 1 cluster", () => {
    const clusters = detectClusters(nodes("a", "b", "c", "d", "e", "f"), [
      ...triangle("a", "b", "c"),
      ...triangle("d", "e", "f"),
      edge("c", "d"), // bridge
    ]);
    expect(new Set(clusters.values()).size).toBe(1);
  });

  test("is deterministic — identical input yields an identical map", () => {
    const ns = nodes("a", "b", "c", "d", "e", "f");
    const es = [...triangle("a", "b", "c"), ...triangle("d", "e", "f")];
    expect([...detectClusters(ns, es)]).toEqual([...detectClusters(ns, es)]);
  });

  test("two isolated nodes get two distinct cluster ids", () => {
    const clusters = detectClusters(nodes("a", "b"), []);
    expect(clusters.get("a")).not.toBe(clusters.get("b"));
    expect(new Set(clusters.values()).size).toBe(2);
  });

  test("cluster ids are dense 0..k-1", () => {
    const clusters = detectClusters(nodes("a", "b", "c", "d", "e"), [
      ...triangle("a", "b", "c"),
      edge("d", "e"),
    ]);
    const ids = [...new Set(clusters.values())].sort((x, y) => x - y);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i));
  });

  test("returns an empty map for no nodes", () => {
    expect(detectClusters([], [])).toEqual(new Map());
  });
});
