import { describe, expect, test } from "bun:test";

import type { EvalKeyEntry } from "../eval-packets.js";
import {
  binomialTwoSidedSignP,
  type JudgeVerdict,
  tallyVerdicts,
} from "../eval-tally.js";

/**
 * Build N single-vote turns where set A is always the snapshot, so the mapped
 * tally is exactly (snapWins snapshot, stageWins staging, tieN ties). Used for
 * the count-driven verdict tests; per-turn shuffle is exercised separately.
 */
function buildAllASnapshot(snapWins: number, stageWins: number, tieN: number) {
  const verdicts: JudgeVerdict[] = [];
  const key: EvalKeyEntry[] = [];
  let i = 0;
  const push = (winner: "A" | "B" | "tie", sa: number, sb: number) => {
    const turn = `t${i++}`;
    key.push({ turn, a: "snapshot", b: "staging" });
    verdicts.push({ turn, winner, scoreA: sa, scoreB: sb });
  };
  for (let n = 0; n < snapWins; n++) push("A", 7, 6); // snapshot (A) wins by 1
  for (let n = 0; n < stageWins; n++) push("B", 6, 7); // staging (B) wins by 1
  for (let n = 0; n < tieN; n++) push("tie", 5, 5);
  return { verdicts, key };
}

describe("binomialTwoSidedSignP", () => {
  test("no decided turns → 1", () => {
    expect(binomialTwoSidedSignP(0, 0)).toBe(1);
  });
  test("a near coin-flip split is not significant", () => {
    expect(binomialTwoSidedSignP(12, 11)).toBeGreaterThan(0.5);
  });
  test("a lopsided split is significant", () => {
    expect(binomialTwoSidedSignP(25, 4)).toBeLessThan(0.001);
  });
  test("is symmetric in its arguments", () => {
    expect(binomialTwoSidedSignP(25, 4)).toBeCloseTo(
      binomialTwoSidedSignP(4, 25),
    );
  });
  test("a clean sweep is significant", () => {
    expect(binomialTwoSidedSignP(15, 0)).toBeLessThan(0.05);
  });
});

describe("tallyVerdicts — verdict gating", () => {
  test("a 12-11 split is a TIE (within noise), not a loss — passes the gate", () => {
    // The field-run shape that a hand tally mis-read as a decisive loss.
    const { verdicts, key } = buildAllASnapshot(12, 11, 7);
    const r = tallyVerdicts(verdicts, key);
    expect(r.snapshotWins).toBe(12);
    expect(r.stagingWins).toBe(11);
    expect(r.ties).toBe(7);
    expect(r.signTestP).toBeGreaterThan(0.05);
    expect(r.verdict).toBe("tie");
    expect(r.gate).toBe("pass");
    // Single-vote panel → not confident; the note nudges toward a real panel.
    expect(r.confident).toBe(false);
    expect(r.notes.some((n) => /panel/i.test(n))).toBe(true);
  });

  test("a significant snapshot lead is a LOSS — fails the gate", () => {
    const { verdicts, key } = buildAllASnapshot(25, 4, 1);
    const r = tallyVerdicts(verdicts, key);
    expect(r.signTestP).toBeLessThan(0.05);
    expect(r.verdict).toBe("wiki-loses");
    expect(r.gate).toBe("fail");
  });

  test("a significant staging lead is a WIN — passes the gate", () => {
    const { verdicts, key } = buildAllASnapshot(3, 20, 7);
    const r = tallyVerdicts(verdicts, key);
    expect(r.verdict).toBe("wiki-wins");
    expect(r.gate).toBe("pass");
  });
});

describe("tallyVerdicts — unblinding + panels", () => {
  test("maps the winner through the per-turn key (A is not always snapshot)", () => {
    const key: EvalKeyEntry[] = [
      { turn: "s1", a: "snapshot", b: "staging" },
      { turn: "s2", a: "staging", b: "snapshot" }, // shuffled: A is staging here
    ];
    const verdicts: JudgeVerdict[] = [
      { turn: "s1", winner: "A", scoreA: 8, scoreB: 3 }, // A=snapshot wins
      { turn: "s2", winner: "A", scoreA: 8, scoreB: 3 }, // A=staging wins
    ];
    const r = tallyVerdicts(verdicts, key, { minDecided: 1, minPanel: 1 });
    expect(r.snapshotWins).toBe(1);
    expect(r.stagingWins).toBe(1);
    // s1: snap=8/stage=3; s2: staging=8/snapshot=3 → both per-corpus means = 5.5
    expect(r.meanSnapshot).toBeCloseTo(5.5);
    expect(r.meanStaging).toBeCloseTo(5.5);
  });

  test("a panel decides each turn by majority before the set tally", () => {
    const key: EvalKeyEntry[] = [{ turn: "p1", a: "snapshot", b: "staging" }];
    const verdicts: JudgeVerdict[] = [
      { turn: "p1", winner: "B", scoreA: 5, scoreB: 8 }, // staging
      { turn: "p1", winner: "B", scoreA: 4, scoreB: 7 }, // staging
      { turn: "p1", winner: "A", scoreA: 7, scoreB: 6 }, // snapshot
    ];
    const r = tallyVerdicts(verdicts, key, { minDecided: 1, minPanel: 3 });
    expect(r.turns).toBe(1);
    expect(r.stagingWins).toBe(1); // 2 of 3 judges → staging
    expect(r.snapshotWins).toBe(0);
    expect(r.panel.mean).toBe(3);
  });

  test("ignores verdicts with no matching key entry", () => {
    const key: EvalKeyEntry[] = [{ turn: "k1", a: "snapshot", b: "staging" }];
    const verdicts: JudgeVerdict[] = [
      { turn: "k1", winner: "A", scoreA: 7, scoreB: 5 },
      { turn: "ghost", winner: "B", scoreA: 1, scoreB: 9 },
    ];
    const r = tallyVerdicts(verdicts, key, { minDecided: 1, minPanel: 1 });
    expect(r.unmatchedVerdicts).toBe(1);
    expect(r.turns).toBe(1);
    expect(r.snapshotWins).toBe(1);
  });

  test("derives the winner from scores when `winner` is absent", () => {
    const key: EvalKeyEntry[] = [{ turn: "d1", a: "snapshot", b: "staging" }];
    const verdicts = [{ turn: "d1", scoreA: 9, scoreB: 2 }] as JudgeVerdict[];
    const r = tallyVerdicts(verdicts, key, { minDecided: 1, minPanel: 1 });
    expect(r.snapshotWins).toBe(1);
  });

  test("no matched verdicts → empty tally with an explanatory note", () => {
    const r = tallyVerdicts([], [{ turn: "x", a: "snapshot", b: "staging" }]);
    expect(r.turns).toBe(0);
    expect(r.gate).toBe("pass"); // nothing decided → not a loss
    expect(r.notes.some((n) => /no verdicts matched/i.test(n))).toBe(true);
  });
});
