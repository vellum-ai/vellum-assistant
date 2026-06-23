import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  appendRow,
  emptyEntityState,
  rebuildFromArray,
  rowKeyForServerId,
  toArray,
} from "@/domains/chat/utils/message-entities";
import {
  applyMessageComplete,
  applyTextDelta,
  applyThinkingDelta,
  applyUserMessageEcho,
} from "@/domains/chat/utils/stream-updaters/entity-updaters";
import type { MessageCompleteEvent } from "@vellumai/assistant-api";

const userRow = (id: string): DisplayMessage => ({ id, role: "user", textSegments: ["hi"] });

describe("applyTextDelta", () => {
  test("opens a bubble keyed by messageId and points the live pointer at it", () => {
    const s = applyTextDelta(emptyEntityState(), "Hel", "m1");
    expect(s.order).toEqual(["m1"]);
    expect(s.liveAssistantRowKey).toBe("m1");
    expect(s.byId.m1!.textSegments).toEqual(["Hel"]);
    expect(rowKeyForServerId(s, "m1")).toBe("m1");
  });

  test("coalesces subsequent deltas for the same messageId into one row (O(1), no new row)", () => {
    let s = applyTextDelta(emptyEntityState(), "Hel", "m1");
    const indexAfterCreate = s.serverIdToRowKey;
    s = applyTextDelta(s, "lo", "m1");
    expect(s.order).toEqual(["m1"]);
    expect(s.byId.m1!.textSegments).toEqual(["Hello"]);
    expect(s.serverIdToRowKey).toBe(indexAfterCreate); // content-only → no reindex
  });

  test("a new messageId on the same turn folds into the assistant tail as an alias", () => {
    let s = applyTextDelta(emptyEntityState(), "first ", "m1");
    s = applyTextDelta(s, "second", "m2"); // later LLM call, same turn
    expect(s.order).toEqual(["m1"]); // still one bubble
    expect(s.byId.m1!.mergedMessageIds).toEqual(["m2"]);
    expect(rowKeyForServerId(s, "m2")).toBe("m1"); // alias indexed → owner
  });

  test("a delta whose tail is a user row opens a fresh assistant bubble", () => {
    let s = appendRow(emptyEntityState(), userRow("u1"));
    s = applyTextDelta(s, "reply", "m1");
    expect(s.order).toEqual(["u1", "m1"]);
    expect(s.byId.m1!.role).toBe("assistant");
  });

  test("no messageId + assistant tail appends; no messageId + empty opens an optimistic bubble", () => {
    let s = applyTextDelta(emptyEntityState(), "a"); // no messageId
    const rk = s.order[0]!;
    expect(s.byId[rk]!.isOptimistic).toBe(true);
    s = applyTextDelta(s, "b"); // tail is assistant → append
    expect(s.order).toEqual([rk]);
    expect(s.byId[rk]!.textSegments).toEqual(["ab"]);
  });
});

describe("applyThinkingDelta", () => {
  test("opens a thinking bubble and accumulates", () => {
    let s = applyThinkingDelta(emptyEntityState(), "Rea", "m1");
    s = applyThinkingDelta(s, "soning", "m1");
    expect(s.order).toEqual(["m1"]);
    expect(s.byId.m1!.thinkingSegments).toEqual(["Reasoning"]);
    expect(s.liveAssistantRowKey).toBe("m1");
  });
});

describe("history rows are addressable by the same routing", () => {
  test("a delta for an already-loaded server row patches it in place", () => {
    // History snapshot with a reserved (empty) assistant row.
    const s0 = rebuildFromArray([userRow("u1"), { id: "a1", role: "assistant" }]);
    const s1 = applyTextDelta(s0, "streamed", "a1");
    expect(s1.order).toEqual(["u1", "a1"]); // no duplicate bubble
    expect(toArray(s1)[1]!.textSegments).toEqual(["streamed"]);
  });
});

describe("applyMessageComplete — the swap no-remount", () => {
  test("adopting the server id on an optimistic bubble keeps rowKey + order stable", () => {
    // An optimistic streaming bubble (no messageId on the delta).
    let s = applyTextDelta(emptyEntityState(), "answer");
    const rowKey = s.order[0]!;
    expect(s.byId[rowKey]!.isOptimistic).toBe(true);

    const event = { type: "message_complete", messageId: "srv-1" } as MessageCompleteEvent;
    s = applyMessageComplete(s, event);

    expect(s.order).toEqual([rowKey]); // React key unchanged -> no remount at completion
    expect(s.byId[rowKey]!.id).toBe("srv-1");
    expect(s.byId[rowKey]!.isOptimistic).toBe(false);
    expect(rowKeyForServerId(s, "srv-1")).toBe(rowKey);
  });
});

describe("applyUserMessageEcho", () => {
  test("swaps an optimistic user row's id by clientMessageId, keeping its rowKey", () => {
    let s = appendRow(
      emptyEntityState(),
      { id: "tmp", role: "user", clientMessageId: "n1", isOptimistic: true, textSegments: ["hi"] },
    );
    expect(s.order).toEqual(["n1"]);

    s = applyUserMessageEcho(s, { text: "hi", messageId: "srv-u", clientMessageId: "n1" });

    expect(s.order).toEqual(["n1"]); // rowKey unchanged
    expect(s.byId.n1!.id).toBe("srv-u");
    expect(s.byId.n1!.isOptimistic).toBe(false);
  });

  test("dedupes an echo whose server id is already present", () => {
    const before = appendRow(emptyEntityState(), { id: "srv-u", role: "user", textSegments: ["hi"] });
    const after = applyUserMessageEcho(before, { text: "hi", messageId: "srv-u" });
    expect(after).toBe(before); // no-op
  });

  test("appends a passive-viewer user row when there is no optimistic row", () => {
    const s = applyUserMessageEcho(emptyEntityState(), { text: "yo", messageId: "srv-x" });
    expect(s.order).toEqual(["srv-x"]);
    expect(s.byId["srv-x"]!.role).toBe("user");
  });
});
