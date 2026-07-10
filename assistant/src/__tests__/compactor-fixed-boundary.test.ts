/**
 * Caller-fixed tail boundary in `runAssistantDrivenCompaction`.
 *
 * With `fixedTailStartIndex` set, the caller pins the cut: the model writes
 * the summary but does not choose a `<tail_start>`, and no token-budget
 * forward-cut applies. Only the tool-pairing back-walk still adjusts the
 * boundary, as defense-in-depth.
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

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import type { Message, Provider } from "../providers/types.js";

function turnTimestamp(turn: number): string {
  const hour = String(10 + Math.floor(turn / 60)).padStart(2, "0");
  const minute = String(turn % 60).padStart(2, "0");
  return `2026-05-21 (Thursday) ${hour}:${minute}:00 -05:00 (America/Chicago)`;
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

const SUMMARY =
  "Alice and Bob discussed onboarding at user@example.com — summarized in my own voice.";

/** Fixed-boundary responses carry no `<tail_start>` — the caller owns the cut. */
const FIXED_RESPONSE = `<compaction_result>
<summary>
${SUMMARY}
</summary>
<key_state>
- Nothing critical pending.
</key_state>
</compaction_result>`;

function responseWithTailStart(tailTurn: number, preview: string): string {
  return `<compaction_result>
<summary>
${SUMMARY}
</summary>
<key_state>
- Nothing critical pending.
</key_state>
<tail_start timestamp="${turnTimestamp(tailTurn)}" preview="${preview}" />
</compaction_result>`;
}

function makeProvider(response: string): {
  provider: Provider;
  callCount: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: "mock-provider",
    sendMessage: async () => {
      calls++;
      return {
        content: [{ type: "text", text: response }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, callCount: () => calls };
}

function plainConversation(turns: number, body = "turn body"): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(userTurn(i, `Alice says: ${body}`));
    messages.push(assistantTurn(i, `Bob's assistant replies: ${body}`));
  }
  return messages;
}

describe("runAssistantDrivenCompaction — caller-fixed tail boundary", () => {
  test("uses the fixed index verbatim when the response has no tail_start", async () => {
    const messages = plainConversation(10);
    const fixedIndex = 12; // user turn 6 — a clean user boundary.
    const { provider } = makeProvider(FIXED_RESPONSE);

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: fixedIndex,
    });

    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(fixedIndex);
    expect(result.preservedTailMessages).toBe(messages.length - fixedIndex);
    // Summary heads the rebuilt history; the tail follows verbatim.
    expect(result.messages[0]?.role).toBe("assistant");
    const tail = result.messages.slice(1);
    expect(tail.length).toBe(messages.length - fixedIndex);
    expect(tail[0]?.role).toBe("user");
  });

  test("ignores a model-emitted tail_start when the boundary is fixed", async () => {
    const messages = plainConversation(10);
    const fixedIndex = 12;
    // The model volunteers a cut at turn 2 (index 4) — it must be ignored.
    const { provider } = makeProvider(
      responseWithTailStart(2, "Alice says: turn body"),
    );

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: fixedIndex,
    });

    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(fixedIndex);
    expect(result.preservedTailMessages).toBe(messages.length - fixedIndex);
  });

  test("walks the fixed boundary back when it would split a tool_use/tool_result pair", async () => {
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "X", name: "Bash", input: {} }],
    };
    const toolResult: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "X", content: "ok" }],
    };
    // [u0, a0, u1, tool_use, tool_result, a1, u2, a2]
    const messages: Message[] = [
      userTurn(0, "Alice opens the conversation"),
      assistantTurn(0, "greeting reply"),
      userTurn(1, "Alice asks to run a command"),
      toolUse,
      toolResult,
      assistantTurn(1, "command finished"),
      userTurn(2, "Alice follows up"),
      assistantTurn(2, "final reply"),
    ];
    const { provider } = makeProvider(FIXED_RESPONSE);

    // Index 4 opens on the tool_result — cutting there would orphan tool_use X.
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: 4,
    });

    expect(result.compacted).toBe(true);
    // The back-walk lands on index 2 (the user turn that opens the exchange).
    expect(result.compactedMessages).toBe(2);
    expect(result.preservedTailMessages).toBe(6);
    const tail = result.messages.slice(1);
    const opensWithToolResult =
      tail[0]?.role === "user" &&
      tail[0].content.some((b) => b.type === "tool_result");
    expect(opensWithToolResult).toBe(false);
  });

  test("applies no budget forward-cut even when the preserved tail is enormous", async () => {
    // Heavy bodies so the tail estimate dwarfs the target — the model-chosen
    // path would advance the cut; the fixed path must not.
    const messages = plainConversation(
      40,
      "a long body that carries real token weight in the estimate. ".repeat(4),
    );
    const fixedIndex = 4; // keep 76 heavy messages.
    const { provider } = makeProvider(FIXED_RESPONSE);

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      // Unreachably tiny budget — must be ignored in fixed mode.
      targetTokens: 1,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: fixedIndex,
    });

    expect(result.compacted).toBe(true);
    expect(result.preservedTailMessages).toBe(messages.length - fixedIndex);
    expect(result.tailFloorReached).toBe(false);
    // No span was dropped, so the summary carries no truncation notice.
    const summaryBlock = result.messages[0]?.content.find(
      (b) => b.type === "text",
    );
    expect(
      summaryBlock && "text" in summaryBlock ? summaryBlock.text : "",
    ).not.toContain("Context budget enforcement");
  });

  test.each([
    ["zero", 0],
    ["past the end", 20],
    ["non-integer", 3.5],
  ])(
    "returns a non-compacted result for an out-of-range fixed index (%s)",
    async (_label, fixedIndex) => {
      const messages = plainConversation(10);
      const { provider, callCount } = makeProvider(FIXED_RESPONSE);

      const result = await runAssistantDrivenCompaction({
        conversationId: "conv-test",
        messages,
        provider,
        systemPrompt: "system",
        compaction: { enabled: true, autoThreshold: 0.7 },
        maxInputTokens: 100_000,
        previousEstimatedInputTokens: 90_000,
        force: true,
        fixedTailStartIndex: fixedIndex,
      });

      expect(result.compacted).toBe(false);
      expect(result.reason).toBe("fixed boundary out of range");
      expect(result.messages).toBe(messages);
      // Validation runs before the provider call — no summary pass is burned.
      expect(callCount()).toBe(0);
    },
  );

  test("counts compactedPersistedMessages against a non-persisted prefix", async () => {
    // Message 0 is a synthetic inherited summary with no DB row.
    const inheritedSummary: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Inherited summary from a parent fork." },
      ],
    };
    const messages: Message[] = [
      inheritedSummary,
      ...plainConversation(5), // 10 persisted messages, indices 1..10
    ];
    const fixedIndex = 7; // user turn 3 — summarizes the prefix + 6 real rows.
    const { provider } = makeProvider(FIXED_RESPONSE);

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: fixedIndex,
      nonPersistedPrefixCount: 1,
    });

    expect(result.compacted).toBe(true);
    expect(result.compactedMessages).toBe(fixedIndex);
    expect(result.compactedPersistedMessages).toBe(fixedIndex - 1);
  });

  test("surfaces the model's summary in summaryText", async () => {
    const messages = plainConversation(6);
    const { provider } = makeProvider(FIXED_RESPONSE);

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
      fixedTailStartIndex: 6,
    });

    expect(result.compacted).toBe(true);
    expect(result.summaryText).toContain(SUMMARY);
    expect(result.keyState).toContain("Nothing critical pending");
    const summaryBlock = result.messages[0]?.content.find(
      (b) => b.type === "text",
    );
    expect(
      summaryBlock && "text" in summaryBlock ? summaryBlock.text : "",
    ).toContain(SUMMARY);
  });
});
