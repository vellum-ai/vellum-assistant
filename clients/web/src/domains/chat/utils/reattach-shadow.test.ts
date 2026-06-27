import { describe, expect, test } from "bun:test";

import { pruneShadowedReattachRows } from "@/domains/chat/utils/reattach-shadow";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody, thinkingBodyWithBlocks } from "@/domains/chat/utils/message-test-helpers";

function makeRow(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return { id: id ?? crypto.randomUUID(), ...rest };
}

describe("pruneShadowedReattachRows", () => {
  test("drops a prefix-less re-attach bubble shadowed by a richer history twin", () => {
    // History anchor `call-1` carries the streamed call's id `call-2` as a
    // merged alias and holds the full answer. The live bubble was opened
    // prefix-less under `call-2` and has only the post-reconnect thinking.
    const history = [
      makeRow({ id: "u1", role: "user", ...textBody("hi"), timestamp: 1 }),
      makeRow({
        id: "call-1",
        mergedMessageIds: ["call-2"],
        role: "assistant",
        ...textBody("the full answer"),
        timestamp: 2,
      }),
    ];
    const live = [
      makeRow({
        id: "call-2",
        role: "assistant",
        ...thinkingBodyWithBlocks("reconsidering"),
        timestamp: 3,
      }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toEqual([]);
  });

  test("keeps a seeded live row that carries the history row's primary id", () => {
    // The normal single-call streaming case: live row IS the twin, with fuller
    // streamed content. It legitimately wins on content — must not be pruned.
    const history = [
      makeRow({ id: "a1", role: "assistant", ...textBody("partial"), timestamp: 1 }),
    ];
    const live = [
      makeRow({
        id: "a1",
        role: "assistant",
        ...textBody("partial + more streamed"),
        timestamp: 1,
      }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toBe(live);
  });

  test("keeps a live row that folded the history row in as its own alias", () => {
    // Multi-call turn folded client-side: live anchor `a2` carries history's
    // `a1` as a merged alias, so it already contains that content and wins.
    const history = [
      makeRow({ id: "a1", role: "assistant", ...textBody("history copy"), timestamp: 1 }),
    ];
    const live = [
      makeRow({
        id: "a2",
        mergedMessageIds: ["a1"],
        role: "assistant",
        ...textBody("live copy"),
        timestamp: 1,
      }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toBe(live);
  });

  test("keeps a live row with no history twin (a genuinely new turn)", () => {
    const history = [
      makeRow({ id: "a1", role: "assistant", ...textBody("old answer"), timestamp: 1 }),
    ];
    const live = [
      makeRow({ id: "new", role: "assistant", ...textBody("streaming"), timestamp: 2 }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toBe(live);
  });

  test("ignores optimistic live rows even when an alias matches", () => {
    // An optimistic row's id is a client nonce the daemon hasn't echoed; it is
    // not a re-attach shadow and must be left for the echo-swap path.
    const history = [
      makeRow({
        id: "call-1",
        mergedMessageIds: ["nonce"],
        role: "assistant",
        ...textBody("answer"),
        timestamp: 1,
      }),
    ];
    const live = [
      makeRow({
        id: "nonce",
        isOptimistic: true,
        role: "assistant",
        ...textBody("optimistic"),
        timestamp: 2,
      }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toBe(live);
  });

  test("does not treat a user row as a shadow", () => {
    const history = [
      makeRow({
        id: "u-srv",
        mergedMessageIds: ["u-live"],
        role: "user",
        ...textBody("a question"),
        timestamp: 1,
      }),
    ];
    const live = [
      makeRow({ id: "u-live", role: "user", ...textBody("a question"), timestamp: 2 }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result).toBe(live);
  });

  test("prunes only the shadow, keeping other live rows in order", () => {
    const history = [
      makeRow({
        id: "call-1",
        mergedMessageIds: ["call-2"],
        role: "assistant",
        ...textBody("the full answer"),
        timestamp: 2,
      }),
    ];
    const live = [
      makeRow({
        id: "u-next",
        clientMessageId: "u-next",
        isOptimistic: true,
        role: "user",
        ...textBody("a follow-up"),
        timestamp: 3,
      }),
      makeRow({
        id: "call-2",
        role: "assistant",
        ...thinkingBodyWithBlocks("reconsidering"),
        timestamp: 4,
      }),
    ];

    const result = pruneShadowedReattachRows(live, history);

    expect(result.map((m) => m.id)).toEqual(["u-next"]);
  });

  test("returns the same reference when history is empty", () => {
    const live = [makeRow({ id: "a1", role: "assistant", ...textBody("x"), timestamp: 1 })];
    expect(pruneShadowedReattachRows(live, [])).toBe(live);
  });
});
