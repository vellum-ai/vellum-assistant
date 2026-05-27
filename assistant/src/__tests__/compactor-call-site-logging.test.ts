/**
 * Tests that successful compaction LLM calls land an `llm_request_logs`
 * row with `call_site = "compactionAgent"`. The compactor opts out of
 * automatic usage tracking (`usageTracking: "manual"`), so its calls
 * otherwise never reach `recordRequestLog` via the agent-loop
 * dispatcher. This test pins the explicit instrumentation in
 * `compactor.ts` so visibility doesn't silently regress.
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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));

const recordRequestLogCalls: Array<{
  conversationId: string;
  requestPayload: string;
  responsePayload: string;
  messageId: string | undefined;
  provider: string | undefined;
  callSite: string | undefined;
}> = [];

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: (
    conversationId: string,
    requestPayload: string,
    responsePayload: string,
    messageId?: string,
    provider?: string,
    callSite?: string,
  ): string => {
    recordRequestLogCalls.push({
      conversationId,
      requestPayload,
      responsePayload,
      messageId,
      provider,
      callSite,
    });
    return `mock-log-${recordRequestLogCalls.length}`;
  },
}));

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import type { Message, Provider } from "../providers/types.js";

const TAIL_TIMESTAMP =
  "2026-05-21 (Thursday) 10:00:00 -05:00 (America/Chicago)";

const compactionResponse = `
<compaction_result>
<summary>
Earlier turns summarized here.
</summary>

<key_state>
- Nothing critical pending.
</key_state>

<tail_start timestamp="${TAIL_TIMESTAMP}" preview="tail anchor message" />
</compaction_result>
`;

const RAW_REQUEST = { model: "mock-model", messages: [] };
const RAW_RESPONSE = { id: "resp-1", content: compactionResponse };

function makeProvider(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: compactionResponse }],
      model: "mock-model",
      actualProvider: "actual-mock-provider",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      rawRequest: RAW_REQUEST,
      rawResponse: RAW_RESPONSE,
    }),
  };
}

function makeProviderWithoutRaw(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: compactionResponse }],
      model: "mock-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      // rawRequest/rawResponse intentionally absent — best-effort skip path.
    }),
  };
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

const args = (provider: Provider) => ({
  conversationId: "conv-compaction-log-1",
  messages: buildMessages(),
  provider,
  systemPrompt: "you are a test assistant",
  compaction: { enabled: true, autoThreshold: 0.7 },
  maxInputTokens: 1000,
  // Above threshold so the auto-check fires.
  previousEstimatedInputTokens: 900,
});

describe("compactor records llm_request_logs with call_site=compactionAgent", () => {
  beforeEach(() => {
    recordRequestLogCalls.length = 0;
  });

  test("successful compaction call stamps call_site = compactionAgent", async () => {
    await runAssistantDrivenCompaction(args(makeProvider()));

    expect(recordRequestLogCalls.length).toBe(1);
    expect(recordRequestLogCalls[0]!.callSite).toBe("compactionAgent");
    expect(recordRequestLogCalls[0]!.conversationId).toBe(
      "conv-compaction-log-1",
    );
    // Provider name comes from actualProvider when present.
    expect(recordRequestLogCalls[0]!.provider).toBe("actual-mock-provider");
    // Payloads should be JSON-stringified.
    expect(recordRequestLogCalls[0]!.requestPayload).toBe(
      JSON.stringify(RAW_REQUEST),
    );
    expect(recordRequestLogCalls[0]!.responsePayload).toBe(
      JSON.stringify(RAW_RESPONSE),
    );
  });

  test("skips persistence when provider returns no rawRequest/rawResponse", async () => {
    await runAssistantDrivenCompaction(args(makeProviderWithoutRaw()));

    // Helper short-circuits when raw payloads are absent — non-fatal.
    expect(recordRequestLogCalls.length).toBe(0);
  });

  test("uses provider.name when actualProvider is absent", async () => {
    const provider: Provider = {
      name: "fallback-provider-name",
      sendMessage: async () => ({
        content: [{ type: "text", text: compactionResponse }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
        rawRequest: RAW_REQUEST,
        rawResponse: RAW_RESPONSE,
      }),
    };

    await runAssistantDrivenCompaction(args(provider));

    expect(recordRequestLogCalls.length).toBe(1);
    expect(recordRequestLogCalls[0]!.provider).toBe("fallback-provider-name");
    expect(recordRequestLogCalls[0]!.callSite).toBe("compactionAgent");
  });
});
