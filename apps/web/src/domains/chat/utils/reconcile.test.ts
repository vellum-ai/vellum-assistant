import { describe, expect, test } from "bun:test";

import {
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
} from "@/domains/chat/utils/reconcile";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  isToolCallCompleted,
} from "@/domains/chat/utils/tool-call-status";
import {
  messageText,
  textBody,
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
    expect(isToolCallCompleted(result[1]!.toolCalls![0]!)).toBe(true);
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
    expect(isToolCallCompleted(result[0]!.toolCalls![0]!)).toBe(true);
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
