import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetSnapshotSeqForTesting,
  getSnapshotSeq,
  recordSnapshotSeq,
} from "@/lib/streaming/snapshot-seq";

beforeEach(() => {
  __resetSnapshotSeqForTesting();
});

describe("snapshot-seq", () => {
  test("returns null for a conversation that has never recorded a seq", () => {
    /**
     * Before any snapshot loads, consumers must see "no honest position"
     * so they fall back to cold-start behavior.
     */
    // GIVEN no snapshot has been recorded
    // WHEN the baseline is read
    const seq = getSnapshotSeq("K");

    // THEN there is no position
    expect(seq).toBeNull();
  });

  test("records and returns a numeric seq per conversation", () => {
    /**
     * The baseline is keyed by conversation so independent conversations
     * do not clobber each other's positions.
     */
    // GIVEN two conversations report different persisted seqs
    recordSnapshotSeq("A", 10);
    recordSnapshotSeq("B", 25);

    // WHEN each baseline is read
    // THEN each conversation keeps its own value
    expect(getSnapshotSeq("A")).toBe(10);
    expect(getSnapshotSeq("B")).toBe(25);
  });

  test("a later record overwrites the prior seq for the same conversation", () => {
    /**
     * Each fresh snapshot load is authoritative, so the newest seq wins.
     */
    // GIVEN a conversation already has a baseline
    recordSnapshotSeq("A", 10);

    // WHEN a newer snapshot reports a higher seq
    recordSnapshotSeq("A", 11);

    // THEN the baseline reflects the latest snapshot
    expect(getSnapshotSeq("A")).toBe(11);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)(
    "treats %s as no position and clears any prior baseline",
    (_label, value) => {
      /**
       * A null/absent/non-finite seq means the daemon has no honest
       * position; a stale prior value must not survive it.
       */
      // GIVEN a conversation with a recorded baseline
      recordSnapshotSeq("A", 10);

      // WHEN a non-honest value is recorded
      recordSnapshotSeq("A", value);

      // THEN the baseline is cleared
      expect(getSnapshotSeq("A")).toBeNull();
    },
  );
});
