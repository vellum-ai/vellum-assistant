import { describe, expect, test } from "bun:test";

const {
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

describe("reconcileSnapshot", () => {
  test("keeps local content when the stream is ahead of the snapshot", () => {
    /**
     * The seq-aware merge runs, so a stale snapshot cannot regress the
     * streamed answer.
     */
    // GIVEN the stream has carried the conversation to frontier 10
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
      serverSeq: 5,
      localSeq: 10,
    });

    // THEN the streamed local content is kept
    expect(messageText(result[0])).toBe("AAA");
  });
});

describe("reconcileLatestHistorySnapshot", () => {
  test("stream ahead: keeps streamed content but admits new rows", () => {
    /**
     * The initial-load path now routes through the single seq-aware merge, so
     * a stale latest page cannot regress a streamed row, yet genuinely-new
     * history the page carries still flows in.
     */
    // GIVEN the stream is ahead of the latest page watermark
    const current = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("live"), timestamp: 1000 }),
    ];
    // AND the page carries a stale copy of the live row plus a brand-new row
    const latestHistory = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("stale"), timestamp: 1000 }),
      makeLocal({ id: "z9", role: "user", ...textBody("new turn"), timestamp: 1100 }),
    ];

    // WHEN the latest page (watermark 5, behind the frontier) is merged
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      serverSeq: 5,
      localSeq: 10,
    });

    // THEN the streamed row keeps its content AND the new row is admitted
    expect(messageText(result.find((m) => m.id === "a1"))).toBe("live");
    expect(messageText(result.find((m) => m.id === "z9"))).toBe("new turn");
  });

  test("not ahead: snapshot is authoritative", () => {
    /**
     * When the page is not stale (`S >= L`) the seq merge trusts the server,
     * so the page content supersedes the local row.
     */
    // GIVEN no frontier ahead of the page watermark
    const current = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("local"), timestamp: 1000 }),
    ];
    const latestHistory = [
      makeLocal({ id: "a1", role: "assistant", ...textBody("authoritative"), timestamp: 1000 }),
    ];

    // WHEN the latest page is merged
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      serverSeq: 50,
      localSeq: null,
    });

    // THEN the page content wins
    expect(messageText(result.find((m) => m.id === "a1"))).toBe("authoritative");
  });

  test("keeps older-page rows when the loaded-page boundary is passed", () => {
    /**
     * Scroll-up pagination: the snapshot carries pages older than anything
     * rendered locally. With the oldest *loaded* page timestamp as the drop
     * boundary, those rows must survive the merge instead of being discarded
     * as paginated-out history.
     */
    // GIVEN a transcript holding only the latest page
    const current = [
      makeLocal({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];
    // AND a snapshot that also carries a freshly loaded older page
    const latestHistory = [
      makeLocal({ id: "u1", role: "user", ...textBody("older turn"), timestamp: 1000 }),
      makeLocal({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];

    // WHEN merged with the oldest loaded-page timestamp as the boundary
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      serverSeq: 50,
      localSeq: 50,
      oldestPageTimestamp: 1000,
    });

    // THEN the older-page row is kept, in order
    expect(result.map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(messageText(result[0])).toBe("older turn");
  });

  test("drops older snapshot rows when no loaded-page boundary is passed", () => {
    /**
     * Without the boundary the merge falls back to the oldest local row, so
     * out-of-window history cannot be pulled back in — the original purpose
     * of the paginated-out guard.
     */
    // GIVEN a transcript holding only the latest page
    const current = [
      makeLocal({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];
    // AND a snapshot carrying a row older than the local window
    const latestHistory = [
      makeLocal({ id: "u1", role: "user", ...textBody("older turn"), timestamp: 1000 }),
      makeLocal({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];

    // WHEN merged without a loaded-page boundary
    const result = reconcileLatestHistorySnapshot(current, latestHistory, {
      serverSeq: 50,
      localSeq: 50,
    });

    // THEN the out-of-window row stays dropped
    expect(result.map((m) => m.id)).toEqual(["u2"]);
  });
});

