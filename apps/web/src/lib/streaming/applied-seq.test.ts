import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetAppliedSeqForTesting,
  getAppliedSeq,
  recordAppliedSeq,
} from "@/lib/streaming/applied-seq";

beforeEach(() => {
  __resetAppliedSeqForTesting();
});

describe("applied-seq", () => {
  test("returns null for a conversation the stream has never advanced", () => {
    /**
     * Before any event applies, the frontier is unknown so the merge falls
     * back to treating the snapshot as authoritative.
     */
    // GIVEN no event has been applied to a conversation
    // WHEN the frontier is read
    const seq = getAppliedSeq("conv-1");

    // THEN there is no frontier
    expect(seq).toBeNull();
  });

  test("tracks the applied frontier per conversation", () => {
    /**
     * `seq` is a global counter but the frontier is per-conversation, so one
     * conversation's stream progress must not leak into another's.
     */
    // GIVEN two conversations have applied different events
    recordAppliedSeq("conv-1", 10);
    recordAppliedSeq("conv-2", 25);

    // WHEN each frontier is read
    // THEN each conversation keeps its own value
    expect(getAppliedSeq("conv-1")).toBe(10);
    expect(getAppliedSeq("conv-2")).toBe(25);
  });

  test("advances the frontier when a higher seq is applied", () => {
    /**
     * A later event carries the conversation further forward.
     */
    // GIVEN a conversation already advanced to seq 10
    recordAppliedSeq("conv-1", 10);

    // WHEN a higher seq is applied
    recordAppliedSeq("conv-1", 15);

    // THEN the frontier moves forward
    expect(getAppliedSeq("conv-1")).toBe(15);
  });

  test("never regresses the frontier when a lower seq is applied", () => {
    /**
     * The frontier is monotonic: a replayed or out-of-order event with a
     * lower seq must not pull it backwards, or a stale event could be
     * mistaken for new progress.
     */
    // GIVEN a conversation advanced to seq 20
    recordAppliedSeq("conv-1", 20);

    // WHEN a lower (replayed) seq is applied
    recordAppliedSeq("conv-1", 5);

    // THEN the frontier holds at the higher value
    expect(getAppliedSeq("conv-1")).toBe(20);
  });

  test("holds the frontier when the same seq is applied again", () => {
    /**
     * Re-delivering the exact frontier event (reconnect overlap) is a no-op.
     */
    // GIVEN a conversation at seq 12
    recordAppliedSeq("conv-1", 12);

    // WHEN the same seq is applied again
    recordAppliedSeq("conv-1", 12);

    // THEN the frontier is unchanged
    expect(getAppliedSeq("conv-1")).toBe(12);
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
      recordAppliedSeq("conv-1", 10);

      // WHEN a non-honest value is applied
      recordAppliedSeq("conv-1", value);

      // THEN the frontier is preserved
      expect(getAppliedSeq("conv-1")).toBe(10);
    },
  );
});
