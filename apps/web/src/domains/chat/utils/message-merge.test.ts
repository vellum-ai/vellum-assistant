import { describe, expect, test } from "bun:test";

import { mergeAdjacentAssistantMessages, mergeThinkingSegments } from "@/domains/chat/utils/message-merge";
import { resolveThinkingContent } from "@/domains/chat/transcript/message-content";
import type { DisplayMessage } from "@/domains/chat/types/types";

import {
  messageText,
  textBody,
  thinkingBodyWithBlocks,
} from "@/domains/chat/utils/message-test-helpers";
function makeAssistant(
  overrides: Omit<Partial<DisplayMessage>, "role"> & { id: string },
): DisplayMessage {
  return {
    role: "assistant",
    ...textBody(""),
    ...overrides,
  };
}

function makeUser(
  overrides: Omit<Partial<DisplayMessage>, "role"> & { id: string },
): DisplayMessage {
  return {
    role: "user",
    ...textBody(""),
    ...overrides,
  };
}

describe("mergeAdjacentAssistantMessages · happy path", () => {
  test("folds two adjacent assistants into the older anchor", () => {
    const older = makeAssistant({
      id: "anchor-old",
      ...textBody("first half "),
      timestamp: 1000,
    });
    const newer = makeAssistant({
      id: "anchor-new",
      ...textBody("second half"),
      timestamp: 1010,
    });
    const result = mergeAdjacentAssistantMessages([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("anchor-old");
    expect(messageText(result[0]!)).toBe("first half second half");
    expect(result[0]!.mergedMessageIds).toEqual(["anchor-new"]);
    expect(result[0]!.timestamp).toBe(1000);
  });

  test("folds a long run of N adjacent assistants onto the first anchor", () => {
    const messages = [
      makeAssistant({ id: "a-1", ...textBody("1 "), timestamp: 1000 }),
      makeAssistant({ id: "a-2", ...textBody("2 "), timestamp: 1010 }),
      makeAssistant({ id: "a-3", ...textBody("3 "), timestamp: 1020 }),
      makeAssistant({ id: "a-4", ...textBody("4"), timestamp: 1030 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a-1");
    expect(messageText(result[0]!)).toBe("1 2 3 4");
    expect(result[0]!.mergedMessageIds).toEqual(["a-2", "a-3", "a-4"]);
  });

  test("accumulates donor mergedMessageIds onto survivor (page-merged donors)", () => {
    // Mirrors the bug shape: each page's backend merge already left
    // mergedMessageIds populated. The frontend fold must accumulate them.
    const olderPage = makeAssistant({
      id: "page-A-anchor",
      ...textBody("A "),
      mergedMessageIds: ["row-A1", "row-A2"],
    });
    const newerPage = makeAssistant({
      id: "page-B-anchor",
      ...textBody("B"),
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
      makeAssistant({ id: "a-1", ...textBody("first turn"), timestamp: 1000 }),
      makeUser({ id: "u-1", ...textBody("follow-up"), timestamp: 1005 }),
      makeAssistant({ id: "a-2", ...textBody("second turn"), timestamp: 1010 }),
    ];
    const result = mergeAdjacentAssistantMessages(messages);
    expect(result.map((m) => m.id)).toEqual(["a-1", "u-1", "a-2"]);
  });
});

describe("mergeAdjacentAssistantMessages · referential stability", () => {
  test("returns the input array (by reference) when no adjacent pair exists", () => {
    const messages = [
      makeUser({ id: "u-1", ...textBody("hi"), timestamp: 1000 }),
      makeAssistant({ id: "a-1", ...textBody("hello"), timestamp: 1010 }),
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
      makeAssistant({ id: "a-1", ...textBody("x "), timestamp: 1000 }),
      makeAssistant({ id: "a-2", ...textBody("y"), timestamp: 1010 }),
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
      textSegments: [
        "A0 ",
        "A1 ",
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "text", id: "1" },
      ],
    });
    const donor = makeAssistant({
      id: "a-2",
      textSegments: ["B0"],
      contentOrder: [{ type: "text", id: "0" }],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.textSegments).toEqual([
      "A0 ",
      "A1 ",
      "B0",
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
        { id: "att-A0", filename: "a0.txt", mimeType: "text/plain", sizeBytes: 1, previewUrl: null },
        { id: "att-A1", filename: "a1.txt", mimeType: "text/plain", sizeBytes: 1, previewUrl: null },
      ],
      contentOrder: [{ type: "attachment", id: "0" }],
    });
    const donor = makeAssistant({
      id: "a-2",
      attachments: [
        { id: "att-B0", filename: "b0.txt", mimeType: "text/plain", sizeBytes: 1, previewUrl: null },
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

  // Server history payloads reference toolCalls / surfaces *positionally*
  // ("0", "1", "2"). When the donor's positional reference would otherwise
  // resolve to the survivor's same-indexed member after concat, we must
  // shift it. The next two tests cover the bug Codex flagged on the first
  // pass of this fix: the wrong progress card / surface rendering in the
  // folded long-turn bubble.
  test("shifts tool:N positional ids in the donor by survivor.toolCalls.length (history shape)", () => {
    const survivor = makeAssistant({
      id: "a-1",
      toolCalls: [
        { id: "toolu_S0", name: "bash", input: {}, completedAt: 1 },
      ],
      contentOrder: [{ type: "tool", id: "0" }],
    });
    const donor = makeAssistant({
      id: "a-2",
      toolCalls: [
        { id: "toolu_D0", name: "edit", input: {}, completedAt: 1 },
        { id: "toolu_D1", name: "test", input: {}, completedAt: 1 },
      ],
      contentOrder: [
        { type: "tool", id: "0" },
        { type: "tool", id: "1" },
      ],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.toolCalls?.map((t) => t.id)).toEqual([
      "toolu_S0",
      "toolu_D0",
      "toolu_D1",
    ]);
    // Donor's "0" / "1" must shift to "1" / "2" so the renderer's
    // index fallback resolves to the appended donor tool calls, not the
    // survivor's pre-existing toolCalls[0].
    expect(result[0]!.contentOrder).toEqual([
      { type: "tool", id: "0" },
      { type: "tool", id: "1" },
      { type: "tool", id: "2" },
    ]);
  });

  test("shifts surface:N positional ids in the donor by survivor.surfaces.length (history shape)", () => {
    const survivor = makeAssistant({
      id: "a-1",
      surfaces: [
        {
          surfaceId: "surf-S0",
          surfaceType: "card",
          data: {},
          messageId: "a-1",
        },
      ],
      contentOrder: [{ type: "surface", id: "0" }],
    });
    const donor = makeAssistant({
      id: "a-2",
      surfaces: [
        {
          surfaceId: "surf-D0",
          surfaceType: "card",
          data: {},
          messageId: "a-2",
        },
      ],
      contentOrder: [{ type: "surface", id: "0" }],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.surfaces?.map((s) => s.surfaceId)).toEqual([
      "surf-S0",
      "surf-D0",
    ]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "surface", id: "0" },
      { type: "surface", id: "1" },
    ]);
  });

  test("leaves real (non-numeric) toolCall / surface ids untouched (streaming shape)", () => {
    // Streaming-shape entries carry the real tool-use id / surfaceId in
    // `contentOrder.id`. The renderer's id-keyed first-pass lookup finds
    // them directly; remap would corrupt them, so the regex gate must
    // pass them through even when the offsets are non-zero.
    const survivor = makeAssistant({
      id: "a-1",
      toolCalls: [
        { id: "toolu_real_X", name: "bash", input: {}, completedAt: 1 },
      ],
      surfaces: [
        {
          surfaceId: "surf-real-X",
          surfaceType: "card",
          data: {},
          messageId: "a-1",
        },
      ],
      contentOrder: [
        { type: "toolCall", id: "toolu_real_X" },
        { type: "surface", id: "surf-real-X" },
      ],
    });
    const donor = makeAssistant({
      id: "a-2",
      toolCalls: [
        { id: "toolu_real_Y", name: "edit", input: {}, completedAt: 1 },
      ],
      surfaces: [
        {
          surfaceId: "surf-real-Y",
          surfaceType: "card",
          data: {},
          messageId: "a-2",
        },
      ],
      contentOrder: [
        { type: "toolCall", id: "toolu_real_Y" },
        { type: "surface", id: "surf-real-Y" },
      ],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    expect(result[0]!.contentOrder).toEqual([
      { type: "toolCall", id: "toolu_real_X" },
      { type: "surface", id: "surf-real-X" },
      { type: "toolCall", id: "toolu_real_Y" },
      { type: "surface", id: "surf-real-Y" },
    ]);
  });

  test("interleaved text + tool positional entries remap each by their own offset", () => {
    const survivor = makeAssistant({
      id: "a-1",
      textSegments: ["thinking..."],
      toolCalls: [
        { id: "toolu_S", name: "bash", input: {}, completedAt: 1 },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "0" },
      ],
    });
    const donor = makeAssistant({
      id: "a-2",
      textSegments: [
        "done with bash",
        "now editing",
      ],
      toolCalls: [
        { id: "toolu_D", name: "edit", input: {}, completedAt: 1 },
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "0" },
        { type: "text", id: "1" },
      ],
    });
    const result = mergeAdjacentAssistantMessages([survivor, donor]);
    // text shifts by 1 (survivor.textSegments.length), tool shifts by 1
    // (survivor.toolCalls.length) — independently.
    expect(result[0]!.contentOrder).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "0" },
      { type: "text", id: "1" },
      { type: "tool", id: "1" },
      { type: "text", id: "2" },
    ]);
  });
});

describe("mergeAdjacentAssistantMessages · skip predicates", () => {
  test("does NOT fold when either side is optimistic", () => {
    const real = makeAssistant({ id: "a-1", ...textBody("done") });
    const optimistic = makeAssistant({
      id: "opt-uuid",
      ...textBody("pending"),
      isOptimistic: true,
    });
    const result = mergeAdjacentAssistantMessages([real, optimistic]);
    expect(result).toHaveLength(2);
  });

  test("does NOT fold when either side is a subagent notification", () => {
    const real = makeAssistant({ id: "a-1", ...textBody("spawning subagent") });
    const notification = makeAssistant({
      id: "a-2",
      ...textBody(""),
      isSubagentNotification: true,
    });
    const result = mergeAdjacentAssistantMessages([real, notification]);
    expect(result).toHaveLength(2);
  });

  test("only folds assistant role — adjacent user/assistant stays split", () => {
    const messages = [
      makeUser({ id: "u-1", ...textBody("ping"), timestamp: 1000 }),
      makeAssistant({ id: "a-1", ...textBody("pong"), timestamp: 1010 }),
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
      timestamp: 1000,
      mergedMessageIds: Array.from({ length: 14 }, (_, i) => `row-A-${i}`),
      textSegments: ["[A] "],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-A-1", name: "bash", input: {}, completedAt: 1 },
      ],
    });
    const pageMiddle = makeAssistant({
      id: "page-middle-anchor",
      timestamp: 1010,
      mergedMessageIds: Array.from({ length: 24 }, (_, i) => `row-B-${i}`),
      textSegments: ["[B] "],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-B-1", name: "edit", input: {}, completedAt: 1 },
      ],
    });
    const pageLatest = makeAssistant({
      id: "page-latest-anchor",
      timestamp: 1020,
      mergedMessageIds: Array.from({ length: 34 }, (_, i) => `row-C-${i}`),
      textSegments: ["[C]"],
      contentOrder: [{ type: "text", id: "0" }],
      toolCalls: [
        { id: "tool-C-1", name: "test", input: {}, completedAt: 1 },
      ],
    });

    const result = mergeAdjacentAssistantMessages([
      pageOld,
      pageMiddle,
      pageLatest,
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("page-old-anchor");
    expect(messageText(result[0]!)).toBe("[A] [B] [C]");
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

describe("mergeThinkingSegments", () => {
  test("returns the populated side when the other is missing or empty", () => {
    // GIVEN one side has thinking and the other is undefined / empty
    const segments = ["reasoning"];

    // WHEN merging in either direction
    // THEN the populated side is returned untouched
    expect(mergeThinkingSegments(segments, undefined)).toEqual(segments);
    expect(mergeThinkingSegments(undefined, segments)).toEqual(segments);
    expect(mergeThinkingSegments(segments, [])).toEqual(segments);
    expect(mergeThinkingSegments([], segments)).toEqual(segments);
    expect(mergeThinkingSegments(undefined, undefined)).toBeUndefined();
  });

  test("keeps the locally-accumulated block while the live stream is ahead", () => {
    // GIVEN the local row has streamed more reasoning than the server snapshot
    const local = ["The full local reasoning so far"];

    // AND the server's periodic snapshot still lags behind
    const server = ["The full local"];

    // WHEN reconciliation merges them
    const merged = mergeThinkingSegments(local, server);

    // THEN the richer local block is preserved (no rewind)
    expect(merged).toEqual(local);
  });

  test("heals a block truncated by dropped deltas from the server snapshot", () => {
    // GIVEN deltas dropped while the stream was torn down, so the local block
    // is missing its leading reasoning
    const local = [") and so I will summarize the options."];

    // AND the server persisted the complete reasoning for that block
    const server = [
      "Let me think about this carefully (weighing the trade-offs) and so I will summarize the options.",
    ];

    // WHEN reconciliation merges them
    const merged = mergeThinkingSegments(local, server);

    // THEN the truncated block is healed from the server's fuller copy
    expect(merged).toEqual(server);
  });

  test("merges per index and appends extra trailing blocks from either side", () => {
    // GIVEN the local row is ahead on its first block but never saw a later one
    const local = ["full first block reasoning", "partial"];

    // AND the server has a shorter first block but a complete second + third
    const server = ["full first", "partial third-party block", "trailing"];

    // WHEN reconciliation merges them
    const merged = mergeThinkingSegments(local, server);

    // THEN each position keeps the longer text and trailing blocks are unioned
    expect(merged).toEqual([
      "full first block reasoning",
      "partial third-party block",
      "trailing",
    ]);
  });
});

describe("mergeAdjacentAssistantMessages · contentBlocks lockstep", () => {
  test("concatenates both sides' blocks so a folded turn resolves thinking without the fallback", () => {
    // GIVEN two settled assistant pages of one logical turn, each carrying a
    // reasoning block in lockstep with its positional thinkingSegments
    const olderPage = makeAssistant({
      id: "page-A",
      ...thinkingBodyWithBlocks("survivor reasoning"),
      timestamp: 1000,
    });
    const newerPage = makeAssistant({
      id: "page-B",
      ...thinkingBodyWithBlocks("donor reasoning"),
      timestamp: 1010,
    });

    // WHEN the adjacent-assistant fold merges them
    const [merged] = mergeAdjacentAssistantMessages([olderPage, newerPage]);

    // THEN the merged row carries both sides' blocks in survivor→donor order,
    // so its contentBlocks span every thinking index rather than only the
    // survivor's (the staleness the per-index fallback previously had to heal)
    expect(merged!.contentBlocks).toEqual([
      { type: "thinking", thinking: "survivor reasoning" },
      { type: "thinking", thinking: "donor reasoning" },
    ]);

    // AND the block-first thinking reader resolves the whole folded run from
    // those complete blocks
    const ids = merged!.contentOrder!.map((entry) => entry.id);
    expect(resolveThinkingContent(merged!, ids)).toBe(
      "survivor reasoning\ndonor reasoning",
    );
  });

  test("drops blocks when the survivor has none so the donor's are not misaligned to index 0", () => {
    // GIVEN a survivor still mid-stream (positional thinking, blocks not yet
    // built) folded with a donor that already carries blocks
    const survivor = makeAssistant({
      id: "page-A",
      thinkingSegments: ["survivor reasoning"],
      contentOrder: [{ type: "thinking", id: "0" }],
      timestamp: 1000,
    });
    const donor = makeAssistant({
      id: "page-B",
      ...thinkingBodyWithBlocks("donor reasoning"),
      timestamp: 1010,
    });

    // WHEN the fold merges them
    const [merged] = mergeAdjacentAssistantMessages([survivor, donor]);

    // THEN the merged row carries no blocks: keeping only the donor's would
    // align its reasoning to index 0 while thinkingSegments lead with the
    // survivor's, and the block-first reader would mask the survivor's reasoning
    expect(merged!.contentBlocks).toBeUndefined();

    // AND the reader still resolves the whole run via the positional fallback
    const ids = merged!.contentOrder!.map((entry) => entry.id);
    expect(resolveThinkingContent(merged!, ids)).toBe(
      "survivor reasoning\ndonor reasoning",
    );
  });

  test("drops blocks once the running survivor's projection no longer spans its thinking", () => {
    // GIVEN a run of three assistant pages where the middle page is still
    // mid-stream (positional thinking, no blocks yet) between two pages that
    // carry blocks. Folding the first two leaves a survivor whose blocks cover
    // only its own reasoning while its thinkingSegments already carry the
    // blockless page's — a partial projection that the third fold must not
    // append onto.
    const first = makeAssistant({
      id: "page-A",
      ...thinkingBodyWithBlocks("first reasoning"),
      timestamp: 1000,
    });
    const middleNoBlocks = makeAssistant({
      id: "page-B",
      thinkingSegments: ["middle reasoning"],
      contentOrder: [{ type: "thinking", id: "0" }],
      timestamp: 1010,
    });
    const last = makeAssistant({
      id: "page-C",
      ...thinkingBodyWithBlocks("last reasoning"),
      timestamp: 1020,
    });

    // WHEN the fold walks the whole run
    const [merged] = mergeAdjacentAssistantMessages([
      first,
      middleNoBlocks,
      last,
    ]);

    // THEN the merged row carries no blocks: appending the last page's block
    // onto the partial survivor would have slotted "last reasoning" into the
    // middle page's unfilled thinking index, masking it
    expect(merged!.contentBlocks).toBeUndefined();

    // AND the reader resolves all three pages in order via the positional
    // fallback instead
    const ids = merged!.contentOrder!.map((entry) => entry.id);
    expect(resolveThinkingContent(merged!, ids)).toBe(
      "first reasoning\nmiddle reasoning\nlast reasoning",
    );
  });
});
