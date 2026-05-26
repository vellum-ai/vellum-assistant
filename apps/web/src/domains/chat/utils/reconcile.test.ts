import { describe, expect, test } from "bun:test";

import {
  dedupeDisplayMessages,
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile.js";
import {
  classifySurfaceDisplay,
  type SlackRuntimeMessage,
  type Surface,
} from "@/domains/chat/types/types.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type { RuntimeMessage } from "@/domains/chat/api/messages.js";

// Test factory that produces a DisplayMessage with `id` assigned. Every
// DisplayMessage construction site in production code assigns `id`; tests
// must do the same so the type-level requirement holds.
function makeLocal(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return {
    id: id ?? crypto.randomUUID(),
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
      id: "u1",
      role: "user",
      content: "Run the report",
      timestamp: 1000,
    });
    const cachedAssistant = makeLocal({
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
      id: "optimistic-user",
      role: "user",
      content: "What does my calendar look like Thursday?",
      timestamp: 1000,
      isOptimistic: true,
    });
    const serverUser = makeLocal({
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
      id: "u1",
      role: "user",
      content: "What does my calendar look like Thursday?",
    });
  });

  test("merges a no-id streaming assistant prefix with the matching latest history row", () => {
    const user = makeLocal({
      id: "u1",
      role: "user",
      content: "Plan a Stockholm trip",
      timestamp: 1000,
    });
    const streamingAssistant = makeLocal({
      id: "streaming-assistant",
      role: "assistant",
      content: "Stockholm plan: start with Gamla Stan",
      isStreaming: true,
      isOptimistic: true,
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
      id: "streaming-assistant",
      role: "assistant",
      content: "Stockholm plan: start with Gamla Stan",
      isStreaming: true,
      isOptimistic: true,
      timestamp: 1010,
    });
    const latestAssistant = makeLocal({
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
      id: "a1",
      isStreaming: true,
      content:
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
    });
  });

  test("clears queued state when latest history confirms the user row", () => {
    const queuedUser = makeLocal({
      id: "queued-user",
      role: "user",
      content: "Plan a Stockholm trip",
      timestamp: 1000,
      queueStatus: "queued",
      queuePosition: 1,
      isOptimistic: true,
    });
    const serverUser = makeLocal({
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
      id: "u1",
      role: "user",
      content: "Plan a Stockholm trip",
    });
    expect(result[0]!.queueStatus).toBeUndefined();
    expect(result[0]!.queuePosition).toBeUndefined();
  });

  test("appends newly-arrived assistant turn that completed since the last paint", () => {
    const user = makeLocal({
      id: "u1",
      role: "user",
      content: "What's the weather?",
      timestamp: 1000,
    });
    const oldAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      content: "It's sunny.",
      timestamp: 1010,
    });
    const newUser = makeLocal({
      id: "u2",
      role: "user",
      content: "And tomorrow?",
      timestamp: 1020,
    });
    const newAssistant = makeLocal({
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
      id: "u1",
      role: "user",
      content: "Hello",
      timestamp: 1000,
    });
    const assistant = makeLocal({
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
      // Optimistic rows are tagged `isOptimistic`. The tail content-match
      // block in reconcile.ts drops this row in favor of the server-derived
      // `m1` row.
      makeLocal({ role: "user", content: "Hello", isOptimistic: true }),
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
    // Id carries across so the React key doesn't churn.
    expect(assistant.id).toBe("msg_streaming");
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

  test("transfers blob preview URL from optimistic user row when server content has [File attachment] lines", () => {
    // The optimistic→server swap is a one-time row remount; the row's
    // `id` changes (server id takes over). But the blob preview URL the
    // user is actively looking at MUST survive — the server attachment's
    // UUID-based URL can 404 until upload finalizes.
    const blobAttachment = {
      id: "blob-upload-1",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      previewUrl: "blob:http://localhost/abc",
    };

    const local: DisplayMessage[] = [
      makeLocal({
        id: "optimistic-user",
        role: "user",
        content: "Please review this",
        timestamp: 1000,
        isOptimistic: true,
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
    expect(msg.id).toBe("m1");
    expect(msg.content).toBe("Please review this");
    expect(msg.attachments).toHaveLength(1);
    // The blob URL won — local attachments always preferred over server
    // when both are present (server UUID-only URLs can 404 mid-upload).
    expect(msg.attachments![0]!.previewUrl).toBe("blob:http://localhost/abc");
    expect(msg.isOptimistic).toBeUndefined();
  });
});

describe("reconcileMessages id semantics", () => {
  test("optimistic user row → server row swap: server row takes over, client-side attachments transfer", () => {
    // The queued send path leaves the user row optimistic (`isOptimistic:
    // true`, `id` is a client UUID) until reconcile content-matches it
    // against the server snapshot. The server row takes over identity (a
    // one-time row remount is acceptable) — but the client-side attachments
    // and timestamp the user attached pre-send must transfer to the server
    // row so they don't vanish.
    const optimistic = makeLocal({
      id: "client-user-1",
      role: "user",
      content: "Hello there",
      isOptimistic: true,
      timestamp: 999,
      attachments: [
        {
          id: "att-uuid-1",
          filename: "draft.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
          previewUrl: null,
        },
      ],
    });
    const local: DisplayMessage[] = [optimistic];
    const server: RuntimeMessage[] = [
      { id: "srv-m1", role: "user", content: "Hello there" },
      { id: "srv-m2", role: "assistant", content: "Hi" },
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    // Server row takes over identity — its `id` is the server-assigned one.
    expect(result[0]!.id).toBe("srv-m1");
    expect(result[0]!.isOptimistic).toBeUndefined();
    // Client-side attachments transferred from the optimistic row.
    expect(result[0]!.attachments).toHaveLength(1);
    expect(result[0]!.attachments![0]!.id).toBe("att-uuid-1");
    // And the client-side timestamp survived (server snapshot here
    // didn't carry one).
    expect(result[0]!.timestamp).toBe(999);
  });

  test("identical inputs return reference-equal array", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi there" }),
    ];
    const server: RuntimeMessage[] = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Hi there" },
    ];
    const result = reconcileMessages(local, server);
    expect(result).toBe(local);
  });

  test("reconciliation never mutates a local row", () => {
    const localRow = makeLocal({
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
    expect(localRow.id).toBe("m1");
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
    // and the server has the assistant's response that was missed. The
    // Follow-up was queued at send time (no server id yet) so it carries
    // `isOptimistic: true`.
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello", timestamp: 1000 }),
      makeLocal({ id: "m2", role: "assistant", content: "Hi", timestamp: 2000 }),
      makeLocal({
        role: "user",
        content: "Follow-up",
        timestamp: 3000,
        isOptimistic: true,
      }),
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
  test("two local entries with same id are collapsed", () => {
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

});

describe("dedupeDisplayMessages", () => {
  test("collapses duplicate server ids before reconciliation runs", () => {
    const messages: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", content: "Hello" }),
      makeLocal({
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
      id: "m2",
      role: "assistant",
      content: "Partial, now complete",
      isStreaming: false,
    });
  });

  test("keeps the completed row when a replayed streaming duplicate arrives later", () => {
    const messages: DisplayMessage[] = [
      makeLocal({
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
      id: "m1",
      content: "A complete response",
      isStreaming: false,
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
