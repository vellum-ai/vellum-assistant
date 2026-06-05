import { beforeEach, describe, expect, mock, test } from "bun:test";

let seqEnabled = true;
mock.module("@/lib/feature-flags/seq-gap-detection-flag", () => ({
  isSeqGapDetectionEnabled: () => seqEnabled,
}));

const {
  __resetAppliedSeqForTesting,
  getAppliedSeq,
  recordAppliedSeq,
} = await import("@/lib/streaming/applied-seq");
const {
  noteSnapshotApplied,
  reconcileLatestHistorySnapshot,
  reconcileSnapshot,
} = await import("@/domains/chat/utils/reconcile-snapshot");

const { makeServerMessage, messageText, textBody, wireTextBody, wireTimestamp } =
  await import("@/domains/chat/utils/message-test-helpers");

import type { DisplayMessage } from "@/domains/chat/types/types";

function makeLocal(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

beforeEach(() => {
  seqEnabled = true;
  __resetAppliedSeqForTesting();
});

describe("reconcileSnapshot", () => {
  test("flag on: keeps local content when the stream is ahead of the snapshot", () => {
    /**
     * With the flag on the seq-aware merge runs, so a stale snapshot cannot
     * regress the streamed answer.
     */
    // GIVEN the stream has carried the conversation to frontier 10
    recordAppliedSeq("conv-1", 10);
    const local = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("AAA"), timestamp: 1000 }),
    ];
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("BBB"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    // WHEN a snapshot at watermark 5 (behind the frontier) is reconciled
    const result = reconcileSnapshot(local, server, {
      conversationId: "conv-1",
      snapshotSeq: 5,
    });

    // THEN the streamed local content is kept
    expect(messageText(result[0])).toBe("AAA");
  });

  test("flag off: routes to the legacy reconcile (snapshot wins)", () => {
    /**
     * With the flag off the legacy heuristic reconcile runs and the frontier
     * is ignored, so the server snapshot overwrites the local row.
     */
    // GIVEN a frontier exists but the flag is off
    seqEnabled = false;
    recordAppliedSeq("conv-1", 10);
    const local = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("AAA"), timestamp: 1000 }),
    ];
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("BBB"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    // WHEN the snapshot is reconciled
    const result = reconcileSnapshot(local, server, {
      conversationId: "conv-1",
      snapshotSeq: 5,
    });

    // THEN the server content is applied (no seq gate)
    expect(messageText(result[0])).toBe("BBB");
  });
});

describe("reconcileLatestHistorySnapshot", () => {
  test("flag on + stream ahead: keeps the local transcript, ignores the page", () => {
    /**
     * A stale latest page would regress the streamed transcript, so when the
     * stream is ahead the cached local rows are kept as-is.
     */
    // GIVEN the stream is ahead of the latest page watermark
    recordAppliedSeq("conv-1", 10);
    const current = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("live"), timestamp: 1000 }),
    ];
    const latestHistory = [
      makeLocal({ id: "z9", role: "assistant", ...textBody("stale page"), timestamp: 2000 }),
    ];

    // WHEN the latest page (watermark 5) is merged
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      conversationId: "conv-1",
      snapshotSeq: 5,
      isProcessing: false,
    });

    // THEN only the live local row survives
    expect(result).toHaveLength(1);
    expect(result.find((m) => m.id === "z9")).toBeUndefined();
    expect(messageText(result[0])).toBe("live");
  });

  test("flag on + not ahead: merges the latest page in", () => {
    /**
     * When the page is not stale the cache-merge runs so a row the cache
     * missed is recovered.
     */
    // GIVEN no frontier ahead of the page watermark
    const current = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("live"), timestamp: 1000 }),
    ];
    const latestHistory = [
      makeLocal({ id: "z9", role: "assistant", ...textBody("recovered"), timestamp: 2000 }),
    ];

    // WHEN the latest page is merged
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      conversationId: "conv-1",
      snapshotSeq: 50,
      isProcessing: false,
    });

    // THEN the page row is merged into the transcript
    expect(result.find((m) => m.id === "z9")).toBeDefined();
  });

  test("flag off: always merges regardless of the frontier", () => {
    /**
     * The seq gate is gated behind the flag, so with it off the merge runs
     * even when a frontier would otherwise mark the page stale.
     */
    // GIVEN a frontier ahead of the page but the flag is off
    seqEnabled = false;
    recordAppliedSeq("conv-1", 10);
    const current = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("live"), timestamp: 1000 }),
    ];
    const latestHistory = [
      makeLocal({ id: "z9", role: "assistant", ...textBody("page row"), timestamp: 2000 }),
    ];

    // WHEN the latest page is merged
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      conversationId: "conv-1",
      snapshotSeq: 5,
      isProcessing: false,
    });

    // THEN the page row is merged in (no seq gate)
    expect(result.find((m) => m.id === "z9")).toBeDefined();
  });
});

describe("noteSnapshotApplied", () => {
  test("flag on: advances the applied frontier to the snapshot watermark", () => {
    /**
     * After an authoritative snapshot applies, the frontier moves up so later
     * replays of absorbed deltas are no-ops.
     */
    // GIVEN a conversation with no frontier yet
    // WHEN an applied snapshot's watermark is noted
    noteSnapshotApplied("conv-1", 7);

    // THEN the frontier advances to it
    expect(getAppliedSeq("conv-1")).toBe(7);
  });

  test("flag on: never regresses the frontier for a stale snapshot", () => {
    /**
     * The frontier is monotonic, so a stale snapshot below it leaves it
     * untouched.
     */
    // GIVEN the stream already advanced past the snapshot
    recordAppliedSeq("conv-1", 10);

    // WHEN a stale snapshot watermark is noted
    noteSnapshotApplied("conv-1", 5);

    // THEN the frontier holds at the higher value
    expect(getAppliedSeq("conv-1")).toBe(10);
  });

  test("flag off: does not record any frontier", () => {
    /**
     * All seq state is gated behind the flag.
     */
    // GIVEN the flag is off
    seqEnabled = false;

    // WHEN a snapshot watermark is noted
    noteSnapshotApplied("conv-1", 7);

    // THEN no frontier is tracked
    expect(getAppliedSeq("conv-1")).toBeNull();
  });
});
