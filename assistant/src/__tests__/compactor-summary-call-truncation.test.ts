/**
 * The compaction summary call bounds its own input to the context window.
 *
 * With no tool pair to anchor an emergency split, an overflow recovery routes
 * the full conversation straight into `runAssistantDrivenCompaction`. If that
 * history exceeds the window, the summary call must front-truncate its own
 * request or it overflows in turn and recovery stalls. Below the window the
 * request is sent untouched so its prefix stays byte-aligned with the agent's
 * warm cache (the budget-path cache reuse must not regress).
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
import { estimatePromptTokens } from "../context/token-estimator.js";
import type { Message, Provider } from "../providers/types.js";

const TRUNCATION_MARKER = "summary covers only the visible portion";

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

function makeCapturingProvider(response: string): {
  provider: Provider;
  lastRequest: () => Message[] | null;
} {
  let captured: Message[] | null = null;
  const provider: Provider = {
    name: "mock-provider",
    sendMessage: async (messages: Message[]) => {
      captured = messages;
      return {
        content: [{ type: "text", text: response }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, lastRequest: () => captured };
}

function estimate(messages: Message[]): number {
  return estimatePromptTokens(messages, "system", {
    providerName: "mock-provider",
  });
}

describe("runAssistantDrivenCompaction — summary call self-truncation", () => {
  test("front-truncates the outbound request when the full history exceeds the context window", async () => {
    // GIVEN a tool-pair-free history whose estimate exceeds the window, so an
    // overflow recovery would route it straight into the summary call.
    const messages: Message[] = [];
    for (let i = 0; i < 40; i++) {
      messages.push(
        userTurn(
          i,
          "Heavy user turn body that carries real weight. ".repeat(8),
        ),
      );
      messages.push(
        assistantTurn(
          i,
          "Heavy assistant reply that also carries weight. ".repeat(8),
        ),
      );
    }

    const maxInputTokens = 10_000;
    // Budget mirrors compactor.compactionPrefixBudget: window minus the
    // instruction reserve (800) and the 15% output reserve.
    const prefixBudget =
      maxInputTokens - 800 - Math.floor(maxInputTokens * 0.15);
    expect(estimate(messages)).toBeGreaterThan(prefixBudget);

    const { provider, lastRequest } = makeCapturingProvider(
      compactionResponse(38, "Heavy user turn body"),
    );

    // WHEN the summary call runs against that oversized history.
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens,
      force: true,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);

    // THEN the request actually sent fits within the context window.
    const sent = lastRequest();
    expect(sent).not.toBeNull();
    expect(estimate(sent ?? [])).toBeLessThan(maxInputTokens);

    // AND it opens with a marker noting the dropped leading messages so the
    // model knows the summary covers only the visible portion.
    const firstBlock = sent?.[0]?.content[0];
    const firstText = firstBlock && "text" in firstBlock ? firstBlock.text : "";
    expect(firstText).toContain(TRUNCATION_MARKER);
  });

  test("sends the full history untouched when it already fits below the budget", async () => {
    // GIVEN a small history whose estimate is well under the window — the
    // common budget-triggered compaction.
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userTurn(i, "short user turn body"));
      messages.push(assistantTurn(i, "short assistant reply body"));
    }

    const maxInputTokens = 200_000;
    const prefixBudget =
      maxInputTokens - 800 - Math.floor(maxInputTokens * 0.15);
    expect(estimate(messages)).toBeLessThan(prefixBudget);

    const { provider, lastRequest } = makeCapturingProvider(
      compactionResponse(6, "short user turn body"),
    );

    // WHEN the summary call runs against the below-budget history.
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens,
      force: true,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);

    // THEN no truncation marker is prepended and the request carries every
    // history message plus the single instruction, with the leading message
    // byte-identical to the original — keeping the prefix cache warm.
    const sent = lastRequest();
    expect(sent).not.toBeNull();
    expect(sent?.length).toBe(messages.length + 1);
    const firstBlock = sent?.[0]?.content[0];
    const firstText = firstBlock && "text" in firstBlock ? firstBlock.text : "";
    expect(firstText).not.toContain(TRUNCATION_MARKER);
    const originalFirst = messages[0]?.content[0];
    expect(firstText).toBe(
      originalFirst && "text" in originalFirst ? originalFirst.text : "",
    );
  });
});
