import { describe, expect, test } from "bun:test";

import {
  dedupeDisplayMessages,
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
  reconcileMessages,
} from "@/domains/chat/utils/reconcile";
import { liveAssistantRowId } from "@/domains/chat/hooks/stream-message-updaters";
import {
  classifySurfaceDisplay,
  type SlackRuntimeMessage,
  type Surface,
} from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { deriveToolCallStatus } from "@/domains/chat/utils/derive-tool-call-status";
import type { ConversationMessage } from "@vellumai/assistant-api";
import {
  makeServerMessage,
  messageText,
  textBody,
  wireTextBody,
  wireThinkingBody,
  wireTimestamp,
} from "@/domains/chat/utils/message-test-helpers";

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
      ...textBody("Run the report"),
      timestamp: 1000,
    });
    const cachedAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      ...textBody("Working..."),
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-1",
          name: "bash",
          input: {},
        },
      ],
    });
    const latestAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      ...textBody("Done. The report has been posted."),
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-1",
          name: "bash",
          input: {},
          completedAt: 1,
          result: "ok",
        },
        {
          id: "tool-2",
          name: "slack",
          input: {},
          completedAt: 1,
          result: "posted",
        },
      ],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [cachedUser, cachedAssistant],
      [cachedUser, latestAssistant],
      true,
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      ...textBody("Done. The report has been posted."),
    });
    expect(result[1]!.toolCalls).toHaveLength(2);
    expect(result[1]!.toolCalls?.[0]).toMatchObject({
      result: "ok",
    });
    expect(deriveToolCallStatus(result[1]!.toolCalls![0]!)).toBe("completed");
  });

  test("does not roll back longer live text when history fetch is stale", () => {
    const liveAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      timestamp: 1000,
      textSegments: ["This is the longer text already delivered by SSE."],
    });
    const staleHistory = makeLocal({
      id: "a1",
      role: "assistant",
      timestamp: 1000,
      textSegments: ["This is"],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [liveAssistant],
      [staleHistory],
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "a1" });
    // The merged row stays the live row by derivation — the longer local
    // text is never rolled back to the stale snapshot.
    expect(liveAssistantRowId(result, true)).toBe("a1");
    expect(result[0]!.textSegments).toEqual([
      "This is the longer text already delivered by SSE.",
    ]);
  });

  test("replaces an optimistic user row with the matching latest history row", () => {
    const optimisticUser = makeLocal({
      id: "optimistic-user",
      role: "user",
      ...textBody("What does my calendar look like Thursday?"),
      timestamp: 1000,
      isOptimistic: true,
    });
    const serverUser = makeLocal({
      id: "u1",
      role: "user",
      ...textBody("What does my calendar look like Thursday?"),
      timestamp: 1005,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [optimisticUser],
      [serverUser],
      false,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "u1",
      role: "user",
      ...textBody("What does my calendar look like Thursday?"),
    });
  });

  test("merges a no-id streaming assistant prefix with the matching latest history row", () => {
    const user = makeLocal({
      id: "u1",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
      timestamp: 1000,
    });
    const streamingAssistant = makeLocal({
      id: "streaming-assistant",
      role: "assistant",
      isOptimistic: true,
      timestamp: 1010,
      textSegments: ["Stockholm plan: start with Gamla Stan"],
      contentOrder: [{ type: "text", id: "0" }],
    });
    const completedAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      timestamp: 1020,
      textSegments: [
        "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
      ],
      contentOrder: [{ type: "text", id: "0" }],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [user, streamingAssistant],
      [user, completedAssistant],
      true,
    );

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      ...textBody("Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden."),
    });
    // The no-id streaming prefix folds onto the matching history row and
    // stays the live row — the merge layer never declares the turn done.
    expect(liveAssistantRowId(result, true)).toBe("a1");
    expect(result[1]!.textSegments).toEqual([
      "Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden.",
    ]);
  });

  test("keeps the live row live when latest history has the longer assistant row", () => {
    // Even when the latest-history page has a longer assistant body than the
    // local live row, the merge MUST NOT declare the turn complete — row
    // liveness is derived from position + processing state, and only the SSE
    // `message_complete` handler (live path) or the watchdog idle-rescue in
    // `reconcileFetchedMessages` (reconnect path) ends processing.
    const streamingAssistant = makeLocal({
      id: "streaming-assistant",
      role: "assistant",
      ...textBody("Stockholm plan: start with Gamla Stan"),
      isOptimistic: true,
      timestamp: 1010,
    });
    const latestAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      ...textBody("Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden."),
      timestamp: 1020,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [streamingAssistant],
      [latestAssistant],
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "a1",
      ...textBody("Stockholm plan: start with Gamla Stan, then spend the afternoon on Djurgarden."),
    });
    expect(liveAssistantRowId(result, true)).toBe("a1");
  });

  test("merges a collapsed history row into a live assistant row by merged message id", () => {
    const liveToolCalls: ChatMessageToolCall[] = [
      {
        id: "toolu_load_skill",
        name: "bash",
        input: { command: "find geo-writing skill" },
        completedAt: 1,
        result: "ok",
      },
    ];
    const liveAssistant = makeLocal({
      id: "assistant-final",
      role: "assistant",
      timestamp: 1010,
      toolCalls: liveToolCalls,
      textSegments: [
        "Good, that's exactly what we're here for.",
      ],
      contentOrder: [
        { type: "text", id: "0" },
        { type: "toolCall", id: "toolu_load_skill" },
      ],
    });
    const latestAssistant = makeLocal({
      id: "assistant-anchor",
      mergedMessageIds: ["assistant-middle", "assistant-final"],
      role: "assistant",
      ...textBody("Good, that's exactly what we're here for. Everything is set up."),
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-history-assistant-anchor-0",
          name: "bash",
          input: { command: "find geo-writing skill" },
          completedAt: 1,
          result: "ok",
        },
      ],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [liveAssistant],
      [latestAssistant],
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "assistant-anchor",
      mergedMessageIds: ["assistant-middle", "assistant-final"],
    });
    expect(messageText(result[0]!)).toBe(
      "Good, that's exactly what we're here for. Everything is set up.",
    );
    expect(result[0]!.toolCalls).toEqual(liveToolCalls);
  });

  test("backfills finalized history state into alias-linked live tool calls", () => {
    const liveAssistant = makeLocal({
      id: "assistant-final",
      role: "assistant",
      ...textBody("Loading the GEO writing skill"),
      timestamp: 1010,
      toolCalls: [
        {
          id: "toolu_load_skill",
          name: "bash",
          input: { command: "find geo-writing skill" },
        },
      ],
      contentOrder: [{ type: "toolCall", id: "toolu_load_skill" }],
    });
    const latestAssistant = makeLocal({
      id: "assistant-anchor",
      mergedMessageIds: ["assistant-final"],
      role: "assistant",
      textSegments: ["Everything is set up."],
      timestamp: 1010,
      toolCalls: [
        {
          id: "tool-history-assistant-anchor-0",
          name: "bash",
          input: { command: "find geo-writing skill" },
          completedAt: 1,
          result: "source copied",
        },
      ],
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [liveAssistant],
      [latestAssistant],
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.toolCalls).toHaveLength(1);
    expect(result[0]!.toolCalls?.[0]).toMatchObject({
      id: "toolu_load_skill",
      name: "bash",
      input: { command: "find geo-writing skill" },
      result: "source copied",
    });
    expect(deriveToolCallStatus(result[0]!.toolCalls![0]!)).toBe("completed");
    expect(result[0]!.contentOrder).toEqual([
      { type: "toolCall", id: "toolu_load_skill" },
    ]);
  });

  test("clears queued state when latest history confirms the user row", () => {
    const queuedUser = makeLocal({
      id: "queued-user",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
      timestamp: 1000,
      queueStatus: "queued",
      queuePosition: 1,
      isOptimistic: true,
    });
    const serverUser = makeLocal({
      id: "u1",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
      timestamp: 1005,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [queuedUser],
      [serverUser],
      false,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "u1",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
    });
    expect(result[0]!.queueStatus).toBeUndefined();
    expect(result[0]!.queuePosition).toBeUndefined();
  });

  test("appends newly-arrived assistant turn that completed since the last paint", () => {
    const user = makeLocal({
      id: "u1",
      role: "user",
      ...textBody("What's the weather?"),
      timestamp: 1000,
    });
    const oldAssistant = makeLocal({
      id: "a1",
      role: "assistant",
      ...textBody("It's sunny."),
      timestamp: 1010,
    });
    const newUser = makeLocal({
      id: "u2",
      role: "user",
      ...textBody("And tomorrow?"),
      timestamp: 1020,
    });
    const newAssistant = makeLocal({
      id: "a2",
      role: "assistant",
      ...textBody("Cloudy with a chance of rain."),
      timestamp: 1030,
    });

    const result = reconcileDisplayMessagesWithLatestHistory(
      [user, oldAssistant],
      [user, oldAssistant, newUser, newAssistant],
      false,
    );

    expect(result).toHaveLength(4);
    expect(result.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(messageText(result[3]!)).toBe("Cloudy with a chance of rain.");
  });

  test("returns the same array reference when latest history matches current", () => {
    const user = makeLocal({
      id: "u1",
      role: "user",
      ...textBody("Hello"),
      timestamp: 1000,
    });
    const assistant = makeLocal({
      id: "a1",
      role: "assistant",
      ...textBody("Hi there."),
      timestamp: 1010,
    });
    const current = [user, assistant];

    const result = reconcileDisplayMessagesWithLatestHistory(
      current,
      [user, assistant],
      false,
    );

    // Reference equality is the contract callers rely on to decide whether
    // a refresh produced any change vs. landed as a no-op.
    expect(result).toBe(current);
  });
});

describe("reconcileMessages", () => {
  test("returns local messages when server list is empty", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Hi there") }),
    ];
    const result = reconcileMessages(local, []);
    expect(result).toEqual(local);
  });

  test("replaces local messages with server messages", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("partial stream...") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Complete response from server") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "m1", role: "user", ...textBody("Hello") });
    expect(result[1]).toMatchObject({
      id: "m2",
      role: "assistant",
      ...textBody("Complete response from server"),
    });
  });

  test("multi-message turn: server has two assistant messages", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("First reply") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("First reply") }),
      makeServerMessage({ id: "m3", role: "assistant", ...wireTextBody("Second reply after handoff") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      ...textBody("Second reply after handoff"),
    });
  });

  test("preserves optimistic user message not yet on server", () => {
    const optimistic = makeLocal({ role: "user", ...textBody("Second") }); // no id
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("First") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply") }),
      optimistic,
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("First") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Reply") }),
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("First reply") }),
      makeLocal({ id: "m3", role: "assistant", ...textBody("Second reply") }),
    ];

    // WHEN the server response doesn't include the latest message (replication lag)
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("First reply") }),
    ];
    const result = reconcileMessages(local, server);

    // THEN the local message is preserved
    expect(result).toHaveLength(3);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      ...textBody("Second reply"),
    });
  });

  test("preserves an unclaimed streaming assistant tail without an id", () => {
    // GIVEN a local assistant message still being streamed (no server id yet)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ role: "assistant", ...textBody("partial stream...") }),
    ];

    // WHEN the server response only has the user message
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
    ];
    const result = reconcileMessages(local, server);

    // THEN the assistant row is preserved AS-IS in the live tail position. A
    // reconcile that lands mid-stream must not drop or reorder the live
    // bubble — its liveness is derived from that tail position, so dropping
    // it would let the next tool_use_start open a fresh bubble and split the
    // turn.
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: "assistant",
      ...textBody("partial stream..."),
    });
    expect(liveAssistantRowId(result, true)).toBe(result[1]!.id);
  });

  test("does not duplicate tool calls when unclaimed message is preserved", () => {
    // GIVEN a local assistant message with tool calls whose id differs from server
    const toolCalls: ChatMessageToolCall[] = [
      { id: "tc1", name: "search", completedAt: 1, input: {} },
    ];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "sse-123", role: "assistant", ...textBody("Let me check"), toolCalls }),
    ];

    // WHEN the server returns a different id with extended content
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Let me check... Done!") }),
    ];
    const result = reconcileMessages(local, server);

    // THEN tool calls appear only once — on the preserved local message, not grafted onto m2
    const messagesWithTc1 = result.filter(
      (m) => m.toolCalls?.some((tc) => tc.id === "tc1"),
    );
    expect(messagesWithTc1).toHaveLength(1);
    expect(messagesWithTc1[0]).toMatchObject({ id: "sse-123" });
  });

  test("does not preserve a live assistant row separately when server history aliases its id", () => {
    const liveToolCalls: ChatMessageToolCall[] = [
      {
        id: "toolu_check_workspace",
        name: "bash",
        input: { command: "test -d geo-writing" },
        completedAt: 1,
        result: "exists",
      },
    ];
    const local: DisplayMessage[] = [
      makeLocal({
        id: "user-1",
        role: "user",
        ...textBody("I want to write articles that rank better in GEO"),
        timestamp: 1000,
      }),
      makeLocal({
        id: "assistant-final",
        role: "assistant",
        timestamp: 1010,
        toolCalls: liveToolCalls,
        contentOrder: [
          { type: "toolCall", id: "toolu_check_workspace" },
          { type: "text", id: "0" },
        ],
        textSegments: ["Everything is set up."],
      }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "user-1",
        role: "user",
        ...wireTextBody("I want to write articles that rank better in GEO"),
        timestamp: wireTimestamp(1000),
      }),
      makeServerMessage({
        id: "assistant-anchor",
        mergedMessageIds: ["assistant-tool", "assistant-final"],
        role: "assistant",
        ...wireTextBody("Good, that's exactly what we're here for. Everything is set up."),
        timestamp: wireTimestamp(1010),
        toolCalls: [
          {
            name: "bash",
            input: { command: "test -d geo-writing" },
            result: "exists",
          },
        ],
      }),
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.id)).toEqual(["user-1", "assistant-anchor"]);
    expect(result[1]).toMatchObject({
      id: "assistant-anchor",
      mergedMessageIds: ["assistant-tool", "assistant-final"],
    });
    // Local row has toolCalls, so the merge preserves its textSegments (and
    // therefore its derived text) to keep interleaving intact.
    expect(messageText(result[1]!)).toBe("Everything is set up.");
    expect(result[1]!.toolCalls).toEqual(liveToolCalls);
  });

  test("deduplicates optimistic user message when server has matching content", () => {
    const local: DisplayMessage[] = [
      // Optimistic rows are tagged `isOptimistic`. The tail content-match
      // block in reconcile.ts drops this row in favor of the server-derived
      // `m1` row.
      makeLocal({ role: "user", ...textBody("Hello"), isOptimistic: true }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Hi") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "m1", role: "user", ...textBody("Hello") });
    expect(result[1]).toMatchObject({ id: "m2", role: "assistant", ...textBody("Hi") });
  });

  test("keeps an id-matched assistant row live at the tail across reconcile", () => {
    // Row liveness is derived from tail position + processing state, not a
    // stored flag. An id-matched reconcile must keep the assistant row at
    // the tail so the derivation still resolves it as live. The SSE
    // `message_complete` handler and the silent-stall watchdog
    // (`reconcileFetchedMessages` idle-rescue) are the sole authorities that
    // end processing.
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "assistant", ...textBody("streaming...") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "assistant", ...wireTextBody("Complete") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "m1", role: "assistant", ...textBody("Complete") });
    expect(liveAssistantRowId(result, true)).toBe("m1");
  });

  test("handles stream interruption with missing messages", () => {
    // Local only got first message before stream dropped
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("First") }),
    ];
    // Server has the full conversation including messages missed by the stream
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("First") }),
      makeServerMessage({ id: "m3", role: "assistant", ...wireTextBody("Second (missed by stream)") }),
      makeServerMessage({ id: "m4", role: "assistant", ...wireTextBody("Third (missed by stream)") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(4);
    expect(result[2]).toMatchObject({
      id: "m3",
      role: "assistant",
      ...textBody("Second (missed by stream)"),
    });
    expect(result[3]).toMatchObject({
      id: "m4",
      role: "assistant",
      ...textBody("Third (missed by stream)"),
    });
  });

  test("returns same reference when content is unchanged", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Hi there") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Hi there") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toBe(local); // same reference, not just deep equal
  });

  test("returns new reference when content differs", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Old reply") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Updated reply") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).not.toBe(local);
    expect(messageText(result[1]!)).toBe("Updated reply");
  });

  test("preserves surfaces through reconciliation", () => {
    const surface: Surface = {
      surfaceId: "s1",
      surfaceType: "card",
      title: "Test Card",
      data: { key: "value" },
    };
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Here is a card"), surfaces: [surface] }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(2);
    expect(result[1]!.surfaces).toEqual([surface]);
  });

  test("preserves textSegments and contentOrder through reconciliation", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({
        id: "m2",
        role: "assistant",
        ...wireTextBody("Hello world"),
      }),
    ];
    const result = reconcileMessages(local, server);
    expect(result[1]!.textSegments).toEqual([
      "Hello world",
    ]);
    expect(result[1]!.contentOrder).toEqual([{ type: "text", id: "0" }]);
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
      "Let me check...",
      "Done!",
    ];
    const localToolCalls: ChatMessageToolCall[] = [
      {
        id: "tool-use-abc",
        name: "bash",
        input: { command: "ls" },
        completedAt: 1,
      },
    ];
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Run ls") }),
      makeLocal({
        id: "m2",
        role: "assistant",
        toolCalls: localToolCalls,
        contentOrder: localContentOrder,
        textSegments: localTextSegments,
      }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Run ls") }),
      makeServerMessage({
        id: "m2",
        role: "assistant",
        toolCalls: [{ name: "bash", input: { command: "ls" } }],
        contentOrder: ["text:0", "tool:0", "text:1"],
        textSegments: ["Let me check...", "Done!"],
      }),
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({
        id: "m2",
        role: "assistant",
        contentOrder: ["text:0"],
        textSegments: ["Hi!"],
      }),
    ];
    const result = reconcileMessages(local, server);
    expect(result[1]!.contentOrder).toEqual(serverOrder);
    expect(result[1]!.textSegments).toEqual(["Hi!"]);
    expect(result[1]!.toolCalls).toBeUndefined();
  });

});

describe("reconcileMessages — mid-stream sync-tag bubble-split regression", () => {
  // Regression for the bubble-split / "Today 2:42 PM" footer-injection bug.
  // Repro path:
  //   1. SSE stream is live; assistant turn is mid-flight with a running
  //      tool call on the live tail row.
  //   2. The daemon publishes the `conversation:<id>:messages` sync tag
  //      right after persisting the user turn (BEFORE the agent loop
  //      starts), and `web-sync-router.ts` dispatches
  //      `reconcileActiveConversation` against the active tab.
  //   3. `reconcileActiveConversation` fetches a server snapshot via
  //      `/v1/conversations/:id/messages` and feeds it into
  //      `reconcileFromServerDetailed` → `reconcileMessages`.
  //   4. A reconcile that rebuilds the row from the server snapshot must
  //      keep the live row at the tail and carry its running tool calls; if
  //      it dropped or reordered the row, the next `tool_use_start` would
  //      open a fresh `assistant-tool-*` bubble — splitting the turn and
  //      injecting the timestamp footer between the two halves.
  //
  // Contract this test pins down: `reconcileMessages` MUST preserve the
  // live tail row (id + running tool calls) so liveness derivation keeps it
  // streaming. Ending the turn is the job of the SSE `message_complete`
  // handler and the watchdog idle-rescue (`reconcileFetchedMessages`).
  test("preserves the live tail row + running toolCalls when sync-tag reconcile fires mid-stream", () => {
    const runningToolCalls: ChatMessageToolCall[] = [
      {
        id: "toolu_01ABC",
        name: "bash",
        input: { command: "echo streaming" },
      },
    ];
    const liveAssistant = makeLocal({
      id: "msg_streaming",
      role: "assistant",
      toolCalls: runningToolCalls,
      contentOrder: [
        { type: "text", id: "0" },
        { type: "tool", id: "toolu_01ABC" },
      ],
      textSegments: ["Working on it..."],
      timestamp: 2000,
    });
    const local: DisplayMessage[] = [
      makeLocal({ id: "u1", role: "user", ...textBody("Run the script"), timestamp: 1000 }),
      liveAssistant,
    ];

    // Server snapshot taken between `message_start` and `tool_use_start`:
    // the assistant row exists with the same id, content matches the
    // first text delta, but the snapshot has no tool calls.
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "u1", role: "user", ...wireTextBody("Run the script"), timestamp: wireTimestamp(1000) }),
      makeServerMessage({
        id: "msg_streaming",
        role: "assistant",
        ...wireTextBody("Working on it..."),
        timestamp: wireTimestamp(2000),
      }),
    ];

    const result = reconcileMessages(local, server);

    expect(result).toHaveLength(2);
    const assistant = result[1]!;
    // The live bubble must remain at the tail so liveness derivation keeps it
    // streaming — losing it is what caused the next tool_use_start to spawn a
    // fresh bubble.
    expect(liveAssistantRowId(result, true)).toBe("msg_streaming");
    // And the running tool call must survive (local toolCalls always
    // preferred when present).
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls?.[0]).toMatchObject({
      id: "toolu_01ABC",
    });
    expect(deriveToolCallStatus(assistant.toolCalls![0]!)).toBe("running");
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
        ...textBody("Here is my file"),
        timestamp: 1000,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Here is my file"),
        timestamp: wireTimestamp(1000),
        attachments: [
          {
            id: "att-uuid-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      }),
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
        ...textBody("Here is my file"),
        timestamp: 1000,
        attachments: localAttachments,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Here is my file"),
        timestamp: wireTimestamp(1000),
        attachments: [
          {
            id: "att-uuid-1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      }),
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
        ...textBody("An image"),
        timestamp: 1000,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("An image"),
        timestamp: wireTimestamp(1000),
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
      }),
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
        ...textBody("Here is my file"),
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

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Here is my file"),
        timestamp: wireTimestamp(1000),
        attachments: [
          {
            id: "att-real-uuid",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      }),
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
        ...textBody("Here is my file"),
        timestamp: 1000,
        attachments: rehydratedAtts,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Here is my file"),
        timestamp: wireTimestamp(1000),
      }),
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
        ...textBody("Please review this"),
        timestamp: 1000,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Please review this\n[File attachment] spec.pdf, type=application/pdf, size=1.2 MB"),
        timestamp: wireTimestamp(1000),
        attachments: [
          {
            id: "att-uuid",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1258291,
            kind: "file",
          },
        ],
      }),
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(messageText(msg!)).toBe("Please review this");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.id).toBe("att-uuid");
  });

  test("strips [File attachment] lines and syncs textSegments[0]", () => {
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        ...textBody("Check this file"),
        timestamp: 1000,
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        timestamp: wireTimestamp(1000),
        ...wireTextBody(
          "Check this file\n[File attachment] notes.txt, type=text/plain, size=5 B",
        ),
      }),
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(messageText(msg!)).toBe("Check this file");
    expect(msg!.textSegments).toBeDefined();
    expect(msg!.textSegments![0]).toBe("Check this file");
  });

  test("falls back to parsed attachments when server has no structured metadata", () => {
    const local: DisplayMessage[] = [];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Here is the doc\n[File attachment] report.pdf, type=application/pdf, size=2 MB"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(messageText(msg!)).toBe("Here is the doc");
    expect(msg!.attachments).toHaveLength(1);
    expect(msg!.attachments![0]!.id).toBe("rehydrated:0");
    expect(msg!.attachments![0]!.filename).toBe("report.pdf");
    expect(msg!.attachments![0]!.mimeType).toBe("application/pdf");
  });

  test("content without [File attachment] lines is unchanged", () => {
    const local: DisplayMessage[] = [];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Just a normal message"),
        timestamp: wireTimestamp(1000),
      }),
    ];

    const result = reconcileMessages(local, server);
    const msg = result.find((m) => m.id === "m1");
    expect(messageText(msg!)).toBe("Just a normal message");
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
        ...textBody("Please review this"),
        timestamp: 1000,
        isOptimistic: true,
        attachments: [blobAttachment],
      }),
    ];

    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Please review this\n[File attachment] spec.pdf, type=application/pdf, size=4 KB"),
        timestamp: wireTimestamp(1000),
        attachments: [
          {
            id: "att-real-uuid",
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4096,
            kind: "file",
          },
        ],
      }),
    ];

    const result = reconcileMessages(local, server);
    expect(result).toHaveLength(1);
    const msg = result[0]!;
    expect(msg.id).toBe("m1");
    expect(messageText(msg)).toBe("Please review this");
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
      ...textBody("Hello there"),
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
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "srv-m1", role: "user", ...wireTextBody("Hello there") }),
      makeServerMessage({ id: "srv-m2", role: "assistant", ...wireTextBody("Hi") }),
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Hi there") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Hi there") }),
    ];
    const result = reconcileMessages(local, server);
    expect(result).toBe(local);
  });

  test("reconciliation never mutates a local row", () => {
    const localRow = makeLocal({
      id: "m1",
      role: "user",
      ...textBody("Hello"),
    });
    const local: DisplayMessage[] = [localRow];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello changed by server") }),
    ];

    reconcileMessages(local, server);

    // The local row object itself was never mutated.
    expect(localRow.id).toBe("m1");
    expect(messageText(localRow)).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// Timestamp-based ordering tests
// ---------------------------------------------------------------------------

describe("reconcileMessages — timestamp ordering", () => {
  test("sorts local-only messages into correct chronological position", () => {
    // GIVEN local state has a user message sent between two server messages
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("First"), timestamp: 1000 }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply"), timestamp: 2000 }),
      makeLocal({ role: "user", ...textBody("Optimistic"), timestamp: 2500 }),
    ];

    // AND the server returns messages with a new assistant response at ts 3000
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("First"), timestamp: wireTimestamp(1000) }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Reply"), timestamp: wireTimestamp(2000) }),
      makeServerMessage({ id: "m3", role: "assistant", ...wireTextBody("New response"), timestamp: wireTimestamp(3000) }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the optimistic user message appears before the new assistant response
    expect(result).toHaveLength(4);
    expect(messageText(result[0]!)).toBe("First");
    expect(messageText(result[1]!)).toBe("Reply");
    expect(messageText(result[2]!)).toBe("Optimistic");
    expect(messageText(result[3]!)).toBe("New response");
  });

  test("reorders messages when server and local timestamps conflict", () => {
    // GIVEN local state has messages appended out of chronological order
    // (e.g., SSE delivered an older message after a newer one)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello"), timestamp: 1000 }),
      makeLocal({ id: "m3", role: "assistant", ...textBody("Late reply"), timestamp: 3000 }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Earlier reply"), timestamp: 2000 }),
    ];

    // AND the server returns messages in correct chronological order
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello"), timestamp: wireTimestamp(1000) }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Earlier reply"), timestamp: wireTimestamp(2000) }),
      makeServerMessage({ id: "m3", role: "assistant", ...wireTextBody("Late reply"), timestamp: wireTimestamp(3000) }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN messages are in chronological order
    expect(result.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("preserves order for messages without timestamps", () => {
    // GIVEN some messages lack timestamps
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Reply") }),
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello"), timestamp: 1000 }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Hi"), timestamp: 2000 }),
      makeLocal({
        role: "user",
        ...textBody("Follow-up"),
        timestamp: 3000,
        isOptimistic: true,
      }),
    ];

    // AND the server returns all messages including the missed assistant reply
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello"), timestamp: wireTimestamp(1000) }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Hi"), timestamp: wireTimestamp(2000) }),
      makeServerMessage({ id: "m3", role: "user", ...wireTextBody("Follow-up"), timestamp: wireTimestamp(3000) }),
      makeServerMessage({ id: "m4", role: "assistant", ...wireTextBody("Missed reply"), timestamp: wireTimestamp(4000) }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN all messages are in chronological order
    expect(result).toHaveLength(4);
    expect(result.map((m) => messageText(m))).toEqual([
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello"), timestamp: 1000 }),
      makeLocal({ id: "sse-1", role: "assistant", ...textBody("SSE msg"), timestamp: 1500 }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello"), timestamp: wireTimestamp(1000) }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Server msg"), timestamp: wireTimestamp(2000) }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the SSE message (ts 1500) comes before the server msg (ts 2000)
    expect(result).toHaveLength(3);
    expect(messageText(result[0]!)).toBe("Hello");
    expect(messageText(result[1]!)).toBe("SSE msg");
    expect(messageText(result[2]!)).toBe("Server msg");
  });

  test("non-timestamped messages stay in place while timestamped ones sort around them", () => {
    // GIVEN a mix of timestamped and non-timestamped messages where the
    // timestamped ones are out of order (regression test for non-transitive
    // comparator — A(ts=3000) < B(no ts) < C(ts=1000) < A would be a cycle)
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "assistant", ...textBody("Late"), timestamp: 3000 }),
      makeLocal({ id: "m2", role: "user", ...textBody("No timestamp") }),
      makeLocal({ id: "m3", role: "user", ...textBody("Early"), timestamp: 1000 }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "assistant", ...wireTextBody("Late"), timestamp: wireTimestamp(3000) }),
      makeServerMessage({ id: "m2", role: "user", ...wireTextBody("No timestamp") }),
      makeServerMessage({ id: "m3", role: "user", ...wireTextBody("Early"), timestamp: wireTimestamp(1000) }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN timestamped messages are reordered chronologically while the
    // non-timestamped message stays at its original position (index 1)
    expect(messageText(result[0]!)).toBe("Early");
    expect(messageText(result[1]!)).toBe("No timestamp");
    expect(messageText(result[2]!)).toBe("Late");
  });
});

describe("reconcileMessages — thinking blocks", () => {
  test("heals a thinking block truncated by dropped SSE deltas", () => {
    // GIVEN an assistant row whose thinking block lost its leading reasoning
    // because deltas were dropped while the SSE stream was torn down (e.g. the
    // tab was backgrounded and the stream reconnected mid-turn)
    const local: DisplayMessage[] = [
      makeLocal({ id: "u1", role: "user", ...textBody("Draft a tweet") }),
      makeLocal({
        id: "a1",
        role: "assistant",
        thinkingSegments: [") and so I'll present a few concrete options."],
        contentOrder: [{ type: "thinking", id: "0" }],
      }),
    ];

    // AND the server has persisted the complete reasoning for that block
    const fullThinking =
      "Let me check his voice guide and what's live this week (weighing options) and so I'll present a few concrete options.";
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "u1", role: "user", ...wireTextBody("Draft a tweet") }),
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireThinkingBody(fullThinking),
      }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the truncated block is healed from the server's fuller copy
    expect(result).not.toBe(local);
    expect(result[1]!.thinkingSegments).toEqual([fullThinking]);
  });

  test("keeps the locally-streamed thinking block while it is ahead of the server", () => {
    // GIVEN the local row has streamed more reasoning than the server's
    // periodic snapshot has persisted yet
    const localThinking = "Reasoning that is already well underway locally";
    const local: DisplayMessage[] = [
      makeLocal({ id: "u1", role: "user", ...textBody("Hi") }),
      makeLocal({
        id: "a1",
        role: "assistant",
        thinkingSegments: [localThinking],
        contentOrder: [{ type: "thinking", id: "0" }],
      }),
    ];

    // AND the server snapshot still lags behind the live stream
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "u1", role: "user", ...wireTextBody("Hi") }),
      makeServerMessage({
        id: "a1",
        role: "assistant",
        ...wireThinkingBody("Reasoning that is already"),
      }),
    ];

    // WHEN reconciliation runs
    const result = reconcileMessages(local, server);

    // THEN the richer local block is preserved with no rewind (no change)
    expect(result).toBe(local);
    expect(result[1]!.thinkingSegments).toEqual([localThinking]);
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
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply (dup from reconnect)") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Reply") }),
    ];
    const result = reconcileMessages(local, server);
    const ids = result.filter((m) => m.id).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("message_complete double-fire does not produce duplicate ids in output", () => {
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Reply") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({ id: "m1", role: "user", ...wireTextBody("Hello") }),
      makeServerMessage({ id: "m2", role: "assistant", ...wireTextBody("Reply") }),
    ];
    const result = reconcileMessages(local, server);
    const ids = result.filter((m) => m.id).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

});

describe("dedupeDisplayMessages", () => {
  test("collapses duplicate server ids before reconciliation runs", () => {
    const messages: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({
        id: "m2",
        role: "assistant",
        ...textBody("Partial"),
      }),
      makeLocal({
        id: "m2",
        role: "assistant",
        ...textBody("Partial, now complete"),
      }),
    ];

    const result = dedupeDisplayMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      id: "m2",
      role: "assistant",
      ...textBody("Partial, now complete"),
    });
  });

  test("keeps the completed row when a replayed streaming duplicate arrives later", () => {
    const messages: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "assistant",
        ...textBody("A complete response"),
      }),
      makeLocal({
        id: "m1",
        role: "assistant",
        ...textBody("A complete"),
      }),
    ];

    const result = dedupeDisplayMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "m1",
      ...textBody("A complete response"),
    });
  });

  test("returns the same reference when no duplicate identities are present", () => {
    const messages: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Hello") }),
      makeLocal({ id: "m2", role: "assistant", ...textBody("Hi") }),
    ];

    expect(dedupeDisplayMessages(messages)).toBe(messages);
  });
});

describe("reconcileMessages — Slack metadata", () => {
  test("adds server Slack metadata to an existing local message", () => {
    const slackMessage = makeSlackMessage();
    const local: DisplayMessage[] = [
      makeLocal({ id: "m1", role: "user", ...textBody("Slack reply") }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Slack reply"),
        slackMessage,
      }),
    ];

    const result = reconcileMessages(local, server);

    expect(result).not.toBe(local);
    expect(result[0]).toMatchObject({
      id: "m1",
      role: "user",
      ...textBody("Slack reply"),
      slackMessage,
    });
  });

  test("returns same reference when Slack metadata is unchanged", () => {
    const slackMessage = makeSlackMessage();
    const local: DisplayMessage[] = [
      makeLocal({
        id: "m1",
        role: "user",
        ...textBody("Slack reply"),
        slackMessage,
      }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Slack reply"),
        slackMessage,
      }),
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
        ...textBody("Slack reply"),
        slackMessage: localSlackMessage,
      }),
    ];
    const server: ConversationMessage[] = [
      makeServerMessage({
        id: "m1",
        role: "user",
        ...wireTextBody("Slack reply"),
        slackMessage: serverSlackMessage,
      }),
    ];

    const result = reconcileMessages(local, server);

    expect(result).not.toBe(local);
    expect(result[0]!.slackMessage).toEqual(serverSlackMessage);
  });
});
