import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import {
  appendRow,
  deriveRowKey,
  emptyEntityState,
  patch,
  rebuildFromArray,
  removeRow,
  rowKeyForServerId,
  setLiveAssistantRowKey,
  toArray,
} from "./message-entities";

const msg = (m: Partial<DisplayMessage> & Pick<DisplayMessage, "id" | "role">): DisplayMessage => m;

describe("deriveRowKey", () => {
  test("prefers clientMessageId, falls back to id", () => {
    expect(deriveRowKey(msg({ id: "srv", role: "user", clientMessageId: "nonce" }))).toBe("nonce");
    expect(deriveRowKey(msg({ id: "srv", role: "assistant" }))).toBe("srv");
  });
});

describe("rebuildFromArray / toArray", () => {
  test("keys by clientMessageId|id, preserves order, indexes ids + aliases", () => {
    const msgs = [
      msg({ id: "u1", role: "user", clientMessageId: "cu1" }),
      msg({ id: "a1", role: "assistant", mergedMessageIds: ["a1b"] }),
    ];
    const s = rebuildFromArray(msgs);

    expect(s.order).toEqual(["cu1", "a1"]);
    expect(toArray(s)).toEqual(msgs);
    expect(rowKeyForServerId(s, "u1")).toBe("cu1");
    expect(rowKeyForServerId(s, "a1")).toBe("a1");
    expect(rowKeyForServerId(s, "a1b")).toBe("a1"); // folded alias
  });
});

describe("patch — the no-remount invariant", () => {
  test("optimistic assistant id swap keeps rowKey + order stable, re-points the index", () => {
    // Born with only a client nonce (no clientMessageId) — rowKey = the nonce.
    let s = appendRow(emptyEntityState(), msg({ id: "nonce-1", role: "assistant", isOptimistic: true }));
    const rowKey = s.order[0]!;
    expect(rowKey).toBe("nonce-1");

    // finalizeMessageComplete adopts the server id.
    s = patch(s, rowKey, (row) => ({ ...row, id: "srv-9", isOptimistic: false }));

    expect(s.order).toEqual([rowKey]); // React key unchanged → no remount
    expect(s.byId[rowKey]!.id).toBe("srv-9");
    expect(rowKeyForServerId(s, "srv-9")).toBe(rowKey); // index re-points
    expect(rowKeyForServerId(s, "nonce-1")).toBeUndefined(); // stale id dropped
  });

  test("optimistic user row keyed by clientMessageId survives the echo id swap", () => {
    let s = appendRow(
      emptyEntityState(),
      msg({ id: "tmp", role: "user", clientMessageId: "nonce-u", isOptimistic: true }),
    );
    const rowKey = s.order[0]!;
    expect(rowKey).toBe("nonce-u");

    s = patch(s, rowKey, (row) => ({ ...row, id: "srv-u", isOptimistic: false }));

    expect(s.order).toEqual(["nonce-u"]);
    expect(rowKeyForServerId(s, "srv-u")).toBe("nonce-u");
  });

  test("folding an alias indexes the new id to the same row", () => {
    let s = appendRow(emptyEntityState(), msg({ id: "a1", role: "assistant" }));
    const rk = s.order[0]!;
    s = patch(s, rk, (row) => ({ ...row, mergedMessageIds: [...(row.mergedMessageIds ?? []), "a2"] }));

    expect(rowKeyForServerId(s, "a1")).toBe(rk);
    expect(rowKeyForServerId(s, "a2")).toBe(rk);
  });

  test("a content-only delta does no index work (hot path stays O(1))", () => {
    let s = appendRow(emptyEntityState(), msg({ id: "a1", role: "assistant", textSegments: ["hi"] }));
    const rk = s.order[0]!;
    const indexBefore = s.serverIdToRowKey;

    s = patch(s, rk, (row) => ({ ...row, textSegments: [...(row.textSegments ?? []), " there"] }));

    expect(s.serverIdToRowKey).toBe(indexBefore); // same ref → no rebuild
    expect(s.order).toEqual([rk]);
    expect(s.byId[rk]!.textSegments).toEqual(["hi", " there"]);
  });

  test("no-op transform returns the same state ref; unknown rowKey is a no-op", () => {
    const s0 = appendRow(emptyEntityState(), msg({ id: "a1", role: "assistant" }));
    expect(patch(s0, s0.order[0]!, (row) => row)).toBe(s0);
    expect(patch(s0, "missing", (row) => ({ ...row, id: "x" }))).toBe(s0);
  });
});

describe("removeRow / live pointer", () => {
  test("drops the row, its index entries, and clears the live pointer", () => {
    let s = appendRow(emptyEntityState(), msg({ id: "a1", role: "assistant", mergedMessageIds: ["a2"] }));
    const rk = s.order[0]!;
    s = setLiveAssistantRowKey(s, rk);

    s = removeRow(s, rk);

    expect(s.order).toEqual([]);
    expect(s.byId[rk]).toBeUndefined();
    expect(rowKeyForServerId(s, "a1")).toBeUndefined();
    expect(rowKeyForServerId(s, "a2")).toBeUndefined();
    expect(s.liveAssistantRowKey).toBeNull();
  });
});
