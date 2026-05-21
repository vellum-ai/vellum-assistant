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
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import type { Message, Provider } from "../providers/types.js";

const compactionResponse = `
<compaction_result>
<summary>
Earlier turns summarized here.
</summary>

<key_state>
- Nothing critical pending.
</key_state>

<tail_start>
<timestamp></timestamp>
<preview>tail anchor message</preview>
</tail_start>
</compaction_result>
`;

function makeProvider(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [{ type: "text", text: compactionResponse }],
      model: "mock-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
    }),
  };
}

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("runAssistantDrivenCompaction — preservedTailMessages count", () => {
  test("reflects the pre-strip tail size so the reported cut point matches the user-visible split", async () => {
    const messages: Message[] = [
      userText("old user turn 1"),
      assistantText("old assistant reply 1"),
      userText("old user turn 2"),
      userText("tail anchor message"),
      userText("<system_reminder>\nstale reminder\n</system_reminder>"),
      userText("<knowledge_base>\nstale pkb\n</knowledge_base>"),
      assistantText("most recent assistant reply"),
    ];

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider: makeProvider(),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 1000,
      previousEstimatedInputTokens: 900,
    });

    expect(result.compacted).toBe(true);
    expect(result.preservedTailMessages).toBe(4);
  });
});
