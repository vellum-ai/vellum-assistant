/**
 * Tests for render-time enrichment of history tool calls with the in-flight
 * `ask_question` prompt read from the pending-interactions registry.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { QuestionEntry } from "../../api/events/question-request.js";
import type { ConversationMessageToolCall } from "../../api/responses/conversation-message.js";
import { clear, register } from "../pending-interactions.js";
import {
  collectPendingQuestions,
  enrichToolCallsWithQuestion,
} from "./tool-call-question-enrichment.js";

function toolCall(
  overrides: Partial<ConversationMessageToolCall>,
): ConversationMessageToolCall {
  return {
    name: "ask_question",
    input: {},
    ...overrides,
  };
}

const ENTRIES: QuestionEntry[] = [
  {
    id: "q1",
    question: "What's the email about?",
    options: [
      { id: "a", label: "iOS app is live" },
      { id: "b", label: "Open source" },
    ],
  },
];

afterEach(() => {
  clear();
});

describe("collectPendingQuestions", () => {
  test("keys question interactions by toolUseId", () => {
    // GIVEN a question interaction registered for a conversation with a
    // tool-use id and the full question entries
    register("req-1", {
      conversationId: "conv-1",
      kind: "question",
      toolUseId: "tool-abc",
      questionDetails: { entries: ENTRIES },
    });

    // WHEN we collect the conversation's pending questions
    const byToolUseId = collectPendingQuestions("conv-1");

    // THEN the interaction is keyed by its tool-use id
    expect(byToolUseId.size).toBe(1);
    expect(byToolUseId.get("tool-abc")?.requestId).toBe("req-1");
    expect(byToolUseId.get("tool-abc")?.entries).toEqual(ENTRIES);
  });

  test("ignores interactions lacking a toolUseId, details, or the question kind", () => {
    // GIVEN a question without a toolUseId, a question without details, AND a
    // non-question interaction in the same conversation
    register("req-no-tool", {
      conversationId: "conv-2",
      kind: "question",
      questionDetails: { entries: ENTRIES },
    });
    register("req-no-details", {
      conversationId: "conv-2",
      kind: "question",
      toolUseId: "tool-no-details",
    });
    register("req-confirmation", {
      conversationId: "conv-2",
      kind: "confirmation",
      toolUseId: "tool-xyz",
      confirmationDetails: {
        toolName: "file_read",
        input: {},
        riskLevel: "low",
        allowlistOptions: [],
        scopeOptions: [],
      },
    });

    // WHEN we collect the conversation's pending questions
    const byToolUseId = collectPendingQuestions("conv-2");

    // THEN none is included
    expect(byToolUseId.size).toBe(0);
  });
});

describe("enrichToolCallsWithQuestion", () => {
  test("stamps the pending question when the registry has a match", () => {
    // GIVEN a registry entry matching the tool call by id
    register("req-1", {
      conversationId: "conv-fixture",
      kind: "question",
      toolUseId: "tool-abc",
      questionDetails: { entries: ENTRIES },
    });
    const pendingQuestions = collectPendingQuestions("conv-fixture");
    const calls = [toolCall({ id: "tool-abc" })];

    // WHEN we enrich it
    const [enriched] = enrichToolCallsWithQuestion(calls, { pendingQuestions });

    // THEN the outstanding prompt is projected onto the tool call so a cold
    // reconnect can rehydrate the question card
    expect(enriched?.pendingQuestion?.requestId).toBe("req-1");
    expect(enriched?.pendingQuestion?.entries).toEqual(ENTRIES);
  });

  test("leaves tool calls without a match untouched (same reference)", () => {
    // GIVEN a tool call with no matching registry entry
    const original = toolCall({ id: "tool-unmatched" });
    register("req-other", {
      conversationId: "conv-fixture",
      kind: "question",
      toolUseId: "tool-abc",
      questionDetails: { entries: ENTRIES },
    });

    // WHEN we enrich it
    const [enriched] = enrichToolCallsWithQuestion([original], {
      pendingQuestions: collectPendingQuestions("conv-fixture"),
    });

    // THEN the tool call is returned unchanged
    expect(enriched).toBe(original);
  });

  test("returns the input array untouched when there are no pending questions", () => {
    // GIVEN tool calls and an empty registry
    const calls = [toolCall({ id: "tool-abc" })];

    // WHEN we enrich with an empty lookup
    const enriched = enrichToolCallsWithQuestion(calls, {
      pendingQuestions: new Map(),
    });

    // THEN the original array is returned
    expect(enriched).toBe(calls);
  });
});
