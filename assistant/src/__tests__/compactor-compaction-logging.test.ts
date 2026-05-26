/**
 * Tests that the compactor records a `compaction_logs` row at each
 * post-`provider.sendMessage` exit point — success, provider error,
 * unparseable response, tail unresolved, tail at head. No-op early
 * returns (compaction disabled, below threshold, no messages) do NOT
 * produce rows by design — they're decisions not to act.
 *
 * Modeled on `compactor-call-site-logging.test.ts` (PR 2 test).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

mock.module("../memory/conversation-crud.js", () => ({
  getMessages: () => [],
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));

// `recordRequestLog` is also called by the compactor; stub it to return
// a known id so we can assert `compaction_logs.llmRequestLogId` linkage.
let nextLogId = 0;
const recordRequestLogCalls: Array<unknown> = [];
mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: (...args: unknown[]): string => {
    recordRequestLogCalls.push(args);
    nextLogId += 1;
    return `llm-log-${nextLogId}`;
  },
}));

// Capture every call to recordCompactionLog so the per-outcome
// assertions can read the persisted row.
const recordCompactionLogCalls: Array<{
  conversationId: string;
  llmRequestLogId: string | null;
  mode: string;
  outcome: string;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  model: string | null;
  latencyMs: number;
  errorMessage: string | null;
  summaryExcerpt: string | null;
}> = [];
mock.module("../memory/compaction-log-store.js", () => ({
  recordCompactionLog: (input: (typeof recordCompactionLogCalls)[number]) => {
    recordCompactionLogCalls.push(input);
    return "compaction-log-id";
  },
}));

import {
  runAssistantDrivenCompaction,
  runEmergencyCompaction,
} from "../context/compactor.js";
import type { Message, Provider, ProviderResponse } from "../providers/types.js";

const TAIL_TIMESTAMP =
  "2026-05-21 (Thursday) 10:00:00 -05:00 (America/Chicago)";

const validCompactionResponse = `
<compaction_result>
<summary>
The earlier conversation, captured in voice.
</summary>

<key_state>
- nothing pending
</key_state>

<tail_start timestamp="${TAIL_TIMESTAMP}" preview="tail anchor message" />
</compaction_result>
`;

const unparseableResponse = "the model decided not to follow instructions";

function baseProviderResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    actualProvider: "actual-mock-provider",
    usage: { inputTokens: 100, outputTokens: 50 },
    stopReason: "end_turn",
    rawRequest: { model: "mock-model", messages: [] },
    rawResponse: { id: "resp-1" },
  };
}

function makeProvider(response: ProviderResponse): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => response,
  } as Provider;
}

function makeFailingProvider(err: Error): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => {
      throw err;
    },
  } as Provider;
}

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const userTextWithTurnContext = (text: string, timestamp: string): Message => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<turn_context>\ncurrent_time: ${timestamp}\n</turn_context>\n${text}`,
    },
  ],
});

const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function buildMessages(): Message[] {
  return [
    userText("old user turn 1"),
    assistantText("old assistant reply 1"),
    userText("old user turn 2"),
    assistantText("old assistant reply 2"),
    userTextWithTurnContext("tail anchor message", TAIL_TIMESTAMP),
    assistantText("tail assistant reply"),
  ];
}

function buildToolPairMessages(): Message[] {
  // Emergency path needs at least one user→assistant(tool_use)→user(tool_result)
  // sequence to find a split point via findLastToolPairStart.
  return [
    userText("old user 1"),
    assistantText("old assistant 1"),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "noop",
          input: {},
        },
      ],
    } as Message,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "ok",
        },
      ],
    } as Message,
  ];
}

const args = (provider: Provider) => ({
  conversationId: "conv-comp-log-1",
  messages: buildMessages(),
  provider,
  systemPrompt: "you are a test assistant",
  compaction: { enabled: true, autoThreshold: 0.7 },
  maxInputTokens: 1000,
  previousEstimatedInputTokens: 900,
});

const emergencyArgs = (provider: Provider) => ({
  conversationId: "conv-emergency-1",
  messages: buildToolPairMessages(),
  provider,
  systemPrompt: "you are a test assistant",
  compaction: { enabled: true, autoThreshold: 0.7 },
  maxInputTokens: 1000,
  previousEstimatedInputTokens: 900,
});

describe("compactor.runAssistantDrivenCompaction → compaction_logs", () => {
  beforeEach(() => {
    recordCompactionLogCalls.length = 0;
    recordRequestLogCalls.length = 0;
    nextLogId = 0;
  });

  test("persists outcome=compacted on the success path", async () => {
    await runAssistantDrivenCompaction(
      args(makeProvider(baseProviderResponse(validCompactionResponse))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("compacted");
    expect(row.mode).toBe("normal");
    expect(row.conversationId).toBe("conv-comp-log-1");
    // Linked to the llm_request_logs row that the same call produced.
    expect(row.llmRequestLogId).toBe("llm-log-1");
    expect(row.beforeMessageCount).toBe(6);
    // After compaction the live history is summary + retained-images? + tail.
    // Don't pin the exact count (depends on retained-images logic); just
    // confirm it shrank.
    expect(row.afterMessageCount).toBeLessThan(row.beforeMessageCount);
    expect(row.model).toBe("mock-model");
    expect(row.summaryInputTokens).toBe(100);
    expect(row.summaryOutputTokens).toBe(50);
    expect(row.errorMessage).toBe(null);
    expect(typeof row.summaryExcerpt).toBe("string");
    expect(row.summaryExcerpt).toContain("captured in voice");
    expect(typeof row.latencyMs).toBe("number");
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("persists outcome=provider_error when the call throws", async () => {
    await runAssistantDrivenCompaction(
      args(makeFailingProvider(new Error("rate limited"))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("provider_error");
    expect(row.mode).toBe("normal");
    expect(row.errorMessage).toBe("rate limited");
    expect(row.llmRequestLogId).toBe(null);
    expect(row.model).toBe(null);
    expect(row.summaryInputTokens).toBe(0);
    expect(row.summaryOutputTokens).toBe(0);
  });

  test("persists outcome=unparseable when the model output is invalid", async () => {
    await runAssistantDrivenCompaction(
      args(makeProvider(baseProviderResponse(unparseableResponse))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("unparseable");
    expect(row.mode).toBe("normal");
    expect(row.llmRequestLogId).toBe("llm-log-1");
    expect(row.model).toBe("mock-model");
    // Usage still attributed even on unparseable — the call cost real tokens.
    expect(row.summaryInputTokens).toBe(100);
    expect(row.summaryOutputTokens).toBe(50);
    expect(row.summaryExcerpt).toBe(null);
  });

  test("persists outcome=tail_unresolved when timestamp doesn't match", async () => {
    // Both timestamp and preview need to be unmatchable. `resolveTailStartIndex`
    // has a preview-based fallback: if no message has a matching timestamp,
    // it falls through to a message whose first text starts with the preview
    // string. Just changing the timestamp would still resolve via preview.
    const unresolvedResponse = validCompactionResponse
      .replace(TAIL_TIMESTAMP, "2099-01-01 (Friday) 00:00:00 +00:00 (UTC)")
      .replace(
        'preview="tail anchor message"',
        'preview="nonexistent message body that no live turn matches"',
      );
    await runAssistantDrivenCompaction(
      args(makeProvider(baseProviderResponse(unresolvedResponse))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("tail_unresolved");
    expect(row.mode).toBe("normal");
    expect(row.llmRequestLogId).toBe("llm-log-1");
  });

  test("does NOT persist a row when compaction is disabled (early no-op)", async () => {
    await runAssistantDrivenCompaction({
      ...args(makeProvider(baseProviderResponse(validCompactionResponse))),
      compaction: { enabled: false, autoThreshold: 0.7 },
    });
    expect(recordCompactionLogCalls.length).toBe(0);
  });

  test("does NOT persist a row when below auto threshold (early no-op)", async () => {
    await runAssistantDrivenCompaction({
      ...args(makeProvider(baseProviderResponse(validCompactionResponse))),
      previousEstimatedInputTokens: 100, // well below 700 threshold
    });
    expect(recordCompactionLogCalls.length).toBe(0);
  });
});

describe("compactor.runEmergencyCompaction → compaction_logs", () => {
  beforeEach(() => {
    recordCompactionLogCalls.length = 0;
    recordRequestLogCalls.length = 0;
    nextLogId = 0;
  });

  test("persists outcome=compacted on the success path with mode=emergency", async () => {
    await runEmergencyCompaction(
      emergencyArgs(makeProvider(baseProviderResponse(validCompactionResponse))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("compacted");
    expect(row.mode).toBe("emergency");
    expect(row.conversationId).toBe("conv-emergency-1");
    expect(row.llmRequestLogId).toBe("llm-log-1");
    expect(typeof row.summaryExcerpt).toBe("string");
  });

  test("persists outcome=provider_error on emergency provider failure", async () => {
    await runEmergencyCompaction(
      emergencyArgs(makeFailingProvider(new Error("connection refused"))),
    );

    expect(recordCompactionLogCalls.length).toBe(1);
    const row = recordCompactionLogCalls[0]!;
    expect(row.outcome).toBe("provider_error");
    expect(row.mode).toBe("emergency");
    expect(row.errorMessage).toBe("connection refused");
    expect(row.llmRequestLogId).toBe(null);
  });

  test("does NOT persist when no tool pair exists (early no-op)", async () => {
    // buildMessages has no tool_use/tool_result pair, so emergency early-exits.
    await runEmergencyCompaction({
      ...emergencyArgs(makeProvider(baseProviderResponse(validCompactionResponse))),
      messages: buildMessages(),
    });
    expect(recordCompactionLogCalls.length).toBe(0);
  });
});
