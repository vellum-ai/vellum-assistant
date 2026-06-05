import { describe, expect, test } from "bun:test";

import { reconcileMessagesWithSeq } from "@/domains/chat/utils/reconcile-with-seq";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  makeServerMessage,
  messageText,
  textBody,
  wireTextBody,
  wireTimestamp,
} from "@/domains/chat/utils/message-test-helpers";

// Test factory that produces a DisplayMessage with `id` assigned. Every
// production construction site assigns `id`; tests must too so the type-level
// requirement holds.
function makeLocal(
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
      makeLocal({
        id: "a1",
        role: "assistant",
        ...textBody("Full streamed answer"),
        timestamp: 1000,
      }),
    ];

    // AND a stale snapshot that carries only a truncated prefix of that row
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("Full str"),
        timestamp: wireTimestamp(1000),
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
      makeLocal({
        id: "a1",
        role: "assistant",
        ...textBody("partial"),
        timestamp: 1000,
      }),
    ];

    // AND a fresher server snapshot of the same row
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("authoritative answer"),
        timestamp: wireTimestamp(1000),
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
      makeLocal({
        id: "a1",
        role: "assistant",
        ...textBody("local"),
        timestamp: 1000,
      }),
    ];
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("server"),
        timestamp: wireTimestamp(1000),
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
      makeLocal({
        id: "a1",
        role: "assistant",
        ...textBody("Streamed answer"),
        timestamp: 1000,
      }),
    ];

    // AND a stale snapshot that also carries a never-seen user row
    const server = [
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("Stream"),
        timestamp: wireTimestamp(1000),
      }),
      makeServerMessage({
        id: "u2",
        role: "user",
        ...wireTextBody("follow-up question"),
        timestamp: wireTimestamp(1100),
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
      makeLocal({
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
      makeLocal({
        id: "a1",
        role: "assistant",
        ...textBody("in-window"),
        timestamp: 1000,
      }),
    ];

    // AND a snapshot carrying an older row from before the window
    const server = [
      makeServerMessage({
        id: "old",
        role: "user",
        ...wireTextBody("ancient history"),
        timestamp: wireTimestamp(10),
      }),
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireTextBody("in-window"),
        timestamp: wireTimestamp(1000),
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
});
