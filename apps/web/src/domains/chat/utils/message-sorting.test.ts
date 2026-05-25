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

describe("sortByTimestamp · tool-call tiebreaker", () => {
  // The actual bug from production: a multi-row server cluster emits four
  // assistant rows for the same turn, all sharing the same top-level
  // `timestamp`. They differ on which tool calls ran inside them, and the
  // tool calls have monotonically increasing `startedAt` / `completedAt`.
  // Without a tiebreaker the rows render in array order; we need them in
  // execution order.
  test("ties on top-level timestamp resolve via tool-call activity", () => {
    const sharedTs = 1000;
    const messages: DisplayMessage[] = [
      // Array order is reversed relative to execution order — mirrors the
      // "11 / 12 / 13 inverted" bug screenshot.
      make({
        stableId: "row-c",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "tc-c",
            toolName: "x",
            input: {},
            status: "completed",
            startedAt: 1300,
            completedAt: 1400,
          },
        ],
      }),
      make({
        stableId: "row-b",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "tc-b",
            toolName: "x",
            input: {},
            status: "completed",
            startedAt: 1200,
            completedAt: 1250,
          },
        ],
      }),
      make({
        stableId: "row-a",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "tc-a",
            toolName: "x",
            input: {},
            status: "completed",
            startedAt: 1100,
            completedAt: 1150,
          },
        ],
      }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["row-a", "row-b", "row-c"]);
  });

  test("uses startedAt when completedAt is absent (running tool call)", () => {
    const sharedTs = 500;
    const messages: DisplayMessage[] = [
      make({
        stableId: "later",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "t2",
            toolName: "x",
            input: {},
            status: "running",
            startedAt: 800,
          },
        ],
      }),
      make({
        stableId: "earlier",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "t1",
            toolName: "x",
            input: {},
            status: "running",
            startedAt: 600,
          },
        ],
      }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["earlier", "later"]);
  });

  test("uses lastProgressAt for long-running tools without completedAt", () => {
    const sharedTs = 100;
    const messages: DisplayMessage[] = [
      make({
        stableId: "later-progress",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "t2",
            toolName: "x",
            input: {},
            status: "running",
            startedAt: 200,
            lastProgressAt: 900,
          },
        ],
      }),
      make({
        stableId: "earlier-progress",
        timestamp: sharedTs,
        toolCalls: [
          {
            id: "t1",
            toolName: "x",
            input: {},
            status: "running",
            startedAt: 200,
            lastProgressAt: 500,
          },
        ],
      }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual([
      "earlier-progress",
      "later-progress",
    ]);
  });

  test("picks max activity timestamp across multiple tool calls per message", () => {
    // A message with multiple tools — the tiebreaker is the LATEST activity
    // across all of them, not the first or last array position.
    const sharedTs = 100;
    const messages: DisplayMessage[] = [
      make({
        stableId: "B",
        timestamp: sharedTs,
        toolCalls: [
          { id: "b1", toolName: "x", input: {}, status: "completed", completedAt: 700 },
          { id: "b2", toolName: "x", input: {}, status: "completed", completedAt: 300 },
        ],
      }),
      make({
        stableId: "A",
        timestamp: sharedTs,
        toolCalls: [
          { id: "a1", toolName: "x", input: {}, status: "completed", completedAt: 200 },
          { id: "a2", toolName: "x", input: {}, status: "completed", completedAt: 600 },
        ],
      }),
    ];
    sortByTimestamp(messages);
    // A's max activity = 600, B's max activity = 700 → A before B.
    expect(messages.map((m) => m.stableId)).toEqual(["A", "B"]);
  });

  test("falls back to insertion order when timestamps AND tool activity tie", () => {
    // No tool calls, identical timestamps → stable sort keeps insertion
    // order so streaming bubbles don't flicker.
    const sharedTs = 100;
    const messages: DisplayMessage[] = [
      make({ stableId: "first", timestamp: sharedTs }),
      make({ stableId: "second", timestamp: sharedTs }),
      make({ stableId: "third", timestamp: sharedTs }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["first", "second", "third"]);
  });

  test("messages without tool calls don't disturb messages with them", () => {
    // Top-level ties: plain message (no tool calls) tied with a message
    // that has a much-later tool-call timestamp. Plain message should
    // sort first because its effective timestamp == top-level.
    const sharedTs = 100;
    const messages: DisplayMessage[] = [
      make({
        stableId: "with-tool",
        timestamp: sharedTs,
        toolCalls: [
          { id: "t", toolName: "x", input: {}, status: "completed", completedAt: 5000 },
        ],
      }),
      make({ stableId: "plain", timestamp: sharedTs }),
    ];
    sortByTimestamp(messages);
    expect(messages.map((m) => m.stableId)).toEqual(["plain", "with-tool"]);
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
