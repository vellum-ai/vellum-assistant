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
  applyTextDelta,
  applyThinkingDelta,
} from "@/domains/chat/utils/stream-updaters/entity-updaters";

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
