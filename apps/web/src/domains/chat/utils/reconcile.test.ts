import { describe, expect, test } from "bun:test";

import {
  dedupeDisplayMessages,
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile.js";
import { newStableId } from "@/domains/chat/utils/stable-id.js";
import {
  classifySurfaceDisplay,
  type SlackRuntimeMessage,
  type Surface,
} from "@/domains/chat/types/types.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";

// Test factory that produces DisplayMessages with a stableId assigned. Every
// DisplayMessage construction site in production code assigns one; tests
// must do the same so the type-level requirement holds.
function makeLocal(overrides: Omit<DisplayMessage, "stableId"> & { stableId?: string }): DisplayMessage {
  const { stableId, ...rest } = overrides;
  return {
    stableId: stableId ?? newStableId("test"),
    ...rest,
  };
}

function makeSlackMessage(
  overrides: Partial<SlackRuntimeMessage> = {},
): SlackRuntimeMessage {
  return {
    channelId: "C123",
    channelName: "triage",
    channelTs: "1710000000.000200",
    threadTs: "1710000000.000100",
    sender: {
      id: "U123",
      displayName: "Ada Lovelace",
      username: "ada",
    },
    messageLink: {
      webUrl: "https://example.slack.com/archives/C123/p1710000000000200",
    },
    threadLink: {
      webUrl: "https://example.slack.com/archives/C123/p1710000000000100",
    },
    ...overrides,
  };
}

describe("reconcileDisplayMessagesWithLatestHistory", () => {
  test("merges completed latest history into a cached partial conversation", () => {
    const cachedUser = makeLocal({
      stableId: "cached-user",
      id: "u1",
      role: "user",
      content: "Run the report",
      timestamp: 1000,
    });
    const cachedAssistant = makeLocal({
      stableId: "cached-assistant",
      id: "a1",
      role: "assistant",
      content: "Working...",
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-1",
          toolName: "bash",
          input: {},
          status: "running",
        },
      ],
    });
    const latestAssistant = makeLocal({
      stableId: "server-assistant",
      id: "a1",
      role: "assistant",
      content: "Done. The report has been posted.",
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-1",
          toolName: "bash",
          input: {},
          status: "completed",
          result: "ok",
        },
        {
          id: "tool-2",
          toolName: "slack",
          input: {},
          status: "completed",
          result: "posted",
        },
      ],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [cachedUser, cachedAssistant],
      [cachedUser, latestAssistant],
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      stableId: "cached-assistant",
      id: "a1",
      role: "assistant",
      content: "Done. The report has been posted.",
    });
    expect(result[1]!.toolCalls).toHaveLength(2);
    expect(result[1]!.toolCalls?.[0]).toMatchObject({
      status: "completed",
      result: "ok",
    });
  });

  test("does not roll back longer live text when history fetch is stale", () => {
    const liveAssistant = makeLocal({
      stableId: "live-assistant",
      id: "a1",
      role: "assistant",
      content: "This is the longer text already delivered by SSE.",
      isStreaming: true,
      timestamp: 1000,
      textSegments: [
        {
          type: "text",
          content: "This is the longer text already delivered by SSE.",
        },
      ],
    });
    const staleHistory = makeLocal({
      stableId: "server-assistant",
      id: "a1",
      role: "assistant",
      content: "This is",
      timestamp: 1000,
      textSegments: [{ type: "text", content: "This is" }],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [liveAssistant],
      [staleHistory],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "live-assistant",
      id: "a1",
      content: "This is the longer text already delivered by SSE.",
      isStreaming: true,
    });
    expect(result[0]!.textSegments).toEqual([
      {
        type: "text",
        content: "This is the longer text already delivered by SSE.",
      },
    ]);
  });

  test("replaces an optimistic user row with the matching latest history row", () => {
    const optimisticUser = makeLocal({
      stableId: "optimistic-user",
      role: "user",
      content: "What does my calendar look like Thursday?",
      timestamp: 1000,
    });
    const serverUser = makeLocal({
      stableId: "server-user",
      id: "u1",
      role: "user",
      content: "What does my calendar look like Thursday?",
      timestamp: 1005,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [optimisticUser],
      [serverUser],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "optimistic-user",
      id: "u1",
      role: "user",
      content: "What does my calendar look like Thursday?",
    });
  });

  test("merges a no-id streaming assistant prefix with the matching latest history row", () => {
    const user = makeLocal({
      stableId: "user",
      id: "u1",
      role: "user",
      content: "Plan a Stockholm trip",
      timestamp: 1000,
    });
    const streamingAssistant = makeLocal({
      stableId: "streaming-assistant",
      role: "assistant",
      content: "Stockholm plan: start with Gamla Stan",
      isStreaming: true,
      timestamp: 1010,
      textSegments: [
        {
          type: "text",
          content: "Stockholm plan: start with Gamla Stan",
        },
      ],
      contentOrder: [{ type: "text", id: "0" }],
    });
    const completedAssistant = makeLocal({
      stableId: "server-assistant",
      id: "a1",
      role: "assistant",
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
      timestamp: 1020,
      textSegments: [
        {
          type: "text",
          content:
            "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
        },
      ],
      contentOrder: [{ type: "text", id: "0" }],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [user, streamingAssistant],
      [user, completedAssistant],
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      stableId: "streaming-assistant",
      id: "a1",
      role: "assistant",
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
      // `isStreaming` is client-owned; the merge layer must pass it through
      // unchanged from the live local row. SSE `message_complete` (or the
      // watchdog idle-rescue on reconnect) is the sole authority that clears
      // it.
      isStreaming: true,
    });
    expect(result[1]!.textSegments).toEqual([
      {
        type: "text",
        content:
          "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
      },
    ]);
  });

  test("does not clear streaming state when latest history has the longer assistant row", () => {
    // Even when the latest-history page has a longer assistant body than the
    // local streaming row, the merge MUST preserve `isStreaming`. The merge
    // layer has no authority to declare the turn complete — that is the
    // responsibility of the SSE `message_complete` handler (live path) and
    // the watchdog idle-rescue in `reconcileFetchedMessages` (reconnect
    // path).
    const streamingAssistant = makeLocal({
      stableId: "streaming-assistant",
      role: "assistant",
      content: "Stockholm plan: start with Gamla Stan",
      isStreaming: true,
      timestamp: 1010,
    });
    const latestAssistant = makeLocal({
      stableId: "server-assistant",
      id: "a1",
      role: "assistant",
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
      timestamp: 1020,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [streamingAssistant],
      [latestAssistant],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "streaming-assistant",
      id: "a1",
      isStreaming: true,
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
    });
  });

  test("clears queued state when latest history confirms the user row", () => {
    const queuedUser = makeLocal({
      stableId: "queued-user",
      role: "user",
      content: "Plan a Stockholm trip",
      timestamp: 1000,
      queueStatus: "queued",
      queuePosition: 1,
    });
    const serverUser = makeLocal({
      stableId: "server-user",
      id: "u1",
      role: "user",
      content: "Plan a Stockholm trip",
      timestamp: 1005,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [queuedUser],
      [serverUser],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "queued-user",
      id: "u1",
      role: "user",
      content: "Plan a Stockholm trip",
    });
    expect(result[0]!.queueStatus).toBeUndefined();
    expect(result[0]!.queuePosition).toBeUndefined();
  });

  test("appends newly-arrived assistant turn that completed since the last paint", () => {
    const user = makeLocal({
      stableId: "user",
      id: "u1",
      role: "user",
      content: "What's the weather?",
      timestamp: 1000,
    });
    const oldAssistant = makeLocal({
      stableId: "old-assistant",
      id: "a1",
      role: "assistant",
      content: "It's sunny.",
      timestamp: 1010,
    });
    const newUser = makeLocal({
      stableId: "server-user-2",
      id: "u2",
      role: "user",
      content: "And tomorrow?",
      timestamp: 1020,
    });
    const newAssistant = makeLocal({
      stableId: "server-assistant-2",
      id: "a2",
      role: "assistant",
      content: "Cloudy with a chance of rain.",
      timestamp: 1030,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [user, oldAssistant],
      [user, oldAssistant, newUser, newAssistant],
    );

    expect(result).toHaveLength(4);
    expect(result.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(result[3]!.content).toBe("Cloudy with a chance of rain.");
  });

  test("returns the same array reference when latest history matches current", () => {
    const user = makeLocal({
      stableId: "user",
      id: "u1",
      role: "user",
      content: "Hello",
      timestamp: 1000,
    });
    const assistant = makeLocal({
      stableId: "assistant",
      id: "a1",
      role: "assistant",
      content: "Hi there.",
      timestamp: 1010,
    });
    const current = [user, assistant];

    const result = reconcileDisplayMessagesWithLatestHistory(current, [
      user,
      assistant,
    ]);

    // Reference equality is the contract callers rely on to decide whether
    // a refresh produced any change vs. landed as a no-op.
    expect(result).toBe(current);
  });
});

describe("reconcileMessages", () => {
  test("returns local messages when server list is empty", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi there" }),
    ];
    const result = reconcileMessages(local, []);
    expect(result).toEqual(local);
  });

  test("replaces local messages with server messages", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "partial stream...", isStreaming: true }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Complete response from server" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "m1", role: "user", content: "Hello" });
    expect(result[1]).toMatchObject({
      id: "m2",
      role: "assistant",
      content: "Complete response from server",
    });
    // `isStreaming` is a client-owned flag — server snapshots never carry it
    // and reconcileMessages must not clear it. The SSE `message_complete`
    // handler and the watchdog idle-rescue clear it when appropriate.
    expect(result[1]!.isStreaming).toBe(true);
  });

  test("multi-message turn: server has two assistant messages", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "First reply" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "First reply" },
      { id: "m3", role: "assistant", content: "Second reply after handoff" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      content: "Second reply after handoff",
    });
  });

  test("preserves optimistic user message not yet on server", () => {
    const optimistic = makeLocal({ role: "user", content: "Second" }); // no id
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "First" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply" }),
      optimistic,
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "First" },
      { id: "m2", role: "assistant", content: "Reply" },
    ];
    const result = reconcileMessages(local, server);
    // Server doesn't have the optimistic message yet, so the result is
    // semantically unchanged — same reference returned.
    expect(result).toBe(local);
    expect(result[2]).toBe(optimistic);
  });

  test("preserves assistant message with id not in server response", () => {
    // GIVEN a local assistant message received via SSE with a server-assigned id
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "First reply" }),
      makeLocal({ id: "m3", role: "assistant", content: "Second reply" }),
    ];

    // WHEN the server response doesn't include the latest message (replication lag)
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "First reply" },
    ];
    const result = reconcileMessages(local, server);

    // THEN the local message is preserved
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      content: "Second reply",
    });
    expect(result[2]!.isStreaming).toBeFalsy();
  });

  test("preserves streaming assistant message without id", () => {
    // GIVEN a local assistant message still being streamed (no id yet)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ role: "assistant", content: "partial stream...", isStreaming: true }),
    ];

    // WHEN the server response only has the user message
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
    ];
    const result = reconcileMessages(local, server);

    // THEN the streaming assistant message is preserved AS-IS, including its
    // `isStreaming` flag. A reconcile that lands while the turn is still
    // streaming must not flip the live bubble to "completed" — that would
    // make the bubble-creation tail derivation in stream-message-updaters
    // open a fresh bubble on the next tool_use_start, splitting the turn.
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: "assistant",
      content: "partial stream...",
    });
    expect(result[1]!.isStreaming).toBe(true);
  });

  test("reconciles a no-id streaming assistant prefix with the server response", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        stableId: "user",
        id: "u1",
        role: "user",
        content: "Plan a Stockholm trip",
        timestamp: 1000,
      }),
      makeLocal({
        stableId: "streaming-assistant",
        role: "assistant",
        content: "Stockholm plan: start with Gamla Stan",
        isStreaming: true,
        timestamp: 1010,
      }),
    ];
    const server: RuntimeMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "Plan a Stockholm trip",
        timestamp: 1000,
      },
      {
        id: "a1",
        role: "assistant",
        content:
          "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
        timestamp: 1020,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      stableId: "streaming-assistant",
      id: "a1",
      role: "assistant",
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
    });
    // The live row was matched via the prefix-fallback path. `isStreaming`
    // is client-owned and must survive the merge — SSE `message_complete`
    // (or the watchdog idle-rescue) is the sole authority to clear it.
    expect(result[1]!.isStreaming).toBe(true);
  });

  test("does not duplicate tool calls when unclaimed message is preserved", () => {
    // GIVEN a local assistant message with tool calls whose id differs from server
    const toolCalls: ChatMessageToolCall[] = [
      { id: "tc1", toolName: "search", status: "completed", input: {} },
    ];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "sse-123", role: "assistant", content: "Let me check", toolCalls }),
    ];

    // WHEN the server returns a different id with extended content
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Let me check... Done!" },
    ];
    const result = reconcileMessages(local, server);

    // THEN tool calls appear only once — on the preserved local message, not grafted onto m2
    const messagesWithTc1 = result.filter(
      (m) => m.toolCalls?.some((tc) => tc.id === "tc1"),
    );
    expect(messagesWithTc1).toHaveLength(1);
    expect(messagesWithTc1[0]).toMatchObject({ id: "sse-123" });
  });

  test("deduplicates optimistic user message when server has matching content", () => {
    const local: DisplayMessage[] = [
      makeLocal({ role: "user", content: "Hello" }), // optimistic, no id
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Hi" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "m1", role: "user", content: "Hello" });
    expect(result[1]).toMatchObject({ id: "m2", role: "assistant", content: "Hi" });
  });

  test("preserves client-owned isStreaming flag across id-matched reconcile", () => {
    // `isStreaming` is a live-only client concept. Server snapshots never
    // carry it, so reconcileMessages must pass it through unchanged. The
    // SSE `message_complete` handler and the silent-stall watchdog
    // (`reconcileFetchedMessages` idle-rescue) are the sole authorities
    // that clear it.
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "assistant", content: "streaming...", isStreaming: true }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "assistant", content: "Complete" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "m1", role: "assistant", content: "Complete" });
    expect(result[0]!.isStreaming).toBe(true);
  });

  test("handles stream interruption with missing messages", () => {
    // Local only got first message before stream dropped
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "First" }),
    ];
    // Server has the full conversation including messages missed by the stream
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "First" },
      { id: "m3", role: "assistant", content: "Second (missed by stream)" },
      { id: "m4", role: "assistant", content: "Third (missed by stream)" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(4);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      content: "Second (missed by stream)",
    });
    expect(result[3]).toMatchObject({
      id: "m4",
      role: "assistant",
      content: "Third (missed by stream)",
    });
  });

  test("returns same reference when content is unchanged", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi there" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Hi there" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toBe(local); // same reference, not just deep equal
  });

  test("returns new reference when content differs", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Old reply" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Updated reply" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).not.toBe(local);
    expect(result[1]!.content).toBe("Updated reply");
  });

  test("preserves surfaces through reconciliation", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "card",
      title: "Test Card",
      data: { key: "value" },
    };
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Here is a card", surfaces: [surface] },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[1]!.surfaces).toEqual([surface]);
  });

  test("preserves textSegments and contentOrder through reconciliation", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
    ];
    const segments = [{ type: "text", content: "Hello world" }];
    const order = [{ type: "text", id: "seg-1" }];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      {
        id: "m2",
        role: "assistant",
        content: "Reply",
        textSegments: segments,
        contentOrder: order,
      },
    ];
    const result = reconcileMessages(local, server);
    expect(result[1]!.textSegments).toEqual(segments);
    expect(result[1]!.contentOrder).toEqual(order);
  });

  test("preserves local contentOrder and textSegments when local has toolCalls", () => {
    // During streaming the client builds contentOrder with "toolCall" type
    // entries and UUIDs (e.g. "tool-use-abc"). The server returns contentOrder
    // with "tool" type and index-based ids (e.g. "0"). When local has richer
    // toolCalls, reconciliation must keep the local contentOrder/textSegments
    // so the interleaved rendering path uses matching ids.
    const localContentOrder = [
      { type: "text", id: "0" },
      { type: "toolCall", id: "tool-use-abc" },
      { type: "text", id: "1" },
    ];
    const localTextSegments = [
      { type: "text", content: "Let me check..." },
      { type: "text", content: "Done!" },
    ];
    const localToolCalls: ChatMessageToolCall[] = [
      {
        id: "tool-use-abc",
        toolName: "bash",
        input: { command: "ls" },
        status: "completed",
      },
    ];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Run ls" }),
      makeLocal({
        id: "m2",
        role: "assistant",
        content: "Let me check...Done!",
        toolCalls: localToolCalls,
        contentOrder: localContentOrder,
        textSegments: localTextSegments,
      }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Run ls" },
      {
        id: "m2",
        role: "assistant",
        content: "Let me check...Done!",
        toolCalls: [{ name: "bash", input: { command: "ls" } }],
        contentOrder: [{ type: "text", id: "0" }, { type: "tool", id: "0" }, { type: "text", id: "1" }],
        textSegments: [{ type: "text", content: "Let me check..." }, { type: "text", content: "Done!" }],
      },
    ];
    const result = reconcileMessages(local, server);
    // Should use the local versions because local had richer toolCalls
    expect(result[1]!.toolCalls).toEqual(localToolCalls);
    expect(result[1]!.contentOrder).toEqual(localContentOrder);
    expect(result[1]!.textSegments).toEqual(localTextSegments);
  });

  test("uses server contentOrder when local has no toolCalls", () => {
    // When the local message has no toolCalls (e.g. a text-only message
    // loaded from history), take contentOrder from the server.
    const serverOrder = [{ type: "text", id: "0" }];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      {
        id: "m2",
        role: "assistant",
        content: "Hi!",
        contentOrder: [{ type: "text", id: "0" }],
        textSegments: [{ type: "text", content: "Hi!" }],
      },
    ];
    const result = reconcileMessages(local, server);
    expect(result[1]!.contentOrder).toEqual(serverOrder);
    expect(result[1]!.textSegments).toEqual([{ type: "text", content: "Hi!" }]);
    expect(result[1]!.toolCalls).toBeUndefined();
  });

  test("lost tool call reattachment carries contentOrder and textSegments", () => {
    // When a local message's toolCalls aren't matched during primary
    // reconciliation (e.g. messageId mismatch), the safety net should
    // reattach toolCalls AND their associated contentOrder/textSegments.
    const localContentOrder = [
      { type: "toolCall", id: "tool-xyz" },
      { type: "text", id: "0" },
    ];
    const localTextSegments = [{ type: "text", content: "Here you go." }];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Do it" }),
      makeLocal({
        id: "local-only-id",
        role: "assistant",
        content: "Here you go.",
        toolCalls: [
          { id: "tool-xyz", toolName: "bash", input: { command: "echo hi" }, status: "completed" },
        ],
        contentOrder: localContentOrder,
        textSegments: localTextSegments,
      }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Do it" },
      { id: "m2", role: "assistant", content: "Here you go." },
    ];
    const result = reconcileMessages(local, server);
    const assistant = result.find((m) => m.role === "assistant");
    expect(assistant!.toolCalls).toEqual([
      { id: "tool-xyz", toolName: "bash", input: { command: "echo hi" }, status: "completed" },
    ]);
    expect(assistant!.contentOrder).toEqual(localContentOrder);
    expect(assistant!.textSegments).toEqual(localTextSegments);
  });
});

describe("reconcileMessages — mid-stream sync-tag bubble-split regression", () => {
  // Regression for the bubble-split / "Today 2:42 PM" footer-injection bug
  // (May 23, 2026). Repro path:
  //   1. SSE stream is live; assistant turn is mid-flight with a running
  //      tool call and `isStreaming: true` on the local row.
  //   2. The daemon publishes the `conversation:<id>:messages` sync tag
  //      right after persisting the user turn (BEFORE the agent loop
  //      starts), and `web-sync-router.ts` dispatches
  //      `reconcileActiveConversation` against the active tab.
  //   3. `reconcileActiveConversation` fetches a server snapshot via
  //      `/v1/conversations/:id/messages` and feeds it into
  //      `reconcileFromServerDetailed` → `reconcileMessages`.
  //   4. The pre-fix `reconcileMessages` rebuilt `msg` from scratch and
  //      never copied `localMsg.isStreaming`. The local toolCalls array
  //      was preserved, but the streaming flag was lost — producing the
  //      exact bug fingerprint: `isStreaming:false` + tool call
  //      `status:"running"` on the same row.
  //   5. The bubble-creation tail derivation in stream-message-updaters
  //      then saw `lastMsg.isStreaming === false` and (correctly, given
  //      the corrupted state) opened a fresh `assistant-tool-*` bubble on
  //      the next `tool_use_start` event — splitting the turn and
  //      injecting the timestamp footer between the two halves.
  //
  // Contract this test pins down: `reconcileMessages` MUST preserve the
  // client-owned `isStreaming` flag. SSE `message_complete` and the
  // watchdog idle-rescue (`reconcileFetchedMessages`) are the sole
  // authorities allowed to clear it.
  test("preserves isStreaming + running toolCalls when sync-tag reconcile fires mid-stream", () => {
    const runningToolCalls: ChatMessageToolCall[] = [
      {
        id: "toolu_01ABC",
        toolName: "bash",
        status: "running",
        input: { command: "echo streaming" },
      },
    ];
    const liveAssistant = makeLocal({
      stableId: "live-assistant",
      id: "msg_streaming",
      role: "assistant",
      content: "Working on it...",
      isStreaming: true,
      toolCalls: runningToolCalls,
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "toolu_01ABC" },
      ],
      textSegments: [{ type: "text", content: "Working on it..." }],
      timestamp: 2000,
    });
    const local: DisplayMessage[] = [
      makeLocal({ id: "u1", role: "user", content: "Run the script", timestamp: 1000 }),
      liveAssistant,
    ];

    // Server snapshot taken between `message_start` and `tool_use_start`:
    // the assistant row exists with the same id, content matches the
    // first text delta, but the snapshot has no tool calls and (like
    // every server snapshot) no `isStreaming` field.
    const server: RuntimeMessage[] = [
      { id: "u1", role: "user", content: "Run the script", timestamp: 1000 },
      {
        id: "msg_streaming",
        role: "assistant",
        content: "Working on it...",
        timestamp: 2000,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    const assistant = result[1]!;
    // The live bubble must remain streaming — clearing this flag is what
    // caused the next tool_use_start to spawn a fresh bubble.
    expect(assistant.isStreaming).toBe(true);
    // And the running tool call must survive (local toolCalls always
    // preferred when present).
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]).toMatchObject({
      id: "toolu_01ABC",
      status: "running",
    });
    // StableId carries across so the React key doesn't churn.
    expect(assistant.stableId).toBe("live-assistant");
  });

  test("preserves isStreaming for a no-id streaming assistant prefix matched via fallback", () => {
    // Same regression, exercising the fallback-match path: the live
    // assistant row had no server id yet (SSE delivered text deltas but
    // not the `message_start` id), so reconcile matches via role + content
    // prefix against the server snapshot.
    const liveAssistant = makeLocal({
      stableId: "live-no-id",
      role: "assistant",
      content: "Working",
      isStreaming: true,
      toolCalls: [
        { id: "toolu_xyz", toolName: "bash", status: "running", input: {} },
      ],
      timestamp: 2000,
    });
    const local: DisplayMessage[] = [
      makeLocal({ id: "u1", role: "user", content: "Run it", timestamp: 1000 }),
      liveAssistant,
    ];
    const server: RuntimeMessage[] = [
      { id: "u1", role: "user", content: "Run it", timestamp: 1000 },
      {
        id: "msg_assigned_later",
        role: "assistant",
        content: "Working on it now",
        timestamp: 2000,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    const assistant = result[1]!;
    expect(assistant.isStreaming).toBe(true);
    expect(assistant.id).toBe("msg_assigned_later");
    expect(assistant.stableId).toBe("live-no-id");
    expect(assistant.toolCalls?.[0]).toMatchObject({ status: "running" });
  });
});

describe("reconcileMessages — server attachment propagation", () => {
  test("populates attachments from server metadata when local has none", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: [
          {
            id: "att-uuid-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]).toMatchObject({
      id: "att-uuid-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      previewUrl: null,
    });
  });

  test("preserves local attachments over server metadata when local exist", () => {
    const localAttachments = [
      {
        id: "att-uuid-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4096,
        previewUrl: "blob:local-preview-url",
      },
    ];

    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: localAttachments,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: [
          {
            id: "att-uuid-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.attachments).toEqual(localAttachments);
    expect(msg!.attachments![0]!.previewUrl).toBe("blob:local-preview-url");
  });

  test("converts server attachment thumbnailData into previewUrl", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "An image",
        timestamp: 1000,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "An image",
        timestamp: 1000,
        attachments: [
          {
            id: "att-img",
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 8192,
            kind: "file",
            thumbnailData: "dGh1bWJuYWls",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.previewUrl).toBe(
      "data:image/jpeg;base64,dGh1bWJuYWls",
    );
  });

  test("replaces rehydrated stubs with real server attachments when available", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: [
          {
            id: "rehydrated:0",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 0,
            previewUrl: null,
          },
        ],
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: [
          {
            id: "att-real-uuid",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.id).toBe("att-real-uuid");
    expect(msg!.attachments![0]!.sizeBytes).toBe(4096);
  });

  test("keeps rehydrated stubs when server has no structured attachments", () => {
    const rehydratedAtts = [
      {
        id: "rehydrated:0",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
        previewUrl: null,
      },
    ];

    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
        attachments: rehydratedAtts,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Here is my file",
        timestamp: 1000,
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.attachments).toEqual(rehydratedAtts);
  });

  test("strips [File attachment] summary lines from reconciled content", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Please review this",
        timestamp: 1000,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content:
          "Please review this\n[File attachment] spec.pdf, type=application/pdf, size=1.2 MB",
        timestamp: 1000,
        attachments: [
          {
            id: "att-uuid",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1258291,
            kind: "file",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.content).toBe("Please review this");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.id).toBe("att-uuid");
  });

  test("strips [File attachment] lines and syncs textSegments[0]", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Check this file",
        timestamp: 1000,
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content:
          "Check this file\n[File attachment] notes.txt, type=text/plain, size=5 B",
        timestamp: 1000,
        textSegments: [
          {
            type: "text",
            content:
              "Check this file\n[File attachment] notes.txt, type=text/plain, size=5 B",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.content).toBe("Check this file");
    expect(msg!.textSegments).toBeDefined();
    expect(msg!.textSegments![0]!.content).toBe("Check this file");
  });

  test("falls back to parsed attachments when server has no structured metadata", () => {
    const local: DisplayMessage[] = [];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content:
          "Here is the doc\n[File attachment] report.pdf, type=application/pdf, size=2 MB",
        timestamp: 1000,
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.content).toBe("Here is the doc");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.id).toBe("rehydrated:0");
    expect(msg!.attachments![0]!.filename).toBe("report.pdf");
    expect(msg!.attachments![0]!.mimeType).toBe("application/pdf");
  });

  test("content without [File attachment] lines is unchanged", () => {
    const local: DisplayMessage[] = [];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Just a normal message",
        timestamp: 1000,
      },
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(msg!.content).toBe("Just a normal message");
    expect(msg!.attachments).toBeUndefined();
  });

  test("preserves stableId for optimistic user message when server content has [File attachment] lines", () => {
    const blobAttachment = {
      id: "blob-upload-1",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      previewUrl: "blob:http://localhost/abc",
    };

    const local: DisplayMessage[] = [
      makeLocal({
        stableId: "optimistic-user",
        role: "user",
        content: "Please review this",
        timestamp: 1000,
        attachments: [blobAttachment],
      }),
    ];

    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content:
          "Please review this\n[File attachment] spec.pdf, type=application/pdf, size=4 KB",
        timestamp: 1000,
        attachments: [
          {
            id: "att-real-uuid",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      },
    ];

    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.stableId).toBe("optimistic-user");
    expect(msg.id).toBe("m1");
    expect(msg.content).toBe("Please review this");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.previewUrl).toBe("blob:http://localhost/abc");
  });
});

describe("reconcileMessages stableId preservation", () => {
  test("preserves stableId when an optimistic user message (no server id) gets reconciled", () => {
    // The user hits send. We push an optimistic user bubble with a client
    // stableId. The server echoes back the same content with a freshly
    // minted server id.
    const optimistic = makeLocal({
      stableId: "stable-user-1",
      role: "user",
      content: "Hello there",
    });
    const local: DisplayMessage[] = [optimistic];
    const server: RuntimeMessage[] = [
      { id: "srv-m1", role: "user", content: "Hello there" },
      { id: "srv-m2", role: "assistant", content: "Hi" },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    // The user bubble carries the original stableId even though its `id`
    // changed from undefined → "srv-m1".
    expect(result[0]!.stableId).toBe("stable-user-1");
    expect(result[0]!.id).toBe("srv-m1");
    // The server-only assistant row got a fresh stableId.
    expect(result[1]!.stableId).not.toBe("stable-user-1");
    expect(typeof result[1]!.stableId).toBe("string");
    expect(result[1]!.stableId.length).toBeGreaterThan(0);
  });

  test("preserves stableId when a streaming assistant bubble is reconciled with the server's final row", () => {
    // While streaming, we had a temp id. When the server persists the message
    // it may rewrite the id; the stableId must stick.
    const streaming = makeLocal({
      stableId: "stable-assistant-1",
      id: "temp-m2",
      role: "assistant",
      content: "Partial...",
      isStreaming: true,
    });
    const local: DisplayMessage[] = [
      makeLocal({ stableId: "stable-user-1", id: "srv-m1", role: "user", content: "Q" }),
      streaming,
    ];
    // Server uses a different id for the assistant message (simulates the
    // fallback path since the streaming id doesn't match).
    const server: RuntimeMessage[] = [
      { id: "srv-m1", role: "user", content: "Q" },
      { id: "srv-m2", role: "assistant", content: "Partial..." },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    expect(result[0]!.stableId).toBe("stable-user-1");
    // Assistant row matched by role+content fallback, so stableId survived.
    expect(result[1]!.stableId).toBe("stable-assistant-1");
    expect(result[1]!.id).toBe("srv-m2");
    // The live row was still streaming when the reconcile fired — preserve
    // the client-owned `isStreaming` flag, the SSE message_complete handler
    // (or the watchdog idle-rescue) will clear it when authoritative.
    expect(result[1]!.isStreaming).toBe(true);
  });

  test("preserves stableId across id-matched reconciliation", () => {
    const local: DisplayMessage[] = [
      makeLocal({ stableId: "stable-1", id: "m1", role: "user", content: "Hi" }),
      makeLocal({ stableId: "stable-2", id: "m2", role: "assistant", content: "Yo" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hi" },
      { id: "m2", role: "assistant", content: "Yo — updated by server" },
    ];

    const result = reconcileMessages(local, server);

    expect(result[0]!.stableId).toBe("stable-1");
    expect(result[1]!.stableId).toBe("stable-2");
    expect(result[1]!.content).toBe("Yo — updated by server");
  });

  test("server-only messages (not present locally) get a fresh stableId on insertion", () => {
    const local: DisplayMessage[] = [
      makeLocal({ stableId: "stable-user-1", id: "m1", role: "user", content: "Hi" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hi" },
      { id: "m2", role: "assistant", content: "Server-only" },
      { id: "m3", role: "assistant", content: "Another server-only" },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(3);
    expect(result[0]!.stableId).toBe("stable-user-1");
    // m2 and m3 have no local counterpart → fresh ids. Must be non-empty
    // strings and distinct from the local id.
    expect(result[1]!.stableId).not.toBe("stable-user-1");
    expect(result[2]!.stableId).not.toBe("stable-user-1");
    expect(result[1]!.stableId).not.toBe(result[2]!.stableId);
  });

  test("identical inputs still return reference-equal array even with stableIds set", () => {
    const local: DisplayMessage[] = [
      makeLocal({ stableId: "stable-1", id: "m1", role: "user", content: "Hello" }),
      makeLocal({ stableId: "stable-2", id: "m2", role: "assistant", content: "Hi there" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Hi there" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toBe(local);
  });

  test("reconciliation never mutates a local row's stableId", () => {
    const originalStableId = "stable-never-mutated";
    const localRow = makeLocal({
      stableId: originalStableId,
      id: "m1",
      role: "user",
      content: "Hello",
    });
    const local: DisplayMessage[] = [localRow];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello changed by server" },
    ];

    reconcileMessages(local, server);

    // The local row object itself was never mutated.
    expect(localRow.stableId).toBe(originalStableId);
    expect(localRow.content).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Timestamp-based ordering tests
// ---------------------------------------------------------------------------

describe("reconcileMessages — timestamp ordering", () => {
  test("sorts local-only messages into correct chronological position", () => {
    // GIVEN local state has a user message sent between two server messages
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "First", timestamp: 1000 }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply", timestamp: 2000 }),
      makeLocal({ role: "user", content: "Optimistic", timestamp: 2500 }),
    ];

    // AND the server returns messages with a new assistant response at ts 3000
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "First", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "Reply", timestamp: 2000 },
      { id: "m3", role: "assistant", content: "New response", timestamp: 3000 },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the optimistic user message appears before the new assistant response
    expect(result).toHaveLength(4);
    expect(result[0]!.content).toBe("First");
    expect(result[1]!.content).toBe("Reply");
    expect(result[2]!.content).toBe("Optimistic");
    expect(result[3]!.content).toBe("New response");
  });

  test("reorders messages when server and local timestamps conflict", () => {
    // GIVEN local state has messages appended out of chronological order
    // (e.g., SSE delivered an older message after a newer one)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello", timestamp: 1000 }),
      makeLocal({ id: "m3", role: "assistant", content: "Late reply", timestamp: 3000 }),
      makeLocal({ id: "m2", role: "assistant", content: "Earlier reply", timestamp: 2000 }),
    ];

    // AND the server returns messages in correct chronological order
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "Earlier reply", timestamp: 2000 },
      { id: "m3", role: "assistant", content: "Late reply", timestamp: 3000 },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN messages are in chronological order
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("preserves order for messages without timestamps", () => {
    // GIVEN some messages lack timestamps
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Reply" },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN original order is preserved (reference equality, nothing changed)
    expect(result).toBe(local);
  });

  test("sorts reconnect catch-up messages by timestamp", () => {
    // GIVEN the user sent a message while the SSE stream was disconnected
    // and the server has the assistant's response that was missed
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello", timestamp: 1000 }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi", timestamp: 2000 }),
      makeLocal({ role: "user", content: "Follow-up", timestamp: 3000 }),
    ];

    // AND the server returns all messages including the missed assistant reply
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "Hi", timestamp: 2000 },
      { id: "m3", role: "user", content: "Follow-up", timestamp: 3000 },
      { id: "m4", role: "assistant", content: "Missed reply", timestamp: 4000 },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN all messages are in chronological order
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.content)).toEqual([
      "Hello",
      "Hi",
      "Follow-up",
      "Missed reply",
    ]);
  });

  test("local-only message with earlier timestamp sorts before server-only messages", () => {
    // GIVEN a local SSE message with timestamp 1500 that the server
    // hasn't persisted yet, and the server has a message at ts 2000
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello", timestamp: 1000 }),
      makeLocal({ id: "sse-1", role: "assistant", content: "SSE msg", timestamp: 1500 }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello", timestamp: 1000 },
      { id: "m2", role: "assistant", content: "Server msg", timestamp: 2000 },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the SSE message (ts 1500) comes before the server msg (ts 2000)
    expect(result).toHaveLength(3);
    expect(result[0]!.content).toBe("Hello");
    expect(result[1]!.content).toBe("SSE msg");
    expect(result[2]!.content).toBe("Server msg");
  });

  test("non-timestamped messages stay in place while timestamped ones sort around them", () => {
    // GIVEN a mix of timestamped and non-timestamped messages where the
    // timestamped ones are out of order (regression test for non-transitive
    // comparator — A(ts=3000) < B(no ts) < C(ts=1000) < A would be a cycle)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "assistant", content: "Late", timestamp: 3000 }),
      makeLocal({ id: "m2", role: "user", content: "No timestamp" }),
      makeLocal({ id: "m3", role: "user", content: "Early", timestamp: 1000 }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "assistant", content: "Late", timestamp: 3000 },
      { id: "m2", role: "user", content: "No timestamp" },
      { id: "m3", role: "user", content: "Early", timestamp: 1000 },
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN timestamped messages are reordered chronologically while the
    // non-timestamped message stays at its original position (index 1)
    expect(result[0]!.content).toBe("Early");
    expect(result[1]!.content).toBe("No timestamp");
    expect(result[2]!.content).toBe("Late");
  });
});

describe("newStableId", () => {
  test("produces unique values across rapid successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(newStableId("rapid"));
    }
    expect(ids.size).toBe(1000);
  });

  test("uses the provided prefix", () => {
    const id = newStableId("custom-prefix");
    expect(id.startsWith("custom-prefix-")).toBe(true);
  });

  test("defaults to 'msg' prefix", () => {
    const id = newStableId();
    expect(id.startsWith("msg-")).toBe(true);
  });
});

describe("classifySurfaceDisplay", () => {
  test("returns 'inline' for dynamic_page with appId", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "dynamic_page",
      data: { appId: "app-123" },
    };
    expect(classifySurfaceDisplay(surface)).toBe("inline");
  });

  test("returns 'inline' for dynamic_page with preview", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "dynamic_page",
      data: { preview: true },
    };
    expect(classifySurfaceDisplay(surface)).toBe("inline");
  });

  test("returns original display for dynamic_page without appId or preview", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "dynamic_page",
      data: { someOtherField: "value" },
      display: "panel",
    };
    expect(classifySurfaceDisplay(surface)).toBe("panel");
  });

  test("forces inline for non-dynamic_page surfaces", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "form",
      data: { appId: "app-123" },
      display: "panel",
    };
    expect(classifySurfaceDisplay(surface)).toBe("inline");
  });

  test("forces inline when no display is set on a non-app surface", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "card",
      data: {},
    };
    expect(classifySurfaceDisplay(surface)).toBe("inline");
  });
});

// ---------------------------------------------------------------------------
// Duplicate key regression tests
// ---------------------------------------------------------------------------

describe("reconcileMessages — dedup safety net", () => {
  test("two local entries with same server id but different stableIds are collapsed", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply (dup from reconnect)" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Reply" },
    ];
    const result = reconcileMessages(local, server);
    const ids = result.filter((m) => m.id).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("message_complete double-fire does not produce duplicate ids in output", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply" }),
      makeLocal({ id: "m2", role: "assistant", content: "Reply" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Reply" },
    ];
    const result = reconcileMessages(local, server);
    const ids = result.filter((m) => m.id).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("preserves row-scoped daemonMessageId when reconciling by display id", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({
        id: "display-a1",
        daemonMessageId: "row-a2",
        role: "assistant",
        content: "Let me check. Done.",
      }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      {
        id: "display-a1",
        daemonMessageId: "row-a2",
        role: "assistant",
        content: "Let me check. Done.",
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: "display-a1",
      daemonMessageId: "row-a2",
      role: "assistant",
      content: "Let me check. Done.",
    });
  });

  test("matches a pre-terminal streaming row by daemonMessageId when history uses the display id", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({
        stableId: "streaming-assistant",
        id: "row-a2",
        daemonMessageId: "row-a2",
        role: "assistant",
        content: "Got all three. Here's the breakdown",
        isStreaming: true,
        timestamp: 1000,
        toolCalls: [
          {
            id: "tool-1",
            toolName: "weather",
            input: {},
            status: "running",
          },
        ],
      }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      {
        id: "display-a1",
        daemonMessageId: "row-a2",
        role: "assistant",
        content: "Got all three. Here's the breakdown for Saturday.",
        timestamp: 1000,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      stableId: "streaming-assistant",
      id: "display-a1",
      daemonMessageId: "row-a2",
      role: "assistant",
      content: "Got all three. Here's the breakdown for Saturday.",
    });
    expect(result[1]!.toolCalls).toEqual(local[1]!.toolCalls);
    expect(result.some((m) => m.id === "row-a2")).toBe(false);
  });

  test("two entries with same stableId but different server ids are collapsed", () => {
    const shared = newStableId("server");
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      { stableId: shared, id: "m2", role: "assistant", content: "Reply A" },
      { stableId: shared, id: "m3", role: "assistant", content: "Reply B" },
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Reply A" },
      { id: "m3", role: "assistant", content: "Reply B" },
    ];
    const result = reconcileMessages(local, server);
    const stableIds = result.map((m) => m.stableId);
    expect(new Set(stableIds).size).toBe(stableIds.length);
  });
});

describe("dedupeDisplayMessages", () => {
  test("collapses duplicate server ids before reconciliation runs", () => {
    const firstStableId = "stable-first";
    const messages: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({
        stableId: firstStableId,
        id: "m2",
        role: "assistant",
        content: "Partial",
        isStreaming: true,
      }),
      makeLocal({
        id: "m2",
        role: "assistant",
        content: "Partial, now complete",
      }),
    ];

    const result = dedupeDisplayMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      stableId: firstStableId,
      id: "m2",
      role: "assistant",
      content: "Partial, now complete",
      isStreaming: false,
    });
  });

  test("keeps the completed row when a replayed streaming duplicate arrives later", () => {
    const messages: DisplayMessage[] = [
      makeLocal({
        stableId: "stable-final",
        id: "m1",
        role: "assistant",
        content: "A complete response",
      }),
      makeLocal({
        id: "m1",
        role: "assistant",
        content: "A complete",
        isStreaming: true,
      }),
    ];

    const result = dedupeDisplayMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "stable-final",
      id: "m1",
      content: "A complete response",
      isStreaming: false,
    });
  });

  test("collapses duplicate stable ids even when server ids differ", () => {
    const messages: DisplayMessage[] = [
      makeLocal({
        stableId: "shared-stable",
        id: "m1",
        role: "assistant",
        content: "First",
      }),
      makeLocal({
        stableId: "shared-stable",
        id: "m2",
        role: "assistant",
        content: "Second with more detail",
      }),
    ];

    const result = dedupeDisplayMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      stableId: "shared-stable",
      id: "m2",
      content: "Second with more detail",
    });
  });

  test("returns the same reference when no duplicate identities are present", () => {
    const messages: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi" }),
    ];

    expect(dedupeDisplayMessages(messages)).toBe(messages);
  });
});

describe("reconcileMessages — Slack metadata", () => {
  test("adds server Slack metadata to an existing local message", () => {
    const slackMessage = makeSlackMessage();
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Slack reply" }),
    ];
    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Slack reply",
        slackMessage,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).not.toBe(local);
    expect(result[0]).toMatchObject({
      id: "m1",
      role: "user",
      content: "Slack reply",
      slackMessage,
    });
  });

  test("returns same reference when Slack metadata is unchanged", () => {
    const slackMessage = makeSlackMessage();
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Slack reply",
        slackMessage,
      }),
    ];
    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Slack reply",
        slackMessage,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toBe(local);
  });

  test("updates when Slack link or sender metadata changes", () => {
    const localSlackMessage = makeSlackMessage();
    const serverSlackMessage = makeSlackMessage({
      sender: {
        id: "U123",
        displayName: "Ada Byron",
        username: "ada",
      },
      messageLink: {
        webUrl: "https://example.slack.com/archives/C123/p1710000000000300",
      },
    });
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        content: "Slack reply",
        slackMessage: localSlackMessage,
      }),
    ];
    const server: RuntimeMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "Slack reply",
        slackMessage: serverSlackMessage,
      },
    ];

    const result = reconcileMessages(local, server);

    expect(result).not.toBe(local);
    expect(result[0]!.slackMessage).toEqual(serverSlackMessage);
  });
});
