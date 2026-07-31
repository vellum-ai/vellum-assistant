import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetLocalSeqForTesting,
  getLocalSeq,
  getLocalSeqGeneration,
  recordLocalSeq,
} from "@/lib/streaming/local-seq";

// Frontiers recorded by these tests belong to seq generation 0 unless a case
// exercises the generation tag explicitly.
const GEN_0 = 0;

beforeEach(() => {
  __resetLocalSeqForTesting();
});

describe("local-seq", () => {
  test("returns null for a conversation the stream has never advanced", () => {
    /**
     * Before any event applies, the frontier is unknown so the merge falls
     * back to treating the snapshot as authoritative.
     */
    // GIVEN no event has been applied to a conversation
    // WHEN the frontier is read
    const seq = getLocalSeq("conv-1");

    // THEN there is no frontier
    expect(seq).toBeNull();
  });

  test("tracks the local seq per conversation", () => {
    /**
     * `seq` is a global counter but the frontier is per-conversation, so one
     * conversation's stream progress must not leak into another's.
     */
    // GIVEN two conversations have applied different events
    recordLocalSeq("conv-1", 10, GEN_0);
    recordLocalSeq("conv-2", 25, GEN_0);

    // WHEN each frontier is read
    // THEN each conversation keeps its own value
    expect(getLocalSeq("conv-1")).toBe(10);
    expect(getLocalSeq("conv-2")).toBe(25);
  });

  test("advances the frontier when a higher seq is applied", () => {
    /**
     * A later event carries the conversation further forward.
     */
    // GIVEN a conversation already advanced to seq 10
    recordLocalSeq("conv-1", 10, GEN_0);

    // WHEN a higher seq is applied
    recordLocalSeq("conv-1", 15, GEN_0);

    // THEN the frontier moves forward
    expect(getLocalSeq("conv-1")).toBe(15);
  });

  test("never regresses the frontier when a lower seq is applied", () => {
    /**
     * The frontier is monotonic: a replayed or out-of-order event with a
     * lower seq must not pull it backwards, or a stale event could be
     * mistaken for new progress.
     */
    // GIVEN a conversation advanced to seq 20
    recordLocalSeq("conv-1", 20, GEN_0);

    // WHEN a lower (replayed) seq is applied
    recordLocalSeq("conv-1", 5, GEN_0);

    // THEN the frontier holds at the higher value
    expect(getLocalSeq("conv-1")).toBe(20);
  });

  test("holds the frontier when the same seq is applied again", () => {
    /**
     * Re-delivering the exact frontier event (reconnect overlap) is a no-op.
     */
    // GIVEN a conversation at seq 12
    recordLocalSeq("conv-1", 12, GEN_0);

    // WHEN the same seq is applied again
    recordLocalSeq("conv-1", 12, GEN_0);

    // THEN the frontier is unchanged
    expect(getLocalSeq("conv-1")).toBe(12);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const)(
    "ignores a %s seq and leaves the frontier untouched",
    (_label, value) => {
      /**
       * A non-finite seq carries no position to advance to, so it must not
       * disturb the existing frontier.
       */
      // GIVEN a conversation with a frontier
      recordLocalSeq("conv-1", 10, GEN_0);

      // WHEN a non-honest value is applied
      recordLocalSeq("conv-1", value, GEN_0);

      // THEN the frontier is preserved
      expect(getLocalSeq("conv-1")).toBe(10);
    },
  );
});

describe("local-seq — generation tag", () => {
  test("has no generation before the stream has advanced a conversation", () => {
    // GIVEN no event has been applied
    // THEN there is no generation to read
    expect(getLocalSeqGeneration("conv-1")).toBeNull();
  });

  test("tags the frontier with the generation its value belongs to", () => {
    // GIVEN a frontier recorded under generation 2
    recordLocalSeq("conv-1", 10, 2);

    // THEN both the value and its generation are readable
    expect(getLocalSeq("conv-1")).toBe(10);
    expect(getLocalSeqGeneration("conv-1")).toBe(2);
  });

  test("adopts the new value's generation when the frontier advances", () => {
    /**
     * A `/messages` anchor from a pre-reset generation can land a higher value
     * on a live frontier; the tag must follow that value so the stale-frontier
     * guard sees the anchor's (older) generation, not the live one it replaced.
     */
    // GIVEN a frontier at seq 10 in the current generation 1
    recordLocalSeq("conv-1", 10, 1);

    // WHEN a higher value from an older generation 0 is recorded
    recordLocalSeq("conv-1", 900, 0);

    // THEN the frontier advances and adopts the older generation tag
    expect(getLocalSeq("conv-1")).toBe(900);
    expect(getLocalSeqGeneration("conv-1")).toBe(0);
  });

  test("holds the generation tag when a lower value does not advance", () => {
    // GIVEN a frontier at seq 900 in generation 0
    recordLocalSeq("conv-1", 900, 0);

    // WHEN a lower value from a newer generation is recorded (a no-op advance)
    recordLocalSeq("conv-1", 50, 1);

    // THEN the frontier and its generation are both unchanged
    expect(getLocalSeq("conv-1")).toBe(900);
    expect(getLocalSeqGeneration("conv-1")).toBe(0);
  });
});
