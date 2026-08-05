/**
 * The compaction summary call's front truncation must never split a
 * tool_use/tool_result pair, and the outbound request must be repaired
 * before the provider call.
 *
 * The token-budget drop loop advances one message at a time, so without a
 * boundary check its cut can drop an assistant `tool_use` while keeping its
 * user `tool_result` in the retained portion. Providers that validate
 * pairing (OpenAI Responses: "No tool call found for function call output
 * with call_id ...") reject such a request, and the retry ladder reproduces
 * the same rejection every pass. The cut must advance to a pair-safe user
 * boundary, and `buildCompactionRequest` runs the deterministic history
 * repair so even a malformed input history reaches the provider valid.
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

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import type { ContentBlock, Message, Provider } from "../providers/types.js";

const SUMMARY = "Earlier turns summarized in the assistant's own voice.";

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

/**
 * Fake provider enforcing the same pairing contract the OpenAI Responses
 * serialization is subject to: a `tool_result` may only reference a
 * `tool_use` emitted earlier in the same request (a `function_call_output`
 * with no preceding matching `function_call` is a 400). Rejects with the
 * provider's live error phrasing so a regression reproduces the real
 * failure mode.
 */
function makeValidatingProvider(response: string): {
  provider: Provider;
  lastRequest: () => Message[] | null;
} {
  let captured: Message[] | null = null;
  const provider: Provider = {
    name: "mock-provider",
    sendMessage: async (messages: Message[]) => {
      const emittedToolUseIds = new Set<string>();
      for (const msg of messages) {
        for (const block of msg.content) {
          if (msg.role === "assistant" && block.type === "tool_use") {
            emittedToolUseIds.add(block.id);
          }
          if (block.type === "tool_result") {
            // guard:allow-tool-result-only: the fake validates client-side pairing only
            const toolUseId = (block as { tool_use_id: string }).tool_use_id;
            if (!emittedToolUseIds.has(toolUseId)) {
              throw new Error(
                `No tool call found for function call output with call_id ${toolUseId}.`,
              );
            }
          }
        }
      }
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

/** Mirror of the compactor's pair-safe cut predicate for fixture guards. */
function isCleanUserBoundary(message: Message | undefined): boolean {
  return (
    message != null &&
    message.role === "user" &&
    // guard:allow-tool-result-only: mirrors the compactor's boundary predicate
    !message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Replay the token-budget drop loop without the pairing advance, to locate
 * where the raw budget cut lands for a fixture.
 */
function naiveDropCount(messages: Message[], budgetTokens: number): number {
  let dropCount = 0;
  let estimated = estimate(messages);
  while (estimated > budgetTokens && dropCount < messages.length - 1) {
    dropCount++;
    estimated = estimate(messages.slice(dropCount));
  }
  return dropCount;
}

function textOfMessage(message: Message | undefined): string {
  return (message?.content ?? [])
    .map((block) => ("text" in block ? (block.text as string) : ""))
    .join("\n");
}

function requestText(messages: Message[]): string {
  return messages.map(textOfMessage).join("\n");
}

describe("compaction summary call: pair-safe front truncation", () => {
  // Rounds of [user text, assistant tool_use (heavy), user tool_result,
  // assistant text]: the heavy tool_use messages dominate the estimate, so
  // the raw budget loop settles right after dropping one of them, landing
  // the cut on its orphaned tool_result (or the assistant text behind it),
  // never on a clean user boundary.
  function buildToolHeavyHistory(rounds: number, idPrefix: string): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < rounds; i++) {
      messages.push(userTurn(i, "please inspect the next data batch"));
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `${idPrefix}_${i}`,
            name: "inspect_batch",
            input: { payload: `batch ${i} `.repeat(600) },
          },
        ],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `${idPrefix}_${i}`,
            content: `inspection ${i} complete. `.repeat(8),
          },
        ],
      });
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `[A${i}] batch ${i} looks consistent.` },
        ],
      });
    }
    return messages;
  }

  /** tool_result blocks in `messages` with no tool_use anywhere in `messages`. */
  function orphanedResultIds(messages: Message[]): string[] {
    const toolUseIds = new Set<string>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (msg.role === "assistant" && block.type === "tool_use") {
          toolUseIds.add(block.id);
        }
      }
    }
    const orphans: string[] = [];
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          // guard:allow-tool-result-only: counting client-side orphans
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          if (!toolUseIds.has(toolUseId)) {
            orphans.push(toolUseId);
          }
        }
      }
    }
    return orphans;
  }

  // Pairing must be id-format-agnostic, so the fixture runs across both
  // persisted tool id shapes: Anthropic-style `toolu_` ids and OpenAI
  // Responses-native `call_` ids.
  for (const idPrefix of ["toolu", "call"] as const) {
    test(`advances the cut to a pair-safe boundary and succeeds against a pairing-validating provider (${idPrefix}_ ids)`, async () => {
      const rounds = 30;
      const messages = buildToolHeavyHistory(rounds, idPrefix);

      const maxInputTokens = 20_000;
      // Mirrors compactor.compactionPrefixBudget: window minus the
      // instruction reserve (800) and the 15% output reserve.
      const prefixBudget =
        maxInputTokens - 800 - Math.floor(maxInputTokens * 0.15);
      expect(estimate(messages)).toBeGreaterThan(prefixBudget);

      // Fixture guard: without the pairing advance, the budget cut lands on
      // an unsafe index and the retained tail carries a tool_result whose
      // tool_use sits in the dropped prefix (the exact shape the provider
      // rejects). If token-estimation changes ever make this land safely,
      // the fixture must be re-tuned or this test proves nothing.
      const rawCut = naiveDropCount(messages, prefixBudget);
      expect(rawCut).toBeGreaterThan(0);
      expect(isCleanUserBoundary(messages[rawCut])).toBe(false);
      expect(orphanedResultIds(messages.slice(rawCut)).length).toBeGreaterThan(
        0,
      );

      const { provider, lastRequest } = makeValidatingProvider(
        compactionResponse(rounds - 2, "please inspect the next"),
      );

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

      // The pairing-validating provider accepted the request and the pass
      // applied.
      expect(result.compacted).toBe(true);

      const sent = lastRequest();
      expect(sent).not.toBeNull();
      const sentMessages = sent ?? [];

      // Every tool_result in the outbound request is preceded by its
      // tool_use.
      expect(orphanedResultIds(sentMessages)).toEqual([]);

      // The cut itself was pair-safe: nothing needed the repair pass's
      // orphan downgrade, and the retained pairs survive intact.
      const sentText = requestText(sentMessages);
      expect(sentText).not.toContain("[orphaned");

      // The request still fits the window and announces the truncation.
      expect(estimate(sentMessages)).toBeLessThan(maxInputTokens);
      expect(sentText).toContain("summary covers only the visible portion");

      // Recent valid content is retained verbatim: the last round's user
      // turn, tool pair, and assistant reply all reach the provider.
      const lastRound = rounds - 1;
      expect(sentText).toContain(`[U${lastRound}] please inspect`);
      expect(sentText).toContain(`[A${lastRound}] batch ${lastRound}`);
      const sentToolUseIds = new Set<string>();
      for (const msg of sentMessages) {
        for (const block of msg.content) {
          if (msg.role === "assistant" && block.type === "tool_use") {
            sentToolUseIds.add(block.id);
          }
        }
      }
      expect(sentToolUseIds.has(`${idPrefix}_${lastRound}`)).toBe(true);
    });
  }

  test("repairs a malformed below-budget history before the provider call", async () => {
    // Orphan tool_result (its tool_use exists nowhere in the history) and a
    // consecutive same-role user run, below the truncation budget so the
    // request-build repair is the only transform in play.
    const messages: Message[] = [
      userTurn(0, "start the job"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_missing",
            content: "stale result payload",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "[A0] acknowledged." }],
      },
      userTurn(1, "carry on with the job"),
      {
        role: "assistant",
        content: [{ type: "text", text: "[A1] done." }],
      },
    ];

    const { provider, lastRequest } = makeValidatingProvider(
      compactionResponse(1, "carry on with the job"),
    );

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 200_000,
      force: true,
      previousEstimatedInputTokens: 90_000,
    });

    expect(result.compacted).toBe(true);

    const sentMessages = lastRequest() ?? [];
    // The orphan was downgraded to text: no tool_result blocks reach the
    // provider, and the payload is preserved in the degraded form.
    const hasToolResult = sentMessages.some((msg) =>
      // guard:allow-tool-result-only: asserting the repair removed them
      msg.content.some((block: ContentBlock) => block.type === "tool_result"),
    );
    expect(hasToolResult).toBe(false);
    const sentText = requestText(sentMessages);
    expect(sentText).toContain("stale result payload");
    expect(sentText).toContain("orphaned tool_result");

    // Same-role runs were merged: roles strictly alternate in the history
    // portion of the request (everything before the trailing instruction).
    const historyPortion = sentMessages.slice(0, -1);
    for (let i = 1; i < historyPortion.length; i++) {
      expect(historyPortion[i].role).not.toBe(historyPortion[i - 1].role);
    }

    // Valid user text survives the repair verbatim.
    expect(sentText).toContain("[U0] start the job");
    expect(sentText).toContain("[U1] carry on with the job");
  });
});
