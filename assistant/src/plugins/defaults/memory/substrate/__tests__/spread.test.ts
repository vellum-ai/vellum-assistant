/**
 * Tests for `substrate/spread.ts` — edge-graph activation
 * spreading.
 *
 * Coverage:
 *   - `spreadActivation`: orphan yields A == A_o; spread walks incoming edges
 *      only (A→B boosts B but not A); hops=2 reaches second-degree predecessors
 *      but not third; bounded in [0,1]; inactive predecessors drop from both
 *      sides of the ratio; contribution == final - own.
 *
 * `spreadActivation` is a pure function (no I/O), so no mocks are needed.
 */

import { describe, expect, test } from "bun:test";

import type { EdgeIndex } from "../edge-index.js";
import { spreadActivation } from "../spread.js";

/**
 * Build a directed `EdgeIndex` from a flat list of `[from, to]` pairs. Each
 * entry is interpreted as a directed edge `from → to`; self-loops are dropped.
 */
function buildEdgeIndex(edges: Array<[string, string]>): EdgeIndex {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (from === to) {
      continue;
    }
    let outSet = outgoing.get(from);
    if (!outSet) {
      outSet = new Set<string>();
      outgoing.set(from, outSet);
    }
    outSet.add(to);
    let inSet = incoming.get(to);
    if (!inSet) {
      inSet = new Set<string>();
      incoming.set(to, inSet);
    }
    inSet.add(from);
  }
  return { outgoing, incoming };
}

describe("spreadActivation", () => {
  test("orphan node yields A == A_o", () => {
    const edges = buildEdgeIndex([]);
    const own = new Map([["alice", 0.7]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("alice")).toBeCloseTo(0.7, 6);
  });

  test("directed edge boosts only the target, not the source", () => {
    // Edge alice→bob: alice activation flows into bob; bob does NOT push back
    // into alice. alice (a pure source under this graph) keeps its own value.
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.6],
      ["bob", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice has no incoming edges → final == own.
    expect(out.final.get("alice")).toBeCloseTo(0.6, 6);
    // bob's incoming = {alice}: numerator = 0 + 0.5*0.6 = 0.3, denom = 1.5.
    expect(out.final.get("bob")).toBeCloseTo(0.3 / 1.5, 6);
  });

  test("two-cycle (A→B and B→A) lets activation flow both ways", () => {
    // With both directions present, each node is the other's predecessor.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "alice"],
    ]);
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.8],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // alice: incoming {bob}=0.8 → numerator = 0 + 0.5*0.8 = 0.4, denom = 1.5.
    expect(out.final.get("alice")).toBeCloseTo(0.4 / 1.5, 6);
    // bob:   incoming {alice}=0.0 → numerator = 0.8 + 0 = 0.8, denom = 1.5.
    expect(out.final.get("bob")).toBeCloseTo(0.8 / 1.5, 6);
  });

  test("pure source (high outgoing, zero incoming) collapses to final == own", () => {
    // alice → bob → carol; alice has no incoming edges.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
    ]);
    const own = new Map([
      ["alice", 0.5],
      ["bob", 0.0],
      ["carol", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("alice")).toBeCloseTo(0.5, 6);
  });

  test("hops=2 reaches second-degree predecessors but stops there", () => {
    // Directed path: alice → bob → carol → delta
    // From delta's perspective: carol is 1-hop predecessor, bob is 2-hop,
    // alice is 3-hop. Activation on bob (2-hop) reaches delta; activation on
    // alice (3-hop) does NOT.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
      ["carol", "delta"],
    ]);
    const own = new Map([
      ["alice", 1.0], // 3-hop predecessor of delta — must NOT contribute
      ["bob", 1.0], // 2-hop predecessor of delta
      ["carol", 0.0],
      ["delta", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // delta: 1-hop {carol}=0, 2-hop {bob}=1.0.
    //   numerator   = 0 + 0.5*0 + 0.25*1.0 = 0.25
    //   denominator = 1 + 0.5*1 + 0.25*1   = 1.75
    //   A = 0.25 / 1.75 ≈ 0.142857
    expect(out.final.get("delta")).toBeCloseTo(0.25 / 1.75, 6);
  });

  test("output is bounded in [0, 1] for arbitrary inputs", () => {
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "carol"],
      ["alice", "carol"],
    ]);
    const own = new Map([
      ["alice", 1.0],
      ["bob", 1.0],
      ["carol", 1.0],
    ]);
    const out = spreadActivation(own, edges, 0.99, 2);
    for (const [, value] of out.final) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("hops=0 collapses to A == A_o", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0.5, 0);
    expect(out.final.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.final.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("k=0 collapses to A == A_o", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0, 5);
    expect(out.final.get("alice")).toBeCloseTo(0.4, 6);
    expect(out.final.get("bob")).toBeCloseTo(0.9, 6);
  });

  test("predecessors not in the candidate set are dropped from both numerator and denominator", () => {
    // Edge alice→bob: bob has structural predecessor alice, but alice is not
    // in `ownActivation`, so she contributes nothing — hop1 has no active
    // predecessors, so the whole hop drops out of both sides of the ratio.
    // Bob therefore stays at his own activation.
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([["bob", 0.6]]);
    const out = spreadActivation(own, edges, 0.5, 2);
    expect(out.final.get("bob")).toBeCloseTo(0.6, 6);
  });

  test("L_2 norm over multiple active predecessors rewards strong outliers more than avg would", () => {
    // bob has 4 predecessors in the candidate set: one strong, three weak.
    // L_2 = √((0.8² + 0.1² + 0.1² + 0.1²) / 4) = √(0.1675) ≈ 0.40927
    // Plain avg of the same set = 0.275, so L_2 lifts bob more than avg
    // would — the design goal of preferring quality over quantity.
    const edges = buildEdgeIndex([
      ["a1", "bob"],
      ["a2", "bob"],
      ["a3", "bob"],
      ["a4", "bob"],
    ]);
    const own = new Map([
      ["a1", 0.8],
      ["a2", 0.1],
      ["a3", 0.1],
      ["a4", 0.1],
      ["bob", 0.0],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    const rms = Math.sqrt((0.8 * 0.8 + 3 * 0.1 * 0.1) / 4);
    // numerator   = 0 + 0.5 · rms
    // denominator = 1 + 0.5
    expect(out.final.get("bob")).toBeCloseTo((0.5 * rms) / 1.5, 6);
  });

  test("high-in-degree hub with mostly-inactive predecessors stays near A_o", () => {
    // 100 structural predecessors point at hub; only one (`pred0`) is in
    // the candidate set. Inactive structural predecessors affect neither
    // side of the ratio — the structural in-degree never enters the
    // denominator, and the L_2 averages over the single active predecessor.
    const rawEdges: Array<[string, string]> = [];
    for (let i = 0; i < 100; i++) {
      rawEdges.push([`pred${i}`, "hub"]);
    }
    const edges = buildEdgeIndex(rawEdges);
    const own = new Map([
      ["hub", 0.6],
      ["pred0", 0.5],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    // hop1 active = {pred0}, L_2([0.5]) = 0.5.
    //   numerator   = 0.6 + 0.5 · 0.5 = 0.85
    //   denominator = 1 + 0.5         = 1.5
    expect(out.final.get("hub")).toBeCloseTo(0.85 / 1.5, 6);
  });

  test("empty own-activation map returns empty result", () => {
    const out = spreadActivation(
      new Map(),
      buildEdgeIndex([["a", "b"]]),
      0.5,
      2,
    );
    expect(out.final.size).toBe(0);
    expect(out.contribution.size).toBe(0);
  });

  test("contribution equals final - own for each slug", () => {
    // Two-cycle: A→B and B→A so both nodes have predecessors and the spread
    // moves each off its own value in opposite directions.
    const edges = buildEdgeIndex([
      ["alice", "bob"],
      ["bob", "alice"],
    ]);
    const own = new Map([
      ["alice", 0.0],
      ["bob", 0.8],
    ]);
    const out = spreadActivation(own, edges, 0.5, 2);
    for (const [slug, finalValue] of out.final) {
      const ownValue = own.get(slug) ?? 0;
      expect(out.contribution.get(slug)).toBeCloseTo(finalValue - ownValue, 6);
    }
    // alice gained spread (predecessor bob=0.8); bob lost some (predecessor
    // alice=0 dilutes its own 0.8).
    expect(out.contribution.get("alice")).toBeGreaterThan(0);
    expect(out.contribution.get("bob")).toBeLessThan(0);
  });

  test("contribution is 0 for every slug when hops == 0", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0.5, 0);
    expect(out.contribution.get("alice")).toBe(0);
    expect(out.contribution.get("bob")).toBe(0);
  });

  test("contribution is 0 for every slug when k == 0", () => {
    const edges = buildEdgeIndex([["alice", "bob"]]);
    const own = new Map([
      ["alice", 0.4],
      ["bob", 0.9],
    ]);
    const out = spreadActivation(own, edges, 0, 5);
    expect(out.contribution.get("alice")).toBe(0);
    expect(out.contribution.get("bob")).toBe(0);
  });
});
