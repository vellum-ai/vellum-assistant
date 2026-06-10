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
  test("keeps the live local row when the snapshot is stale (L > S)", () => {
    /**
     * The core ATL-781 fix: a debounced snapshot whose watermark sits behind
     * the local seq must not regress the text the stream already
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

    // WHEN the server seq S is below the local seq L
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 5,
      localSeq: 10,
    });

    // THEN the streamed text is preserved (the stale snapshot is ignored)
    expect(result).toHaveLength(1);
    expect(messageText(result[0])).toBe("Full streamed answer");
    expect(result[0]!.id).toBe("a1");
  });

  test("takes the server row wholesale when the snapshot is fresh (S >= L)", () => {
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

    // WHEN the server seq S is at or above the local seq L
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 10,
      localSeq: 5,
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

    // WHEN the server seq is unknown even though a frontier exists
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: 10,
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

    // WHEN the snapshot is stale (L > S)
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 5,
      localSeq: 10,
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
      serverSeq: 5,
      localSeq: 10,
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
      serverSeq: 10,
      localSeq: 5,
      oldestPageTimestamp: 1000,
    });

    // THEN the pre-window row is dropped
    expect(result.find((m) => m.id === "old")).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  test("keeps older-page rows covered by the loaded-page boundary", () => {
    /**
     * Scroll-up pagination: the snapshot carries pages older than anything
     * rendered locally. With the oldest *loaded* page timestamp as the drop
     * boundary, those rows must survive the merge instead of being discarded
     * as paginated-out history.
     */
    // GIVEN a transcript holding only the latest page
    const local = [
      makeRow({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];
    // AND a snapshot that also carries a freshly loaded older page
    const server = [
      makeRow({ id: "u1", role: "user", ...textBody("older turn"), timestamp: 1000 }),
      makeRow({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];

    // WHEN merged with the oldest loaded-page timestamp as the boundary
    const result = reconcileMessagesWithSeq(local, server, {
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
    const local = [
      makeRow({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];
    // AND a snapshot carrying a row older than the local window
    const server = [
      makeRow({ id: "u1", role: "user", ...textBody("older turn"), timestamp: 1000 }),
      makeRow({ id: "u2", role: "user", ...textBody("recent"), timestamp: 2000 }),
    ];

    // WHEN merged without a loaded-page boundary
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 50,
      localSeq: 50,
    });

    // THEN the out-of-window row stays dropped
    expect(result.map((m) => m.id)).toEqual(["u2"]);
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
      serverSeq: null,
      localSeq: null,
    });

    // THEN the optimistic prefix collapses into the single server row
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.id).toBe("srv-a1");
    expect(messageText(assistants[0])).toBe("Hello there");
  });

  test("folds an optimistic user row into its server echo by clientMessageId", () => {
    /**
     * The originating client's optimistic user send carries the nonce it
     * minted. When the snapshot echoes that nonce back on the persisted row
     * the optimistic row must collapse into it by identity — independent of
     * text, so server-side normalization can't spawn a duplicate bubble.
     */
    // GIVEN an optimistic user row carrying its nonce and pre-normalized text
    const local = [
      makeRow({
        id: "nonce-1",
        clientMessageId: "nonce-1",
        isOptimistic: true,
        role: "user",
        ...textBody("  hello  "),
        timestamp: 1000,
      }),
    ];

    // AND a snapshot echoing the same nonce under a server id with normalized text
    const server = [
      makeRow({
        id: "srv-1",
        clientMessageId: "nonce-1",
        role: "user",
        ...textBody("hello"),
        timestamp: 1000,
      }),
    ];

    // WHEN the merge runs with an authoritative snapshot
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: null,
    });

    // THEN the optimistic row collapses into the single server row
    const users = result.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("srv-1");
  });

  test("folds each optimistic user row to its own server echo across two in-flight sends", () => {
    /**
     * Two quick-succession sends each carry a distinct nonce. Identity
     * correlation folds each optimistic row into its matching server row —
     * a recency heuristic could collapse both into the latest server row.
     */
    // GIVEN two optimistic user rows with distinct nonces
    const local = [
      makeRow({
        id: "n1",
        clientMessageId: "n1",
        isOptimistic: true,
        role: "user",
        ...textBody("first"),
        timestamp: 1000,
      }),
      makeRow({
        id: "n2",
        clientMessageId: "n2",
        isOptimistic: true,
        role: "user",
        ...textBody("second"),
        timestamp: 1001,
      }),
    ];

    // AND a snapshot echoing both nonces under their server ids
    const server = [
      makeRow({
        id: "srv-1",
        clientMessageId: "n1",
        role: "user",
        ...textBody("first"),
        timestamp: 1000,
      }),
      makeRow({
        id: "srv-2",
        clientMessageId: "n2",
        role: "user",
        ...textBody("second"),
        timestamp: 1001,
      }),
    ];

    // WHEN the merge runs with an authoritative snapshot
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: null,
    });

    // THEN each optimistic row folds into its own server echo, no duplicates
    const users = result.filter((m) => m.role === "user");
    expect(users.map((m) => m.id)).toEqual(["srv-1", "srv-2"]);
  });

  test("folds an optimistic user row by recency when the daemon echoes no nonce", () => {
    /**
     * A daemon that predates the idempotency contract persists no nonce, so
     * the server row carries no `clientMessageId`. The optimistic row then
     * folds into the most recent server user row — the single in-flight send
     * in the common case.
     */
    // GIVEN an optimistic user row whose nonce the server never echoes
    const local = [
      makeRow({
        id: "nonce-q",
        clientMessageId: "nonce-q",
        isOptimistic: true,
        role: "user",
        ...textBody("queued message"),
        timestamp: 1000,
      }),
    ];

    // AND a snapshot whose server row carries no clientMessageId
    const server = [
      makeRow({
        id: "srv-legacy",
        role: "user",
        ...textBody("queued message"),
        timestamp: 1000,
      }),
    ];

    // WHEN the merge runs with an authoritative snapshot
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: null,
    });

    // THEN the optimistic row collapses into the single server row
    const users = result.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("srv-legacy");
  });

  test("keeps both optimistic rows when two legacy sends share no echoed nonce", () => {
    /**
     * Against a pre-idempotency daemon neither server row carries a nonce, so
     * both optimistic rows fall to the recency branch. Claiming a folded
     * server row keeps the second optimistic row from collapsing onto the same
     * server row, so no message is dropped from the transcript.
     */
    // GIVEN two optimistic user rows whose nonces the server never echoes
    const local = [
      makeRow({
        id: "nonce-a",
        clientMessageId: "nonce-a",
        isOptimistic: true,
        role: "user",
        ...textBody("first"),
        timestamp: 1000,
      }),
      makeRow({
        id: "nonce-b",
        clientMessageId: "nonce-b",
        isOptimistic: true,
        role: "user",
        ...textBody("second"),
        timestamp: 1001,
      }),
    ];

    // AND a snapshot whose two server rows both carry no clientMessageId
    const server = [
      makeRow({
        id: "srv-legacy-1",
        role: "user",
        ...textBody("first"),
        timestamp: 1000,
      }),
      makeRow({
        id: "srv-legacy-2",
        role: "user",
        ...textBody("second"),
        timestamp: 1001,
      }),
    ];

    // WHEN the merge runs with an authoritative snapshot
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: null,
    });

    // THEN both server rows survive — neither optimistic row is dropped
    const users = result.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users.map((m) => m.id).sort()).toEqual([
      "srv-legacy-1",
      "srv-legacy-2",
    ]);
  });

  test("returns the same reference for a stale no-op snapshot via the row-id walk", () => {
    /**
     * On the streaming hot path a debounced snapshot lags the stream (`S < L`).
     * The merge keeps the live local rows, so an identical row-id sequence
     * proves it was structurally a no-op — the original reference comes back
     * without a deep content comparison.
     */
    // GIVEN a local transcript
    const local = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1001 }),
    ];

    // AND a stale snapshot of the same rows behind the local seq
    const server = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1001 }),
    ];

    // WHEN the snapshot is stale (S < L)
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 5,
      localSeq: 10,
    });

    // THEN the original reference is returned (no-op merge)
    expect(result).toBe(local);
  });

  test("surfaces an authoritative correction at the same watermark even when row ids are unchanged", () => {
    /**
     * The case a row-id walk alone would miss: at the authoritative boundary
     * (`S >= L`) the merge takes the server row wholesale, so an existing row's
     * content can change while its id stays put (a server-normalized row
     * re-persisted at the same watermark). The correction must surface rather
     * than be masked by matching ids.
     */
    // GIVEN a local row already carrying the server id
    const local = [
      makeRow({ id: "a1", role: "assistant", ...textBody("v1"), timestamp: 1000 }),
    ];

    // AND a snapshot of the same row id with corrected content
    const server = [
      makeRow({ id: "a1", role: "assistant", ...textBody("v2"), timestamp: 1000 }),
    ];

    // WHEN the snapshot sits at the local seq (S == L)
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 7,
      localSeq: 7,
    });

    // THEN the authoritative server content surfaces (not the stale local copy)
    expect(result).not.toBe(local);
    expect(messageText(result[0])).toBe("v2");
  });

  test("returns the same reference for an authoritative no-op snapshot via content equality", () => {
    /**
     * Once persistence catches up to the stream (`S >= L`) the poll loop keeps
     * refetching the same authoritative snapshot. The content comparison lets
     * it settle by returning the original reference when nothing changed,
     * instead of treating every identical refetch as a change.
     */
    // GIVEN a local transcript
    const local = [
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1000 }),
    ];

    // AND an authoritative snapshot of the same content at the frontier
    const server = [
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1000 }),
    ];

    // WHEN the snapshot is authoritative and introduces nothing (S == L)
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: 9,
      localSeq: 9,
    });

    // THEN the original reference is returned (no-op merge)
    expect(result).toBe(local);
  });

  test("falls back to content equality for reference stability when seq is unknown", () => {
    /**
     * On the no-seq skew path there is no watermark to trust, so a structural
     * content comparison still lets the reconciliation poll loop settle by
     * returning the original reference for a no-op merge.
     */
    // GIVEN a local transcript
    const local = [
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1000 }),
    ];

    // AND a snapshot of the same content with no honest seq
    const server = [
      makeRow({ id: "a1", role: "assistant", ...textBody("answer"), timestamp: 1000 }),
    ];

    // WHEN the merge runs with no honest seq and no new server content
    const result = reconcileMessagesWithSeq(local, server, {
      serverSeq: null,
      localSeq: null,
    });

    // THEN the original reference is returned
    expect(result).toBe(local);
  });
});
