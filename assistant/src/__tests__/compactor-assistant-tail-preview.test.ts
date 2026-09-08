/**
 * Model-chosen `<tail_start>` can point at an assistant turn (preview of
 * assistant text, timestamp that matches no `<turn_context>`). Preview
 * matching must accept that hit and let the tool-pairing walk land on the
 * preceding clean user message, instead of aborting the compaction.
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
import type { Message, Provider } from "../providers/types.js";

function userTurn(body: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<turn_context>\ncurrent_time: 2026-05-21 (Thursday) 10:00:00 -05:00 (America/Chicago)\n</turn_context>\n${body}`,
      },
    ],
  };
}

function assistantTurn(body: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text: body }],
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

const ASSISTANT_PREVIEW =
  "Found the duplicate. Let me fix it - replace one duplicate w";

describe("runAssistantDrivenCompaction: assistant tail_start preview", () => {
  test("compacts when the model previews an assistant turn and the timestamp misses", async () => {
    const messages: Message[] = [
      userTurn("Alice: please set this up"),
      assistantTurn("Setup is done."),
      userTurn("Alice: please dedupe the list"),
      assistantTurn(
        "Found the duplicate. Let me fix it - replace one duplicate with a single entry.",
      ),
      userTurn("Alice: thanks"),
      assistantTurn("Done."),
    ];

    const provider = makeProvider(`<compaction_result>
<summary>
Alice asked to dedupe a list. Earlier setup is complete.
</summary>
<key_state>
- Dedupe in progress
</key_state>
<tail_start timestamp="1999-01-01 00:00:00" preview="${ASSISTANT_PREVIEW}" />
</compaction_result>`);

    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-test",
      messages,
      provider,
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      maxInputTokens: 100_000,
      previousEstimatedInputTokens: 90_000,
      force: true,
    });

    expect(result.reason).not.toBe("tail_start unresolved");
    expect(result.compacted).toBe(true);
    // Assistant hit at index 3 walks back to the preceding user at index 2.
    expect(result.compactedMessages).toBe(2);
    const tail = result.messages.slice(1);
    expect(tail[0]?.role).toBe("user");
    const tailText =
      tail[0] && "content" in tail[0]
        ? tail[0].content
            .filter((b) => b.type === "text")
            .map((b) => ("text" in b ? b.text : ""))
            .join("")
        : "";
    expect(tailText).toContain("please dedupe the list");
    expect(tail[1]?.role).toBe("assistant");
  });
});
