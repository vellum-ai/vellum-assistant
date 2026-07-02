/**
 * Persisted-count accounting when a synthetic context-summary message heads
 * the history.
 *
 * The summary head (minted by `createContextSummaryMessage` on reload/fork
 * inheritance, or by a prior compaction pass in the same process) has no DB
 * row, so `compactedPersistedMessages` must exclude it — otherwise every
 * compaction over an already-summarized history advances the persisted
 * `contextCompactedMessageCount` one row too far and silently drops the
 * first kept message on the next reload.
 *
 * Runs the real compactor arithmetic through `ContextWindowManager` with a
 * canned provider response — only the provider call is seeded.
 */
import { describe, expect, mock, test } from "bun:test";

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: () => ({
    systemPrompt: "you are a test assistant",
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    compaction: { enabled: true, autoThreshold: 0.7, prompt: null },
  }),
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getMessages: () => [],
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
}));

import {
  ContextWindowManager,
  createContextSummaryMessage,
} from "../plugins/defaults/compaction/window-manager.js";
import type { Message, Provider } from "../providers/types.js";

function turnTimestamp(turn: number): string {
  const minute = String(turn % 60).padStart(2, "0");
  return `2026-05-21 (Thursday) 10:${minute}:00 -05:00 (America/Chicago)`;
}

function userTurn(turn: number, body: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<turn_context>\ncurrent_time: ${turnTimestamp(
          turn,
        )}\n</turn_context>\n[U${turn}] ${body}`,
      },
    ],
  };
}

function assistantTurn(turn: number, body: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: `[A${turn}] ${body}` }],
  };
}

/** Fixed-boundary responses carry no `<tail_start>` — the caller owns the cut. */
const FIXED_RESPONSE = `<compaction_result>
<summary>
Alice and Bob's earlier discussion, remembered in my own voice.
</summary>
<key_state>
- Nothing critical pending.
</key_state>
</compaction_result>`;

function responseWithTailStart(tailTurn: number, preview: string): string {
  return `<compaction_result>
<summary>
Alice and Bob's earlier discussion, remembered in my own voice.
</summary>
<key_state>
- Nothing critical pending.
</key_state>
<tail_start timestamp="${turnTimestamp(tailTurn)}" preview="${preview}" />
</compaction_result>`;
}

/** Provider that answers each call with the next queued response. */
function makeProvider(responses: string[]): Provider {
  const queue = [...responses];
  return {
    name: "mock-provider",
    sendMessage: async () => {
      const response = queue.shift();
      if (response === undefined) {
        throw new Error("Provider called more times than responses queued");
      }
      return {
        content: [{ type: "text", text: response }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
}

function buildManager(provider: Provider): ContextWindowManager {
  return new ContextWindowManager({
    provider,
    config: {
      enabled: true,
      maxInputTokens: 200_000,
      targetBudgetRatio: 0.3,
      compactThreshold: 0.8,
      summaryBudgetRatio: 0.05,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "summarize",
      },
    },
    conversationId: "conv-test",
  });
}

/**
 * The in-memory view of a conversation with 10 persisted rows whose first 3
 * are already compacted: a rehydrated summary head followed by rows 3..9.
 * History index = 1 + (row - 3); row 7 lives at index 5.
 */
function historyWithSummaryHead(): Message[] {
  return [
    createContextSummaryMessage("Prior summary covering rows 0-2."),
    userTurn(3, "Alice asks about onboarding"),
    assistantTurn(4, "assistant replies"),
    userTurn(5, "Alice follows up"),
    assistantTurn(6, "assistant replies again"),
    userTurn(7, "Alice changes topic"),
    assistantTurn(8, "assistant answers the new topic"),
    userTurn(9, "Alice wraps up"),
  ];
}

describe("compactedPersistedMessages excludes the synthetic summary head", () => {
  test("fixed boundary over a rehydrated summary head", async () => {
    // GIVEN 10 persisted rows with contextCompactedMessageCount 3 and a
    // summary head, and the user picking row 7 ("summarize up to here") —
    // history index 5
    const messages = historyWithSummaryHead();
    const manager = buildManager(makeProvider([FIXED_RESPONSE]));

    // WHEN the fixed-boundary pass runs
    const result = await manager.maybeCompact(messages, undefined, {
      fixedTailStartIndex: 5,
    });

    // THEN the head is folded into the summary but not counted as a DB row:
    // the persisted count advances 3 → 3 + 4 = 7 (rows 3..6), never 8
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(5);
    expect(result.compactedPersistedMessages).toBe(4);
    expect(result.preservedTailMessages).toBe(3);
  });

  test("model-chosen tail over a rehydrated summary head", async () => {
    // GIVEN the same history, compacting via the model-chosen `<tail_start>`
    // pointing at row 7 (history index 5)
    const messages = historyWithSummaryHead();
    const manager = buildManager(
      makeProvider([responseWithTailStart(7, "Alice changes topic")]),
    );

    // WHEN a forced auto-path pass runs
    const result = await manager.maybeCompact(messages, undefined, {
      force: true,
    });

    // THEN the shared arithmetic excludes the head on this path too
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(5);
    expect(result.compactedPersistedMessages).toBe(4);
  });

  test("second in-process pass over a compaction-minted summary head", async () => {
    // GIVEN a history already compacted once in this process — its head is
    // the summary message the compactor itself minted, not a reload artifact
    const manager = buildManager(
      makeProvider([FIXED_RESPONSE, FIXED_RESPONSE]),
    );
    const first = await manager.maybeCompact(
      historyWithSummaryHead(),
      undefined,
      { fixedTailStartIndex: 5 },
    );
    expect(first.compacted).toBe(true);
    // [minted summary, row 7, row 8, row 9]
    expect(first.messages.length).toBe(4);

    // WHEN a second fixed-boundary pass cuts at row 9 (history index 3, a
    // clean user boundary the tool-pairing walk leaves in place)
    const second = await manager.maybeCompact(first.messages, undefined, {
      fixedTailStartIndex: 3,
    });

    // THEN only rows 7-8 count as compacted-persisted — the minted head does not
    expect(second.compacted).toBe(true);
    expect(second.compactedMessages).toBe(3);
    expect(second.compactedPersistedMessages).toBe(2);
  });

  test("fork-inherited prefix is not double-counted with the summary head", async () => {
    // GIVEN a forked conversation whose seeded non-persisted prefix (2)
    // already includes its inherited summary head
    const messages: Message[] = [
      createContextSummaryMessage("Inherited summary from the parent."),
      assistantTurn(0, "inherited assistant context with no DB row"),
      userTurn(1, "Alice's first persisted message"),
      assistantTurn(2, "assistant replies"),
      userTurn(3, "Alice follows up"),
      assistantTurn(4, "assistant replies again"),
    ];
    const manager = buildManager(makeProvider([FIXED_RESPONSE]));
    manager.seedNonPersistedPrefix(2);

    // WHEN a fixed-boundary pass compacts past the whole inherited prefix
    const result = await manager.maybeCompact(messages, undefined, {
      fixedTailStartIndex: 4,
    });

    // THEN the prefix is subtracted once (max, not summed with the head):
    // compactable = [summary, inherited, row, row] → 2 persisted rows
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(4);
    expect(result.compactedPersistedMessages).toBe(2);
  });

  test("emergency compaction over a rehydrated summary head", async () => {
    // GIVEN a mid-turn overflow history led by a rehydrated summary head,
    // with the last tool pair anchoring the emergency split at index 2
    const messages: Message[] = [
      createContextSummaryMessage("Prior summary covering rows 0-2."),
      userTurn(3, "Alice asks for a command run"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "X", name: "Bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "X", content: "ok" }],
      },
    ];
    // The emergency prompt requests no `<tail_start>` — the canned response
    // mirrors a prompt-following model and must still parse.
    const manager = buildManager(makeProvider([FIXED_RESPONSE]));

    // WHEN emergency compaction runs
    const result = await manager.emergencyCompact(messages, {
      previousEstimatedInputTokens: 190_000,
    });

    // THEN the compacted prefix [head, row 3] counts one persisted row
    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(2);
    expect(result.compactedPersistedMessages).toBe(1);
  });
});
