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

mock.module("../memory/conversation-crud.js", () => ({
  getMessages: () => [],
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
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

function serializeBlocks(messages: Message[]): string {
  return JSON.stringify(messages);
}

describe("runAssistantDrivenCompaction — historical web-search sanitization", () => {
  test("strips expired encrypted_content from the summary request while leaving durable history untouched", async () => {
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

    // AND a provider that records the exact messages it is asked to summarize
    let sentMessages: Message[] = [];
    const provider: Provider = {
      name: "mock-provider",
      sendMessage: async (msgs: Message[]) => {
        sentMessages = msgs;
        return {
          content: [{ type: "text", text: compactionResponse }],
          model: "mock-model",
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: "end_turn",
        };
      },
    };

    // WHEN compaction runs over that history
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-web-search",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 1000,
      previousEstimatedInputTokens: 900,
    });

    // THEN the summary request the provider received carries no expired token
    // and no native web_search_tool_result block
    const sentSerialized = serializeBlocks(sentMessages);
    expect(sentSerialized).not.toContain(ENCRYPTED_TOKEN);
    expect(sentSerialized).not.toContain("web_search_tool_result");
    expect(sentSerialized).not.toContain("server_tool_use");

    // AND the search content survives as a readable text summary
    expect(sentSerialized).toContain("All About Cats");
    expect(sentSerialized).toContain("https://cats.example");

    // AND the caller's durable history array is left byte-for-byte untouched,
    // so persisted messages keep the original rich blocks
    expect(serializeBlocks(messages)).toBe(inputSnapshot);
    expect(result.compacted).toBe(true);
  });
});
