import { describe, expect, test } from "bun:test";

import { reconcileMessagesWithSeq } from "@/domains/chat/utils/reconcile-with-seq";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  messageText,
  textBody,
} from "@/domains/chat/utils/message-test-helpers";

// Both sides of the merge are `DisplayMessage[]` (callers project the wire
// snapshot at the reconcile boundary), so local and server rows share one
// factory. `id` is assigned because every production construction site assigns
// it, so the type-level requirement holds.
function makeRow(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

describe("reconcileMessagesWithSeq", () => {
  test("keeps the live local row when the snapshot is stale (F > S)", () => {
    /**
     * The core ATL-781 fix: a debounced snapshot whose watermark sits behind
     * the applied frontier must not regress the text the stream already
     * rendered.
     */
    // GIVEN a fully-streamed assistant row applied by the stream
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("Full streamed answer"),
        timestamp: 1000,
      }),
    ];

    // AND a stale snapshot that carries only a truncated prefix of that row
    const server = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("Full str"),
        timestamp: 1000,
      }),
    ];

    // WHEN the snapshot watermark S is below the applied frontier F
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 5,
      appliedSeq: 10,
    });

    // THEN the streamed text is preserved (the stale snapshot is ignored)
    expect(result).toHaveLength(1);
    expect(messageText(result[0])).toBe("Full streamed answer");
    expect(result[0]!.id).toBe("a1");
  });

  test("takes the server row wholesale when the snapshot is fresh (S >= F)", () => {
    /**
     * A snapshot that has seen everything the stream applied is authoritative,
     * so the server copy wins.
     */
    // GIVEN a local row the snapshot supersedes
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("partial"),
        timestamp: 1000,
      }),
    ];

    // AND a fresher server snapshot of the same row
    const server = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("authoritative answer"),
        timestamp: 1000,
      }),
    ];

    // WHEN the snapshot watermark S is at or above the applied frontier F
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 10,
      appliedSeq: 5,
    });

    // THEN the server content replaces the local row
    expect(result).toHaveLength(1);
    expect(messageText(result[0])).toBe("authoritative answer");
  });

  test("treats the snapshot as authoritative when seq is unknown", () => {
    /**
     * With no honest seq on either side the merge cannot prove the stream is
     * ahead, so it falls back to trusting the server snapshot.
     */
    // GIVEN a local row and a differing server row
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("local"),
        timestamp: 1000,
      }),
    ];
    const server = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("server"),
        timestamp: 1000,
      }),
    ];

    // WHEN the snapshot watermark is unknown even though a frontier exists
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: null,
      appliedSeq: 10,
    });

    // THEN the server content is applied
    expect(messageText(result[0])).toBe("server");
  });

  test("admits brand-new server rows even while the snapshot is stale", () => {
    /**
     * The stale-snapshot gate only protects rows the stream already advanced;
     * genuinely new history the local transcript has never seen must still flow
     * in.
     */
    // GIVEN a live local assistant row
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("Streamed answer"),
        timestamp: 1000,
      }),
    ];

    // AND a stale snapshot that also carries a never-seen user row
    const server = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("Stream"),
        timestamp: 1000,
      }),
      makeRow({
        id: "u2",
        role: "user",
        ...textBody("follow-up question"),
        timestamp: 1100,
      }),
    ];

    // WHEN the snapshot is stale (F > S)
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 5,
      appliedSeq: 10,
    });

    // THEN the live row keeps its streamed text AND the new row is added
    expect(result).toHaveLength(2);
    const assistant = result.find((m) => m.id === "a1");
    const user = result.find((m) => m.id === "u2");
    expect(messageText(assistant)).toBe("Streamed answer");
    expect(messageText(user)).toBe("follow-up question");
  });

  test("returns the original local array unchanged for an empty snapshot", () => {
    /**
     * An empty snapshot carries no authority, so the merge is a no-op and the
     * caller's reference-equality stability check holds.
     */
    // GIVEN a local transcript with no duplicates
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("answer"),
        timestamp: 1000,
      }),
    ];

    // WHEN an empty server snapshot is merged
    const result = reconcileMessagesWithSeq(local, [], {
      snapshotSeq: 5,
      appliedSeq: 10,
    });

    // THEN the same local rows come back
    expect(result).toEqual(local);
  });

  test("drops paginated-out server history older than the window boundary", () => {
    /**
     * A snapshot must not pull history that scrolled out of the current window
     * back into view.
     */
    // GIVEN a local window whose oldest row is at t=1000
    const local = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("in-window"),
        timestamp: 1000,
      }),
    ];

    // AND a snapshot carrying an older row from before the window
    const server = [
      makeRow({
        id: "old",
        role: "user",
        ...textBody("ancient history"),
        timestamp: 10,
      }),
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("in-window"),
        timestamp: 1000,
      }),
    ];

    // WHEN the merge runs with the oldest-page boundary set
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 10,
      appliedSeq: 5,
      oldestPageTimestamp: 1000,
    });

    // THEN the pre-window row is dropped
    expect(result.find((m) => m.id === "old")).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  test("folds an optimistic assistant tail into the confirmed server row", () => {
    /**
     * Against pre-anchor-protocol daemons a streamed assistant delta arrives
     * with no `messageId`, so the live row stays optimistic with a client
     * UUID. When the snapshot carries the same turn under its server id the
     * optimistic prefix must collapse into it, not render as a second bubble.
     */
    // GIVEN an optimistic assistant tail (client UUID) holding a streamed prefix
    const local = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({
        id: "client-uuid",
        isOptimistic: true,
        role: "assistant",
        ...textBody("Hello"),
        timestamp: 1001,
      }),
    ];

    // AND a snapshot carrying the same assistant turn under its server id
    const server = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({
        id: "srv-a1",
        role: "assistant",
        ...textBody("Hello there"),
        timestamp: 1001,
      }),
    ];

    // WHEN the merge runs with no honest seq (snapshot authoritative)
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: null,
      appliedSeq: null,
    });

    // THEN the optimistic prefix collapses into the single server row
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.id).toBe("srv-a1");
    expect(messageText(assistants[0])).toBe("Hello there");
  });

  test("returns the same reference when the snapshot has not advanced the frontier", () => {
    /**
     * Stability is seq-driven: a snapshot at or behind the applied frontier
     * carries no new content for an existing row, and an identical row-id
     * sequence proves the merge was structurally a no-op — so the original
     * reference comes back without a deep content comparison.
     */
    // GIVEN a local transcript
    const local = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1001 }),
    ];

    // AND a snapshot of the same rows at a watermark behind the frontier
    const server = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1001 }),
    ];

    // WHEN the snapshot has not advanced the frontier (S <= F)
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 5,
      appliedSeq: 10,
    });

    // THEN the original reference is returned (no-op merge)
    expect(result).toBe(local);
  });

  test("returns a new result when the snapshot advances the frontier, even with identical row ids", () => {
    /**
     * The case a row-id walk alone would miss: the row set is unchanged but the
     * snapshot advanced the frontier (`S > F`), so an existing row's content
     * genuinely changed and the authoritative server copy must surface.
     */
    // GIVEN a local row
    const local = [
      makeRow({ id: "a1", role: "assistant", ...textBody("v1"), timestamp: 1000 }),
    ];

    // AND a fresher snapshot of the same row id with updated content
    const server = [
      makeRow({ id: "a1", role: "assistant", ...textBody("v2"), timestamp: 1000 }),
    ];

    // WHEN the snapshot advances the frontier (S > F)
    const result = reconcileMessagesWithSeq(local, server, {
      snapshotSeq: 10,
      appliedSeq: 5,
    });

    // THEN a new result carrying the updated content surfaces
    expect(result).not.toBe(local);
    expect(messageText(result[0])).toBe("v2");
  });

  test("falls back to content equality for reference stability when seq is unknown", () => {
    /**
     * On the no-seq skew path there is no watermark to trust, so a structural
     * content comparison still lets the reconciliation poll loop settle by
     * returning the original reference for a no-op merge.
     */
    // GIVEN a local transcript and a snapshot that introduces nothing
    const local = [
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1000 }),
    ];

    // WHEN the merge runs with no honest seq and no new server content
    const result = reconcileMessagesWithSeq(local, [], {
      snapshotSeq: null,
      appliedSeq: null,
    });

    // THEN the original reference is returned
    expect(result).toBe(local);
  });
});
