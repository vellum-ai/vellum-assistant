import { describe, expect, test } from "bun:test";

import { aggregate, evalTurn, recallAtK } from "../harness/metrics.js";
import type { RetrievalOutput } from "../harness/retriever.js";

function out(
  selected: string[],
  sourceBySlug: Record<string, string> = {},
): RetrievalOutput {
  return {
    selectedSlugs: selected,
    sourceBySlug: new Map(Object.entries(sourceBySlug)),
  };
}

describe("harness/metrics recallAtK", () => {
  test("fraction of ground truth recovered within k", () => {
    const gt = new Set(["a", "b", "c", "d"]);
    expect(recallAtK(["a", "b", "x"], gt, 10)).toBeCloseTo(0.5);
    // only the top-2 selections count toward recall@2
    expect(recallAtK(["a", "b", "c", "d"], gt, 2)).toBeCloseTo(0.5);
    expect(recallAtK(["a", "b", "c", "d"], gt, 10)).toBeCloseTo(1);
  });

  test("empty ground truth is vacuously complete (recall 1)", () => {
    expect(recallAtK([], new Set<string>(), 5)).toBe(1);
  });

  test("duplicate selections cannot push recall above 1.0", () => {
    // A retriever emitting the same slug twice must not double-count it.
    expect(recallAtK(["a", "a"], new Set(["a"]), 10)).toBe(1);
    // Duplicates inside the top-k window still count once.
    const gt = new Set(["a", "b"]);
    expect(recallAtK(["a", "a", "b"], gt, 10)).toBeCloseTo(1);
    expect(recallAtK(["a", "a", "b"], gt, 2)).toBeCloseTo(0.5);
  });
});

describe("harness/metrics evalTurn", () => {
  test("hits / misses / extras and per-lane attribution", () => {
    const e = evalTurn(
      out(["a", "b", "z"], { a: "tree", b: "sparse", z: "dense" }),
      ["a", "b", "c"],
      [5],
    );
    expect(e.hits.sort()).toEqual(["a", "b"]);
    expect(e.misses).toEqual(["c"]);
    // selected but not in ground truth — reported as diff, not error
    expect(e.extras).toEqual(["z"]);
    expect(e.recallAtK[5]).toBeCloseTo(2 / 3);
    expect(e.hitsByLane).toEqual({ tree: 1, sparse: 1 });
  });

  test("failureReason surfaces and recall is 0", () => {
    const o: RetrievalOutput = {
      selectedSlugs: [],
      sourceBySlug: new Map(),
      failureReason: "no_provider",
    };
    const e = evalTurn(o, ["a"], [5]);
    expect(e.failureReason).toBe("no_provider");
    expect(e.recallAtK[5]).toBe(0);
  });
});

describe("harness/metrics aggregate", () => {
  test("means recall@k and failure rate across turns", () => {
    const ks = [5];
    const t1 = evalTurn(out(["a"]), ["a"], ks); // recall 1
    const t2 = evalTurn(out([]), ["a"], ks); // recall 0
    const agg = aggregate([t1, t2], ks);
    expect(agg.turns).toBe(2);
    expect(agg.meanRecallAtK[5]).toBeCloseTo(0.5);
    expect(agg.failureRate).toBe(0);
  });

  test("empty input is well-defined", () => {
    const agg = aggregate([], [5]);
    expect(agg.turns).toBe(0);
    expect(agg.meanRecallAtK[5]).toBe(0);
    expect(agg.failureRate).toBe(0);
  });
});
