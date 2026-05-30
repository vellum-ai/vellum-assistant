import { describe, expect, test } from "bun:test";

import { mergeAdjacentAssistantMessages } from "@/domains/chat/utils/message-merge";
import type { DisplayMessage } from "@/domains/chat/types/types";

function makeAssistant(
  overrides: Omit<Partial<DisplayMessage>, "role"> & { id: string },
): DisplayMessage {
  return {
    role: "assistant",
    content: "",
    ...overrides,
  };
}

function makeUser(
  overrides: Omit<Partial<DisplayMessage>, "role"> & { id: string },
): DisplayMessage {
  return {
    role: "user",
    content: "",
    ...overrides,
  };
}

describe("mergeAdjacentAssistantMessages · happy path", () => {
  test("folds two adjacent assistants into the older anchor", () => {
    const older = makeAssistant({
      id: "anchor-old",
      content: "first half ",
      timestamp: 1000,
    });
    const newer = makeAssistant({
      id: "anchor-new",
      content: "second half",
      timestamp: 1010,
    });
    const result = mergeAdjacentAssistantMessages([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("anchor-old");
    expect(result[0]!.content).toBe("first half second half");
    expect(result[0]!.mergedMessageIds).toEqual(["anchor-new"]);
    expect(result[0]!.timestamp).toBe(1000);
  });

  test("folds a long run of N adjacent assistants onto the first anchor", () => {
    const messages = [
      makeAssistant({ id: "a-1", content: "1 ", timestamp: 1000 }),
      makeAssistant({ id: "a-2", content: "2 ", timestamp: 1010 }),
      makeAssistant({ id: "a-3", content: "3 ", timestamp: 1020 }),
      makeAssistant({ id: "a-4", content: "4", timestamp: 1030 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
    expect(result[0]!.content).toBe("1 2 3 4");
    expect(result[0]!.mergedMessageIds).toEqual(["a-2", "a-3", "a-4"]);
  });

  test("accumulates donor mergedMessageIds onto survivor (page-merged donors)", () => {
    // Mirrors the bug shape: each page's backend merge already left
    // mergedMessageIds populated. The frontend fold must accumulate them.
    const olderPage = makeAssistant({
      id: "page-A-anchor",
      content: "A ",
      mergedMessageIds: ["row-A1", "row-A2"],
    });
    const newerPage = makeAssistant({
      id: "page-B-anchor",
      content: "B",
      mergedMessageIds: ["row-B1", "row-B2", "row-B3"],
    });
    const result = mergeAdjacentAssistantMessages([olderPage, newerPage]);
    expect(result[0]!.mergedMessageIds).toEqual([
      "row-A1",
      "row-A2",
      "page-B-anchor",
      "row-B1",
      "row-B2",
      "row-B3",
    ]);
  });

  test("leaves the user-separated turn pair untouched", () => {
    const messages = [
      makeAssistant({ id: "a-1", content: "first turn", timestamp: 1000 }),
      makeUser({ id: "u-1", content: "follow-up", timestamp: 1005 }),
      makeAssistant({ id: "a-2", content: "second turn", timestamp: 1010 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["a-1", "u-1", "a-2"]);
  });
});

describe("mergeAdjacentAssistantMessages · referential stability", () => {
  test("returns the input array (by reference) when no adjacent pair exists", () => {
    const messages = [
      makeUser({ id: "u-1", content: "hi", timestamp: 1000 }),
      makeAssistant({ id: "a-1", content: "hello", timestamp: 1010 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result).toBe(messages);
  });

  test("empty input returns the input by reference", () => {
    const messages: DisplayMessage[] = [];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result).toBe(messages);
  });

  test("idempotent: a second pass over already-merged output is a no-op", () => {
    const messages = [
      makeAssistant({ id: "a-1", content: "x ", timestamp: 1000 }),
      makeAssistant({ id: "a-2", content: "y", timestamp: 1010 }),
    ];
    const first = mergeAdjacentAssistantMessages(messages);
    const second = mergeAdjacentAssistantMessages(first);
    expect(second).toBe(first);
  });
});

describe("mergeAdjacentAssistantMessages · contentOrder remap", () => {
  test("shifts text:N indices in the donor by survivor.textSegments.length", () => {
    const survivor = makeAssistant({
      id: "a-1",
      content: "A0 A1 ",
      textSegments: [
        { type: "text", content: "A0 " },
        { type: "text", content: "A1 " },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "text", id: "1" },
      ],
    });
    const donor = makeAssistant({
      id: "a-2",
      content: "B0",
      textSegments: [{ type: "text", content: "B0" }],
      contentOrder: [{ type: "text", id: "0" }],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.textSegments).toEqual([
      { type: "text", content: "A0 " },
      { type: "text", content: "A1 " },
      { type: "text", content: "B0" },
    ]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "text", id: "0" },
      { type: "text", id: "1" },
      { type: "text", id: "2" },
    ]);
  });

  test("shifts attachment:N indices in the donor by survivor.attachments.length", () => {
    const survivor = makeAssistant({
      id: "a-1",
      attachments: [
        { id: "att-A0", filename: "a0.txt", mimeType: "text/plain", sizeBytes: 1 },
        { id: "att-A1", filename: "a1.txt", mimeType: "text/plain", sizeBytes: 1 },
      ],
      contentOrder: [{ type: "attachment", id: "0" }],
    });
    const donor = makeAssistant({
      id: "a-2",
      attachments: [
        { id: "att-B0", filename: "b0.txt", mimeType: "text/plain", sizeBytes: 1 },
      ],
      contentOrder: [{ type: "attachment", id: "0" }],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.attachments).toHaveLength(3);
    expect(result[0]!.attachments?.map((a) => a.id)).toEqual([
      "att-A0",
      "att-A1",
      "att-B0",
    ]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "attachment", id: "0" },
      { type: "attachment", id: "2" },
    ]);
  });

  test("does not shift toolCall / surface contentOrder entries (id-keyed, not index-keyed)", () => {
    const survivor = makeAssistant({
      id: "a-1",
      toolCalls: [
        { id: "tool-X", toolName: "bash", input: {}, status: "completed" },
      ],
      contentOrder: [{ type: "toolCall", id: "tool-X" }],
    });
    const donor = makeAssistant({
      id: "a-2",
      toolCalls: [
        { id: "tool-Y", toolName: "edit", input: {}, status: "completed" },
      ],
      contentOrder: [{ type: "toolCall", id: "tool-Y" }],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "toolCall", id: "tool-X" },
      { type: "toolCall", id: "tool-Y" },
    ]);
    expect(result[0]!.toolCalls?.map((t) => t.id)).toEqual([
      "tool-X",
      "tool-Y",
    ]);
  });

  test("interleaved text + tool entries remap text indices but leave tool ids alone", () => {
    const survivor = makeAssistant({
      id: "a-1",
      textSegments: [{ type: "text", content: "thinking..." }],
      toolCalls: [
        { id: "tool-X", toolName: "bash", input: {}, status: "completed" },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tool-X" },
      ],
    });
    const donor = makeAssistant({
      id: "a-2",
      textSegments: [
        { type: "text", content: "done with bash" },
        { type: "text", content: "now editing" },
      ],
      toolCalls: [
        { id: "tool-Y", toolName: "edit", input: {}, status: "completed" },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "toolCall", id: "tool-Y" },
        { type: "text", id: "1" },
      ],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "text", id: "0" },
      { type: "toolCall", id: "tool-X" },
      { type: "text", id: "1" },
      { type: "toolCall", id: "tool-Y" },
      { type: "text", id: "2" },
    ]);
  });
});

describe("mergeAdjacentAssistantMessages · skip predicates", () => {
  test("does NOT fold when either side is streaming", () => {
    const finalized = makeAssistant({ id: "a-1", content: "done" });
    const streaming = makeAssistant({
      id: "a-2",
      content: "still typing",
      isStreaming: true,
    });
    const result = mergeAdjacentAssistantMessages([finalized, streaming]);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(["a-1", "a-2"]);
  });

  test("does NOT fold when either side is optimistic", () => {
    const real = makeAssistant({ id: "a-1", content: "done" });
    const optimistic = makeAssistant({
      id: "opt-uuid",
      content: "pending",
      isOptimistic: true,
    });
    const result = mergeAdjacentAssistantMessages([real, optimistic]);
    expect(result).toHaveLength(2);
  });

  test("does NOT fold when either side is a subagent notification", () => {
    const real = makeAssistant({ id: "a-1", content: "spawning subagent" });
    const notification = makeAssistant({
      id: "a-2",
      content: "",
      isSubagentNotification: true,
    });
    const result = mergeAdjacentAssistantMessages([real, notification]);
    expect(result).toHaveLength(2);
  });

  test("only folds assistant role — adjacent user/assistant stays split", () => {
    const messages = [
      makeUser({ id: "u-1", content: "ping", timestamp: 1000 }),
      makeAssistant({ id: "a-1", content: "pong", timestamp: 1010 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["u-1", "a-1"]);
  });
});

describe("mergeAdjacentAssistantMessages · cross-page bug repro", () => {
  // Mirrors the production trace where a 65-row assistant turn was paginated
  // across 3 page fetches. Each backend page-merge anchored on its own
  // oldest row; the client ended up with three sibling display messages
  // for what is logically a single turn. The fold should collapse them
  // back into the older-most anchor with all donor ids carried forward.
  test("folds three pages of a single turn back into one bubble", () => {
    const pageOld = makeAssistant({
      id: "page-old-anchor",
      content: "[A] ",
      timestamp: 1000,
      mergedMessageIds: Array.from({ length: 14 }, (_, i) => `row-A-${i}`),
      textSegments: [{ type: "text", content: "[A] " }],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-A-1", toolName: "bash", input: {}, status: "completed" },
      ],
    });
    const pageMiddle = makeAssistant({
      id: "page-middle-anchor",
      content: "[B] ",
      timestamp: 1010,
      mergedMessageIds: Array.from({ length: 24 }, (_, i) => `row-B-${i}`),
      textSegments: [{ type: "text", content: "[B] " }],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-B-1", toolName: "edit", input: {}, status: "completed" },
      ],
    });
    const pageLatest = makeAssistant({
      id: "page-latest-anchor",
      content: "[C]",
      timestamp: 1020,
      mergedMessageIds: Array.from({ length: 34 }, (_, i) => `row-C-${i}`),
      textSegments: [{ type: "text", content: "[C]" }],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-C-1", toolName: "test", input: {}, status: "completed" },
      ],
    });

    const result = mergeAdjacentAssistantMessages([
      pageOld,
      pageMiddle,
      pageLatest,
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("page-old-anchor");
    expect(result[0]!.content).toBe("[A] [B] [C]");
    expect(result[0]!.timestamp).toBe(1000);
    expect(result[0]!.toolCalls?.map((t) => t.id)).toEqual([
      "tool-A-1",
      "tool-B-1",
      "tool-C-1",
    ]);
    // 14 + 1 (middle anchor) + 24 + 1 (latest anchor) + 34 = 74 aliases.
    expect(result[0]!.mergedMessageIds).toHaveLength(74);
    expect(result[0]!.mergedMessageIds).toContain("page-middle-anchor");
    expect(result[0]!.mergedMessageIds).toContain("page-latest-anchor");
  });
});
