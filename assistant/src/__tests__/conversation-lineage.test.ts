/**
 * Tests for `resolveConversationLineage`: a conversation plus every subagent
 * ancestor above it, nearest first, bounded by a depth cap and a visited set.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Resident conversations, mapped to the id they were forked from. A key
 * absent from the map stands for a conversation that is not resident.
 */
let residents = new Map<string, string | undefined>();

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string | undefined) =>
    id !== undefined && residents.has(id)
      ? { parentConversationId: residents.get(id) }
      : undefined,
}));

const { MAX_LINEAGE_DEPTH, resolveConversationLineage } =
  await import("../daemon/conversation-lineage.js");

describe("resolveConversationLineage", () => {
  beforeEach(() => {
    residents = new Map();
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
