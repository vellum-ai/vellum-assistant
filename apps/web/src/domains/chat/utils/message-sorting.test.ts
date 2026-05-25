import { describe, expect, test } from "bun:test";

import { sortByTimestamp, sortedByTimestamp } from "@/domains/chat/utils/message-sorting.js";
import type { DisplayMessage } from "@/domains/chat/types/types.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";

function make(overrides: Partial<DisplayMessage> & { timestamp?: number }): DisplayMessage {
  return {
    stableId: newStableId("test"),
    role: "assistant",
    content: "",
    ...overrides,
  } as DisplayMessage;
}

describe("sortByTimestamp", () => {
  test("orders timestamped messages ascending", () => {
    const messages: DisplayMessage[] = [
      make({ stableId: "c", timestamp: 300 }),
      make({ stableId: "a", timestamp: 100 }),
      make({ stableId: "b", timestamp: 200 }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["a", "b", "c"]);
  });

  test("reverse-ordered input becomes ascending (the bug we're patching)", () => {
    // Mirrors the production failure mode: a multi-row server cluster
    // delivered with bubbles in reverse insertion order.
    const messages: DisplayMessage[] = [
      make({ stableId: "13", timestamp: 1000 }),
      make({ stableId: "12", timestamp: 900 }),
      make({ stableId: "11", timestamp: 800 }),
      make({ stableId: "10", timestamp: 700 }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["10", "11", "12", "13"]);
  });

  test("equal timestamps preserve original insertion order (stable sort)", () => {
    // Same-timestamp clusters are common when multiple tool events emit
    // in the same tick. The stable sort preserves whatever order the
    // upstream mutator put them in.
    const messages: DisplayMessage[] = [
      make({ stableId: "first", timestamp: 500 }),
      make({ stableId: "second", timestamp: 500 }),
      make({ stableId: "third", timestamp: 500 }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["first", "second", "third"]);
  });

  test("messages without a timestamp keep their original slot", () => {
    // No-timestamp rows (e.g. pending optimistic messages) shouldn't be
    // shuffled around. Only the timestamped subset is reordered, and the
    // reordered values are written back into the slots that had timestamps.
    const messages: DisplayMessage[] = [
      make({ stableId: "later-ts", timestamp: 200 }),
      make({ stableId: "no-ts-1", timestamp: undefined }),
      make({ stableId: "earlier-ts", timestamp: 100 }),
      make({ stableId: "no-ts-2", timestamp: undefined }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual([
      "earlier-ts", // slot 0 (was timestamped)
      "no-ts-1", // slot 1 (untouched)
      "later-ts", // slot 2 (was timestamped)
      "no-ts-2", // slot 3 (untouched)
    ]);
  });

  test("no-op when fewer than 2 timestamped messages", () => {
    const messages: DisplayMessage[] = [
      make({ stableId: "a", timestamp: 100 }),
      make({ stableId: "b", timestamp: undefined }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["a", "b"]);
  });
});

describe("sortedByTimestamp", () => {
  test("returns a new sorted array without mutating the input", () => {
    const original: DisplayMessage[] = [
      make({ stableId: "b", timestamp: 200 }),
      make({ stableId: "a", timestamp: 100 }),
    ];
    const snapshot = original.map((m) => m.stableId);
    const sorted = sortedByTimestamp(original);
    expect(sorted.map((m) => m.stableId)).toEqual(["a", "b"]);
    // Original untouched
    expect(original.map((m) => m.stableId)).toEqual(snapshot);
    // Distinct array instance
    expect(sorted).not.toBe(original);
  });
});
