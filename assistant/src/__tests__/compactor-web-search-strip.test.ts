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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));

import {
  runAssistantDrivenCompaction,
  runEmergencyCompaction,
} from "../context/compactor.js";
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

// The emergency prompt asks for summary + key_state only — no tail_start —
// so the emergency test's canned response mirrors a prompt-following model.
const emergencyCompactionResponse = `
<compaction_result>
<summary>
Earlier turns summarized here.
</summary>

<key_state>
- Nothing critical pending.
</key_state>
</compaction_result>
`;

const ENCRYPTED_TOKEN = "expired_encrypted_token_abc123";

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

const assistantWithWebSearch = (): Message => ({
  role: "assistant",
  content: [
    {
      type: "server_tool_use",
      id: "stu_1",
      name: "web_search",
      input: { query: "cats" },
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "stu_1",
      content: [
        {
          type: "web_search_result",
          url: "https://cats.example",
          title: "All About Cats",
          encrypted_content: ENCRYPTED_TOKEN,
        },
      ],
    },
  ],
});

const assistantToolUse = (): Message => ({
  role: "assistant",
  content: [
    { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
  ],
});

const toolResult = (): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
});

function serializeBlocks(messages: Message[]): string {
  return JSON.stringify(messages);
}

// Records the exact message list the provider is asked to summarize.
function recordingProvider(
  sink: { sent: Message[] },
  response: string,
): Provider {
  return {
    name: "mock-provider",
    sendMessage: async (msgs: Message[]) => {
      sink.sent = msgs;
      return {
        content: [{ type: "text", text: response }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
}

// Expired Anthropic web-search tokens must never reach the summarization LLM:
// both compaction provider calls funnel through the same request builder, so
// each is guarded here.
describe("compaction summary calls — historical web-search sanitization", () => {
  test("runAssistantDrivenCompaction strips expired encrypted_content from the request while leaving durable history untouched", async () => {
    // GIVEN a history whose older turn contains a native web_search_tool_result
    // block carrying an opaque, expired `encrypted_content` token
    const messages: Message[] = [
      userText("old user turn"),
      assistantWithWebSearch(),
      userTextWithTurnContext("tail anchor message", TAIL_TIMESTAMP),
      assistantWithWebSearch(),
    ];

    // AND a snapshot of the caller's array so we can assert it is not mutated
    const inputSnapshot = serializeBlocks(messages);
    const sink = { sent: [] as Message[] };

    // WHEN compaction runs over that history
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-web-search",
      messages,
      provider: recordingProvider(sink, compactionResponse),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 1000,
      previousEstimatedInputTokens: 900,
    });

    // THEN the summary request the provider received carries no expired token
    // and no native web_search blocks, but keeps the search content as text
    const sentSerialized = serializeBlocks(sink.sent);
    expect(sentSerialized).not.toContain(ENCRYPTED_TOKEN);
    expect(sentSerialized).not.toContain("web_search_tool_result");
    expect(sentSerialized).not.toContain("server_tool_use");
    expect(sentSerialized).toContain("All About Cats");
    expect(sentSerialized).toContain("https://cats.example");

    // AND the caller's durable history array is left byte-for-byte untouched,
    // so persisted messages keep the original rich blocks
    expect(serializeBlocks(messages)).toBe(inputSnapshot);
    expect(result.compacted).toBe(true);
  });

  test("runEmergencyCompaction strips expired encrypted_content from the prefix request", async () => {
    // GIVEN a mid-turn history whose prefix (before the last tool pair) holds a
    // web_search_tool_result block with an expired token
    const messages: Message[] = [
      userText("old user turn"),
      assistantWithWebSearch(),
      userText("keep going"),
      assistantToolUse(),
      toolResult(),
    ];

    const inputSnapshot = serializeBlocks(messages);
    const sink = { sent: [] as Message[] };

    // WHEN emergency compaction splits at the last tool pair and summarizes the
    // prefix
    const result = await runEmergencyCompaction({
      conversationId: "conv-web-search-emergency",
      messages,
      provider: recordingProvider(sink, emergencyCompactionResponse),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      // Large budget so the prefix is not front-truncated — this test exercises
      // the web-search sanitizer, not the truncation fallback.
      maxInputTokens: 100000,
      previousEstimatedInputTokens: 90000,
    });

    // THEN the prefix sent to the provider carries no expired token
    const sentSerialized = serializeBlocks(sink.sent);
    expect(sentSerialized).not.toContain(ENCRYPTED_TOKEN);
    expect(sentSerialized).not.toContain("web_search_tool_result");
    expect(sentSerialized).not.toContain("server_tool_use");
    expect(sentSerialized).toContain("All About Cats");

    // AND the caller's durable history is untouched
    expect(serializeBlocks(messages)).toBe(inputSnapshot);
    expect(result.compacted).toBe(true);
  });
});
