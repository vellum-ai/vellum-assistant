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

const OLD_SCREENSHOT_DATA = "b64-old-screenshot-bytes";
const LATEST_SCREENSHOT_DATA = "b64-latest-screenshot-bytes";
const USER_ATTACHED_IMAGE_DATA = "b64-user-attached-bytes";

const userTextWithTurnContext = (text: string, timestamp: string): Message => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<turn_context>\ncurrent_time: ${timestamp}\n</turn_context>\n${text}`,
    },
  ],
});

const assistantToolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name: "screenshot", input: {} }],
});

const toolResultWithImage = (id: string, data: string): Message => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: id,
      content: "captured",
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      ],
    },
  ],
});

const userWithAttachedImage = (): Message => ({
  role: "user",
  content: [
    { type: "text", text: "here is a mockup" },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: USER_ATTACHED_IMAGE_DATA,
      },
    },
  ],
});

function serializeBlocks(messages: Message[]): string {
  return JSON.stringify(messages);
}

// Records the exact message list the provider is asked to summarize.
function recordingProvider(sink: { sent: Message[] }): Provider {
  return {
    name: "mock-provider",
    sendMessage: async (msgs: Message[]) => {
      sink.sent = msgs;
      return {
        content: [{ type: "text", text: compactionResponse }],
        model: "mock-model",
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
}

// The summary request must carry the same media-stripped projection the agent
// loop sends on its own model calls. An unsanitized history resends every
// screenshot in the conversation; enough of them cross Anthropic's many-image
// threshold, where a stricter per-image dimension cap rejects the whole
// summary call (and trips the compaction circuit breaker).
describe("compaction summary calls — old tool-result media stripping", () => {
  test("runAssistantDrivenCompaction strips images from older tool results, keeps the latest turn's image and user-attached images, and leaves durable history untouched", async () => {
    // GIVEN a screenshot-heavy history: older tool results with images, a
    // user-attached image, and a most-recent tool result with an image
    const messages: Message[] = [
      userWithAttachedImage(),
      assistantToolUse("tu_old_1"),
      toolResultWithImage("tu_old_1", OLD_SCREENSHOT_DATA),
      userTextWithTurnContext("tail anchor message", TAIL_TIMESTAMP),
      assistantToolUse("tu_latest"),
      toolResultWithImage("tu_latest", LATEST_SCREENSHOT_DATA),
    ];

    // AND a snapshot of the caller's array so we can assert it is not mutated
    const inputSnapshot = serializeBlocks(messages);
    const sink = { sent: [] as Message[] };

    // WHEN compaction runs over that history
    const result = await runAssistantDrivenCompaction({
      conversationId: "conv-media-strip",
      messages,
      provider: recordingProvider(sink),
      systemPrompt: "system",
      compaction: { enabled: true, autoThreshold: 0.7 },
      // Large budget so the request is not front-truncated — this test
      // exercises the media-strip sanitizer, not the truncation fallback.
      maxInputTokens: 100000,
      previousEstimatedInputTokens: 90000,
    });

    // THEN older tool-result screenshots are replaced with a text marker
    const sentSerialized = serializeBlocks(sink.sent);
    expect(sentSerialized).not.toContain(OLD_SCREENSHOT_DATA);
    expect(sentSerialized).toContain("binary data removed to save context");

    // AND the most recent tool-result turn keeps its image (the model may
    // still need it), as do images the user attached directly
    expect(sentSerialized).toContain(LATEST_SCREENSHOT_DATA);
    expect(sentSerialized).toContain(USER_ATTACHED_IMAGE_DATA);

    // AND the caller's durable history array is left byte-for-byte untouched,
    // so persisted messages keep the original rich blocks
    expect(serializeBlocks(messages)).toBe(inputSnapshot);
    expect(result.compacted).toBe(true);
  });
});
