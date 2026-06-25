import { describe, expect, test } from "bun:test";

import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  messageText,
  textBody,
  thinkingBodyWithBlocks,
} from "@/domains/chat/utils/message-test-helpers";

function makeRow(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

describe("selectTranscriptMessages", () => {
  test("returns the history reference unchanged when the live turn is empty", () => {
    const history = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("hello"),
        timestamp: 1001,
      }),
    ];

    const result = selectTranscriptMessages(history, []);

    // Same reference — no allocation, render stays stable.
    expect(result).toBe(history);
  });

  test("appends a live row with no history twin after history", () => {
    const history = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
    ];
    const live = [
      makeRow({
        id: "nonce-1",
        clientMessageId: "nonce-1",
        isOptimistic: true,
        role: "user",
        ...textBody("follow up"),
        timestamp: 2000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result.map((m) => m.id)).toEqual(["u1", "nonce-1"]);
  });

  test("keeps server-history order and appends the live turn — no timestamp sort", () => {
    // The live row carries an OLDER client timestamp than history (the exact
    // cross-clock case the old sort got wrong). It must still land after
    // history, because the live turn is the current, newest turn.
    const history = [
      makeRow({ id: "h1", role: "user", ...textBody("first"), timestamp: 1000 }),
      makeRow({
        id: "h2",
        role: "assistant",
        ...textBody("answer"),
        timestamp: 2000,
      }),
    ];
    const live = [
      makeRow({
        id: "nonce",
        clientMessageId: "nonce",
        isOptimistic: true,
        role: "user",
        ...textBody("newest send"),
        timestamp: 500,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result.map((m) => m.id)).toEqual(["h1", "h2", "nonce"]);
  });

  test("a live row overlays its history twin by server id, in place, content wins", () => {
    const history = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("partial"),
        timestamp: 1001,
      }),
    ];
    // The same assistant row, still live, with fuller streamed content.
    const live = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("the full streamed answer"),
        timestamp: 1001,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(messageText(result[1])).toBe("the full streamed answer");
  });

  test("an optimistic user row overlays its server echo by clientMessageId (no duplicate)", () => {
    // Refetch-races-handoff: the snapshot already persisted the row under its
    // server id (echoing the nonce) while the optimistic copy is still in the
    // live turn. They must collapse to one row.
    const history = [
      makeRow({
        id: "srv-1",
        clientMessageId: "nonce-1",
        role: "user",
        ...textBody("hello"),
        timestamp: 1000,
      }),
    ];
    const live = [
      makeRow({
        id: "nonce-1",
        clientMessageId: "nonce-1",
        isOptimistic: true,
        role: "user",
        ...textBody("hello"),
        timestamp: 1000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    const users = result.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe("nonce-1");
  });

  test("a live row overlays a history row via a merged alias", () => {
    const history = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("history copy"),
        timestamp: 1000,
      }),
    ];
    // Same logical row, now keyed under a new server id with `a1` folded in.
    const live = [
      makeRow({
        id: "a2",
        mergedMessageIds: ["a1"],
        role: "assistant",
        ...textBody("live copy"),
        timestamp: 1000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a2");
    expect(messageText(result[0])).toBe("live copy");
  });

  test("folds the persisted prefix into a prefix-less re-attach bubble instead of letting it shadow the answer", () => {
    // Regression: messages disappearing on refresh. A tab reconnects mid-turn
    // and the daemon replays the in-flight LLM call's thinking deltas under
    // that call's own id (`call-2`). The persisted turn row is anchored on an
    // EARLIER call's id (`call-1`) with `call-2` folded in as a merged alias,
    // and it already holds the full answer. The first replayed delta beat the
    // history fetch, so the live bubble opened prefix-less — it holds only the
    // post-reconnect thinking and carries NO knowledge of `call-1`.
    const history = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1000 }),
      makeRow({
        id: "call-1",
        mergedMessageIds: ["call-2"],
        role: "assistant",
        ...textBody("the full dashboard answer"),
        timestamp: 1001,
      }),
    ];
    const live = [
      makeRow({
        id: "call-2",
        role: "assistant",
        ...thinkingBodyWithBlocks("reconsidering the design"),
        timestamp: 2000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    // The user row plus ONE merged assistant row — the answer is not shadowed.
    expect(result.map((m) => m.id)).toEqual(["u1", "call-1"]);
    // Persisted answer survives, and the replayed thinking suffix extends it.
    expect(messageText(result[1])).toBe("the full dashboard answer");
    expect(result[1]!.thinkingSegments).toEqual(["reconsidering the design"]);
    // The replayed id stays resolvable on the folded row.
    expect(result[1]!.mergedMessageIds).toContain("call-2");
  });

  test("does not fold when the live row carries history's id as its own alias (it legitimately supersedes)", () => {
    // Mirror of the prefix-less case but with the alias on the LIVE side: the
    // live row folded `a1` in during streaming, so it already contains that
    // content and must win outright — no double-counting via a fold.
    const history = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("history copy"),
        timestamp: 1000,
      }),
    ];
    const live = [
      makeRow({
        id: "a2",
        mergedMessageIds: ["a1"],
        role: "assistant",
        ...textBody("live copy"),
        timestamp: 1000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a2");
    expect(messageText(result[0])).toBe("live copy");
  });

  test("does not fold a prefix-less match across roles", () => {
    // A user history row aliased to a live assistant row must never fold — the
    // guard is assistant-only. (Defensive: this shape shouldn't occur, but the
    // fold must not fire if it does.)
    const history = [
      makeRow({
        id: "u-srv",
        mergedMessageIds: ["live-x"],
        role: "user",
        ...textBody("a question"),
        timestamp: 1000,
      }),
    ];
    const live = [
      makeRow({
        id: "live-x",
        role: "assistant",
        ...textBody("an answer"),
        timestamp: 2000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    // Matched in place, live wins — no cross-role fold.
    expect(result.map((m) => m.id)).toEqual(["live-x"]);
    expect(messageText(result[0])).toBe("an answer");
  });

  test("a live row that matches more than one history row still renders once", () => {
    // Invariant guard, not a routine case: adjacent same-turn rows are already
    // folded by `mergeAdjacentAssistantMessages` before history reaches the
    // union, so a single live row matching two history rows is the residual
    // non-adjacent edge. The dedup keeps it rendering exactly once.
    const history = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("part one"),
        timestamp: 1000,
      }),
      makeRow({
        id: "a2",
        role: "assistant",
        ...textBody("part two"),
        timestamp: 1001,
      }),
    ];
    const live = [
      makeRow({
        id: "a1",
        mergedMessageIds: ["a2"],
        role: "assistant",
        ...textBody("merged live"),
        timestamp: 1000,
      }),
    ];

    const result = selectTranscriptMessages(history, live);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a1");
    expect(messageText(result[0])).toBe("merged live");
  });
});
