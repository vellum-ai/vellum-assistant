/**
 * Tests for `resolveConversationLineage`: a conversation plus every subagent
 * ancestor above it, nearest first, bounded by a depth cap and a visited set.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Resident top-level conversations, mapped to the id they were forked from —
 * the eviction-managed store. A key absent from the map stands for a
 * conversation that is not resident there.
 */
let residents = new Map<string, string | undefined>();

/**
 * Resident subagent conversations, in the separate index `SubagentManager`
 * owns. A background subagent's id lives only here, never in `residents`.
 */
let subagentResidents = new Map<string, string | undefined>();

mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: (id: string | undefined) => {
    if (id === undefined) {
      return undefined;
    }
    // Mirrors the registry: top-level store first, then the subagent index.
    if (residents.has(id)) {
      return { parentConversationId: residents.get(id) };
    }
    if (subagentResidents.has(id)) {
      return { parentConversationId: subagentResidents.get(id) };
    }
    return undefined;
  },
  /** Present so a lookup through the top-level-only accessor fails loudly. */
  findConversation: () => {
    throw new Error(
      "lineage must resolve through findConversationOrSubagent, not findConversation",
    );
  },
}));

const { MAX_LINEAGE_DEPTH, resolveConversationLineage } =
  await import("../daemon/conversation-lineage.js");

describe("resolveConversationLineage", () => {
  beforeEach(() => {
    residents = new Map();
    subagentResidents = new Map();
  });

  test("a plain conversation is its own lineage", () => {
    residents.set("conv-a", undefined);

    expect(resolveConversationLineage("conv-a")).toEqual(["conv-a"]);
  });

  test("one fork level reaches the spawner", () => {
    residents.set("conv-child", "conv-parent");
    residents.set("conv-parent", undefined);

    expect(resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-parent",
    ]);
  });

  test("two fork levels are ordered nearest first", () => {
    residents.set("conv-child", "conv-mid");
    residents.set("conv-mid", "conv-root");
    residents.set("conv-root", undefined);

    expect(resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-mid",
      "conv-root",
    ]);
  });

  test("a background subagent id reaches its user-visible parent", () => {
    // The live-voice duplex continuation: the seed id is registered only in
    // the subagent index, never in the eviction-managed top-level store.
    subagentResidents.set("conv-subagent", "conv-visible");
    residents.set("conv-visible", undefined);

    expect(resolveConversationLineage("conv-subagent")).toEqual([
      "conv-subagent",
      "conv-visible",
    ]);
  });

  test("nested subagents walk out of the subagent index into the store", () => {
    subagentResidents.set("conv-inner", "conv-outer");
    subagentResidents.set("conv-outer", "conv-visible");
    residents.set("conv-visible", undefined);

    expect(resolveConversationLineage("conv-inner")).toEqual([
      "conv-inner",
      "conv-outer",
      "conv-visible",
    ]);
  });

  test("a non-resident conversation is its own lineage", () => {
    expect(resolveConversationLineage("conv-gone")).toEqual(["conv-gone"]);
  });

  test("a non-resident ancestor ends the walk", () => {
    residents.set("conv-child", "conv-evicted");

    expect(resolveConversationLineage("conv-child")).toEqual([
      "conv-child",
      "conv-evicted",
    ]);
  });

  test("a self-referential parent does not loop forever", () => {
    residents.set("conv-self", "conv-self");

    expect(resolveConversationLineage("conv-self")).toEqual(["conv-self"]);
  });

  test("a cycle between two conversations terminates", () => {
    residents.set("conv-a", "conv-b");
    residents.set("conv-b", "conv-a");

    expect(resolveConversationLineage("conv-a")).toEqual(["conv-a", "conv-b"]);
  });

  test("a chain longer than the depth cap is truncated at the cap", () => {
    const chain = Array.from(
      { length: MAX_LINEAGE_DEPTH + 5 },
      (_, i) => `conv-${i}`,
    );
    for (const [i, id] of chain.entries()) {
      residents.set(id, chain[i + 1]);
    }

    expect(resolveConversationLineage(chain[0]!)).toEqual(
      chain.slice(0, MAX_LINEAGE_DEPTH),
    );
  });
});
