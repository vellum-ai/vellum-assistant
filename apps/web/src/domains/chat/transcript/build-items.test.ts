import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import type { Surface } from "@/domains/chat/types/types.js";
import { buildTranscriptItems } from "@/domains/chat/transcript/build-items.js";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types.js";

function makeMessage(
  overrides: Omit<DisplayMessage, "stableId"> & { stableId?: string },
): DisplayMessage {
  const { stableId, ...rest } = overrides;
  return {
    stableId: stableId ?? newStableId("test"),
    ...rest,
  };
}

function makeSurface(overrides: Partial<Surface> & { surfaceId: string }): Surface {
  return {
    surfaceType: "test-surface",
    data: {},
    ...overrides,
  };
}

function emptyInput() {
  return {
    messages: [] as DisplayMessage[],
    pendingSecret: null,
    pendingConfirmation: null,
    isThinking: false,
    errorNotice: null,
  };
}

function expectDistinctNonEmptyKeys(items: TranscriptItem[]): void {
  const keys = items.map((i) => i.key);
  for (const key of keys) {
    expect(key.length).toBeGreaterThan(0);
  }
  expect(new Set(keys).size).toBe(keys.length);
}

describe("buildTranscriptItems", () => {
  test("projects plain user + assistant messages into two MessageItems in order", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hello", stableId: "s-1" });
    const assistant = makeMessage({ id: "m2", role: "assistant", content: "Hi", stableId: "s-2" });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "message", key: "s-1", message: user });
    expect(items[1]).toEqual({ kind: "message", key: "s-2", message: assistant });
    expectDistinctNonEmptyKeys(items);
  });

  test("emits empty list when there is no state", () => {
    const items = buildTranscriptItems(emptyInput());
    expect(items).toEqual([]);
  });

  test("surfaces on messages are rendered within the message item (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const surface = makeSurface({
      surfaceId: "surf-1",
      display: "inline",
    });
    const assistant = makeMessage({
      id: "m2",
      role: "assistant",
      content: "See surface",
      stableId: "s-assistant",
      surfaces: [surface],
      contentOrder: [{ type: "text", id: "0" }, { type: "surface", id: "surf-1" }],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", key: "s-user" });
    expect(items[1]).toMatchObject({ kind: "message", key: "s-assistant" });
    expectDistinctNonEmptyKeys(items);
  });

  test("completed surfaces stay on the message (no standalone rows)", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const completedSurface = makeSurface({ surfaceId: "done-A", completed: true, completionSummary: "Done" });
    const assistant = makeMessage({
      id: "m2",
      role: "assistant",
      content: "Ok",
      stableId: "s-assistant",
      surfaces: [completedSurface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user, assistant],
    });

    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("message");
    expect(items[1]!.kind).toBe("message");
    expectDistinctNonEmptyKeys(items);
  });

  test("isThinking inserts ThinkingItem first in the trailers", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
      errorNotice: "oh no",
    });

    // message, thinking, error — thinking is the FIRST trailer.
    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "thinking",
      "error",
    ]);
    expect(items[1]).toEqual({ kind: "thinking", key: "thinking" });
  });

  test("ThinkingItem includes label when thinkingLabel is provided", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "Processing bash results",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "thinking",
      key: "thinking",
      label: "Processing bash results",
    });
  });

  test("ThinkingItem omits label when thinkingLabel is null", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: null,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: "thinking", key: "thinking" });
  });

  test("ThinkingItem omits label when thinkingLabel is empty string", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      isThinking: true,
      thinkingLabel: "",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: "thinking", key: "thinking" });
  });

  test("pendingSecret comes before pendingConfirmation", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
    });

    expect(items.map((i) => i.kind)).toEqual(["pendingSecret", "pendingConfirmation"]);
    expect(items[0]).toEqual({
      kind: "pendingSecret",
      key: "secret-req-s",
      requestId: "req-s",
    });
    expect(items[1]).toEqual({
      kind: "pendingConfirmation",
      key: "confirmation-req-c",
      requestId: "req-c",
    });
    expectDistinctNonEmptyKeys(items);
  });

  test("errorNotice is always the last item", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      isThinking: true,
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
      errorNotice: "boom",
    });

    expect(items[items.length - 1]).toEqual({
      kind: "error",
      key: "error-notice",
      message: "boom",
    });
    // The full trailer order is thinking -> pendingSecret -> pendingConfirmation -> error.
    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "thinking",
      "pendingSecret",
      "pendingConfirmation",
      "error",
    ]);
    expectDistinctNonEmptyKeys(items);
  });

  test("empty-string errorNotice does NOT produce an ErrorItem", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      errorNotice: "",
    });
    expect(items).toEqual([]);
  });

  test("every item has a non-empty, distinct key in a mixed transcript", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const inline1 = makeSurface({ surfaceId: "inline-1", display: "inline" });
    const inline2 = makeSurface({ surfaceId: "inline-2", display: "inline" });
    const assistantA = makeMessage({
      id: "m2",
      role: "assistant",
      content: "A",
      stableId: "s-a",
    });
    const assistantB = makeMessage({
      id: "m3",
      role: "assistant",
      content: "B",
      stableId: "s-b",
      surfaces: [inline1, inline2],
    });

    const items = buildTranscriptItems({
      messages: [user, assistantA, assistantB],
      pendingSecret: { requestId: "req-s" },
      pendingConfirmation: { requestId: "req-c" },
      isThinking: true,
      errorNotice: "oops",
    });

    expectDistinctNonEmptyKeys(items);
  });

  test("message item carries through the underlying DisplayMessage by reference", () => {
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
    });
    const messageItem = items[0] as MessageItem;
    expect(messageItem.message).toBe(user);
  });

  // ---------------------------------------------------------------------------
  // Phantom tool-only message filter (ATL-659)
  //
  // The daemon synthesises tool calls with `toolName === "unknown"` when a
  // tool_result block has no matching tool_use (orphan). They arrive as
  // empty user messages whose only payload is a list of unknown tool calls
  // and would otherwise render as a confusing "Completed 1 step / Used
  // unknown" chip. Drop them at the projection step.
  // ---------------------------------------------------------------------------

  test("phantom tool-only messages (all toolName === 'unknown') are dropped", () => {
    const phantom = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-phantom",
      toolCalls: [
        { id: "tc-1", toolName: "unknown", input: {}, status: "completed", result: "orphan" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [phantom],
    });

    expect(items).toHaveLength(0);
  });

  test("mixed messages with unknown tool calls alongside content are kept", () => {
    const mixed = makeMessage({
      id: "m1",
      role: "user",
      content: "Here is the result.",
      stableId: "s-mixed",
      toolCalls: [
        { id: "tc-1", toolName: "unknown", input: {}, status: "completed", result: "orphan" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixed],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixed);
  });

  test("messages with mixed known + unknown tool calls are kept", () => {
    const mixedKnown = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-mixed-known",
      toolCalls: [
        { id: "tc-1", toolName: "unknown", input: {}, status: "completed", result: "orphan" },
        { id: "tc-2", toolName: "bash", input: { command: "ls" }, status: "completed", result: "file.txt" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedKnown],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedKnown);
  });

  test("messages with surfaces are kept even with unknown tool calls", () => {
    const surface = makeSurface({ surfaceId: "surf-1", display: "inline" });
    const mixedSurface = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-mixed-surface",
      surfaces: [surface],
      toolCalls: [
        { id: "tc-1", toolName: "unknown", input: {}, status: "completed", result: "orphan" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedSurface],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedSurface);
  });

  test("messages with attachments are kept even with unknown tool calls", () => {
    const mixedAttachment = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-mixed-attachment",
      attachments: [
        { id: "a1", filename: "test.txt", mimeType: "text/plain", sizeBytes: 12, previewUrl: null },
      ],
      toolCalls: [
        { id: "tc-1", toolName: "unknown", input: {}, status: "completed", result: "orphan" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [mixedAttachment],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(mixedAttachment);
  });

  test("real tool-only messages (known toolName) are kept", () => {
    const realTool = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-real-tool",
      toolCalls: [
        { id: "tc-1", toolName: "bash", input: { command: "ls" }, status: "completed", result: "file.txt" },
      ],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [realTool],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(realTool);
  });

  // ---------------------------------------------------------------------------
  // Blank user-row filter — pagination-boundary orphans
  //
  // At a history-pagination boundary, the runtime keeps tool_result-only
  // user rows even when their parent tool_use lives on a previous page
  // (to avoid permanent data loss). `renderHistoryContent` then drops the
  // orphan tool_result block, leaving the row on the wire with no content,
  // no segments, no surfaces, no attachments, and no tool calls — a blank
  // user bubble. The projection layer drops these so they don't render.
  // ---------------------------------------------------------------------------

  test("truly blank user rows (no content, no segments, no surfaces, no attachments, no tool calls) are dropped", () => {
    const blank = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-blank-server",
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [blank],
    });

    expect(items).toHaveLength(0);
  });

  test("blank user rows with whitespace-only content are dropped", () => {
    const whitespace = makeMessage({
      id: "m1",
      role: "user",
      content: "   \n\t  ",
      stableId: "s-blank-ws",
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [whitespace],
    });

    expect(items).toHaveLength(0);
  });

  test("blank user rows with empty textSegments are dropped", () => {
    const emptySegments = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-empty-segments",
      textSegments: [{ type: "text", content: "" }],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [emptySegments],
    });

    expect(items).toHaveLength(0);
  });

  test("user rows with non-empty textSegments are kept (even if content is empty)", () => {
    // Some history paths populate textSegments instead of (or in addition to)
    // the flat content field — those rows are meaningful and must render.
    const segmentsOnly = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-segments-only",
      textSegments: [{ type: "text", content: "Hello via segments" }],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [segmentsOnly],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(segmentsOnly);
  });

  test("user rows with slackMessage chip are kept (even if content is empty)", () => {
    const slack = makeMessage({
      id: "m1",
      role: "user",
      content: "",
      stableId: "s-slack",
      slackMessage: {
        channelId: "C123",
        channelTs: "1700000000.000100",
      },
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [slack],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(slack);
  });

  test("queued blank user rows are NOT dropped (queued marker handles them)", () => {
    // A blank user row with queueStatus="queued" passes through the filter
    // so the projection layer can collapse it into a single QueuedMarker
    // entry — dropping would hide the user's pending intent.
    const queued = makeMessage({
      id: undefined,
      role: "user",
      content: "Send when ready",
      stableId: "s-queued",
      queueStatus: "queued",
      queuePosition: 1,
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [queued],
    });

    // Queued marker collapses queued rows into a single QueuedMarkerItem.
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("queuedMarker");
  });

  test("assistant blank rows are NOT dropped (filter is user-only)", () => {
    // Assistant rows can legitimately be empty during streaming setup —
    // the streaming layer fills them in. The blank-row filter must not
    // touch them.
    const blankAssistant = makeMessage({
      id: "m1",
      role: "assistant",
      content: "",
      stableId: "s-assistant-blank",
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [blankAssistant],
    });

    expect(items).toHaveLength(1);
    expect((items[0] as MessageItem).message).toBe(blankAssistant);
  });

  // ---------------------------------------------------------------------------
  // Confirmation path — inline attachment vs standalone fallback
  // ---------------------------------------------------------------------------

  test("pendingConfirmation: null suppresses the standalone confirmation row (inline attached)", () => {
    // When inline confirmation is attached to a tool call, the page sets
    // pendingConfirmation to null so the standalone row does not appear.
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      pendingConfirmation: null,
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect(items.some((i) => i.kind === "pendingConfirmation")).toBe(false);
  });

  test("pendingConfirmation present emits standalone row (no inline attachment)", () => {
    // When no tool call matches, the standalone confirmation row must appear.
    const user = makeMessage({ id: "m1", role: "user", content: "Hi", stableId: "s-user" });
    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [user],
      pendingConfirmation: { requestId: "req-standalone" },
    });

    const confItems = items.filter((i) => i.kind === "pendingConfirmation");
    expect(confItems).toHaveLength(1);
    expect(confItems[0]!.key).toBe("confirmation-req-standalone");
  });

  test("pendingConfirmation alone (no messages) still emits the row", () => {
    const items = buildTranscriptItems({
      ...emptyInput(),
      pendingConfirmation: { requestId: "req-solo" },
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "pendingConfirmation",
      key: "confirmation-req-solo",
      requestId: "req-solo",
    });
  });

  // ---------------------------------------------------------------------------
  // Inline surfaces never suppress messages
  // ---------------------------------------------------------------------------

  test("surface in contentOrder is part of message item (no standalone row)", () => {
    const wakeSurface = makeSurface({
      surfaceId: "wake-123",
      surfaceType: "card",
      display: "inline",
      title: "Conversation Woke",
    });
    const assistant = makeMessage({
      id: "m1",
      role: "assistant",
      content: "Pushed. Catalog regenerated.",
      stableId: "s-assistant",
      toolCalls: [
        { id: "tc-1", toolName: "bash", input: { command: "echo hi" }, status: "completed" },
      ],
      textSegments: [
        { type: "text", content: "Pushed. Catalog regenerated." },
      ],
      contentOrder: [
        { type: "toolCall", id: "tc-1" },
        { type: "text", id: "0" },
        { type: "surface", id: "wake-123" },
      ],
      surfaces: [wakeSurface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [assistant],
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(assistant);
  });

  test("surfaces on messages do not create standalone rows", () => {
    const surface = makeSurface({
      surfaceId: "surf-app",
      surfaceType: "dynamic_page",
      display: "inline",
    });
    const assistant = makeMessage({
      id: "m1",
      role: "assistant",
      content: "",
      stableId: "s-assistant",
      surfaces: [surface],
    });

    const items = buildTranscriptItems({
      ...emptyInput(),
      messages: [assistant],
    });

    // Only the message item — surfaces live on the message, not as standalone rows
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("message");
    expect((items[0] as MessageItem).message).toBe(assistant);
  });
});

describe("buildTranscriptItems — duplicate server ID dedup", () => {
  test("duplicate server IDs produce only one message item", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ id: "m1", role: "user", content: "Hello" }),
      makeMessage({ id: "m2", role: "assistant", content: "Reply" }),
      makeMessage({ id: "m2", role: "assistant", content: "Reply (dup)" }),
    ];
    const items = buildTranscriptItems({ ...emptyInput(), messages });
    const messageItems = items.filter((i): i is MessageItem => i.kind === "message");
    expect(messageItems).toHaveLength(2);
    expect(messageItems[0]!.message.id).toBe("m1");
    expect(messageItems[1]!.message.id).toBe("m2");
    expect(messageItems[1]!.message.content).toBe("Reply (dup)");
  });

  test("duplicate stable IDs produce only one message item", () => {
    const messages: DisplayMessage[] = [
      makeMessage({
        stableId: "shared-stable",
        id: "m1",
        role: "assistant",
        content: "Streaming replay",
        isStreaming: true,
      }),
      makeMessage({
        stableId: "shared-stable",
        id: "m2",
        role: "assistant",
        content: "Final message",
      }),
    ];

    const items = buildTranscriptItems({ ...emptyInput(), messages });
    const messageItems = items.filter((i): i is MessageItem => i.kind === "message");

    expect(messageItems).toHaveLength(1);
    expect(messageItems[0]!.key).toBe("shared-stable");
    expect(messageItems[0]!.message.content).toBe("Final message");
  });

  test("messages without IDs are not deduped", () => {
    const messages: DisplayMessage[] = [
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Reply" }),
      makeMessage({ role: "assistant", content: "Another reply" }),
    ];
    const items = buildTranscriptItems({ ...emptyInput(), messages });
    const messageItems = items.filter((i): i is MessageItem => i.kind === "message");
    expect(messageItems).toHaveLength(3);
  });
});
