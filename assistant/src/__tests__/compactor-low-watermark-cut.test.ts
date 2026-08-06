/**
 * Deterministic low-watermark forward-cut enforcement in
 * `runAssistantDrivenCompaction`.
 *
 * When the model keeps a fat verbatim tail, the compactor advances the cut
 * forward (dropping more leading messages into the summarized region) until the
 * rebuilt-history estimate fits `targetTokens` — while never cutting past the
 * most-recent-complete-exchange floor and never orphaning tool_use/tool_result
 * pairs.
 */
import { describe, expect, mock, test } from "bun:test";

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
  runAssistantDrivenCompaction,
  wrapContextSummaryText,
} from "../context/compactor.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
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

function makeProvider(response: string): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: response }],
      model: "mock-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
    }),
  };
}

const SUMMARY = "Earlier turns summarized in the assistant's own voice.";

function compactionResponse(tailTurn: number, preview: string): string {
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

describe("runAssistantDrivenCompaction — low-watermark forward cut", () => {
  test("advances the model's tail forward until the rebuilt history fits the target", async () => {
    // 40 turns = 80 messages, each user body is heavy so the verbatim tail is
    // expensive. The model anchors its tail at turn 4 (keeping ~72 messages);
    // the forward-cut must advance far past that to meet the target.
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(
        userTurn(
          i,
          "User message with a fairly long body so that each turn carries real token weight in the estimate. ".repeat(
            3,
          ),
        ),
      );
      messages.push(
        assistantTurn(
          i,
          "Assistant reply, also reasonably long to contribute estimate weight. ".repeat(
            3,
          ),
        ),
      );
    }

    const targetTokens = 1500;
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(
        compactionResponse(4, "User message with a fairly long body"),
      ),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      targetTokens,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);

    // The rebuilt history (summary + verbatim tail) lands at or below target.
    const estimate = estimatePromptTokens(result.messages, "system", {
      providerName: "mock-provider",
    });
    expect(estimate).toBeLessThanOrEqual(targetTokens);

    // The forward-cut advanced well past the model's chosen anchor (turn 4 →
    // index 8): far fewer tail messages survive than the model kept.
    expect(result.preservedTailMessages).toBeLessThan(messages.length - 8);
    expect(result.preservedTailMessages).toBeGreaterThan(0);

    // The cut found a tail that fits the budget, so the floor was not the
    // binding constraint — no futile-retry signal.
    expect(result.tailFloorReached).toBe(false);
  });

  test("never advances past the most-recent-complete-exchange floor", async () => {
    // A small conversation where the target is unreachably tiny: the cut must
    // still preserve at least the last complete user→assistant exchange.
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(userTurn(i, "short user turn body here"));
      messages.push(assistantTurn(i, "short assistant reply body here"));
    }

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(
        compactionResponse(1, "short user turn body here"),
      ),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      // Target far below anything achievable — forces the cut to the floor.
      targetTokens: 1,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);
    // The last complete exchange (final user + final assistant) survives: the
    // floor is the start of that exchange, so at least 2 tail messages remain.
    expect(result.preservedTailMessages).toBeGreaterThanOrEqual(2);
    // The tail still opens on a user turn (clean forward-cut boundary).
    const tail = result.messages.slice(
      result.messages.length - (result.preservedTailMessages ?? 0),
    );
    expect(tail[0]?.role).toBe("user");
    // The cut advanced to the floor but the surviving tail is still over the
    // (unreachably tiny) target — this is the floor-dominated case the
    // window-manager uses to skip a futile retry.
    expect(result.tailFloorReached).toBe(true);
  });

  test("forward cut lands on a clean user boundary, never orphaning a tool_result", async () => {
    // Build: [u0,a0, u1,a1(tool_use X), u2(tool_result X), a2, u3,a3].
    // The model anchors at turn 0; a naive forward cut could land on the
    // tool_result-only user message and orphan tool_use X. The boundary check
    // must skip it.
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "X", name: "Bash", input: {} }],
    };
    const toolResult: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "X", content: "ok" }],
    };
    const messages: Message[] = [
      userTurn(
        0,
        "first user turn with a long body to weigh the estimate. ".repeat(4),
      ),
      assistantTurn(0, "first assistant reply with a long body. ".repeat(4)),
      userTurn(
        1,
        "second user turn, also long, to add estimate weight. ".repeat(4),
      ),
      toolUse,
      toolResult,
      assistantTurn(2, "assistant continues after the tool result. ".repeat(4)),
      userTurn(3, "final user turn body"),
      assistantTurn(3, "final assistant reply body"),
    ];

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(
        compactionResponse(1, "second user turn, also long"),
      ),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      // Small target to force forward advancement past the tool cluster.
      targetTokens: 200,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);
    const tail = result.messages.slice(
      result.messages.length - (result.preservedTailMessages ?? 0),
    );
    // The tail must not open with an orphaned tool_result.
    const opensWithToolResult =
      tail[0]?.role === "user" &&
      tail[0].content.some((b) => b.type === "tool_result");
    expect(opensWithToolResult).toBe(false);
  });

  test("keeps the model's tail untouched when it already fits the budget", async () => {
    // 10 turns = 20 messages; the model anchors its tail at turn 4 (index 8)
    // and the target is far above the rebuilt-history estimate. Enforcement
    // must not advance the cut at all — the cut is enforcement, not
    // optimization.
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userTurn(i, "short user turn body here"));
      messages.push(assistantTurn(i, "short assistant reply body here"));
    }

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(
        compactionResponse(4, "short user turn body here"),
      ),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      targetTokens: 50_000,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);
    // The model's cut (turn 4 → index 8) keeps messages 8..19 = 12 messages.
    expect(result.preservedTailMessages).toBe(12);
    // No span was dropped, so the summary carries no truncation notice.
    const summaryBlock = result.messages[0]?.content.find(
      (b) => b.type === "text",
    );
    expect(
      summaryBlock && "text" in summaryBlock ? summaryBlock.text : "",
    ).not.toContain("Context budget enforcement");
  });

  test("acknowledges the span dropped by an advanced cut in the summary message", async () => {
    // Same shape as the first test: a heavy conversation where the model's
    // tail choice overshoots the budget and the cut must advance. The span
    // between the model's cut and the enforced cut is in neither the
    // summary's detail nor the retained tail, so the summary message must
    // carry an explicit truncation notice.
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(
        userTurn(
          i,
          "User message with a fairly long body so that each turn carries real token weight in the estimate. ".repeat(
            3,
          ),
        ),
      );
      messages.push(
        assistantTurn(
          i,
          "Assistant reply, also reasonably long to contribute estimate weight. ".repeat(
            3,
          ),
        ),
      );
    }

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(
        compactionResponse(4, "User message with a fairly long body"),
      ),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      targetTokens: 1500,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);
    const summaryBlock = result.messages[0]?.content.find(
      (b) => b.type === "text",
    );
    const summaryTextOut =
      summaryBlock && "text" in summaryBlock ? summaryBlock.text : "";
    // The notice names the dropped span (count by role) so the loss is
    // visible in-context rather than silent.
    expect(summaryTextOut).toContain("Context budget enforcement");
    expect(summaryTextOut).toMatch(
      /\d+ message\(s\) \(\d+ user, \d+ assistant\)/,
    );
    // The original summary body is preserved verbatim ahead of the notice.
    expect(summaryTextOut).toContain(SUMMARY);
    // The notice also rides the DURABLE summary — applyCompactionResult
    // persists and rehydrates from `result.summaryText`, so a notice that
    // lived only on the in-memory message would vanish on reload/fork.
    expect(result.summaryText).toContain("Context budget enforcement");
    // The in-history head is the durable text in the `<context_summary>`
    // wrapper, so rehydration from the persisted column rebuilds the head
    // byte-for-byte.
    expect(summaryTextOut).toBe(wrapContextSummaryText(result.summaryText));
  });
});
