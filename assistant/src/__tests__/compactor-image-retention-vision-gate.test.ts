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

// The gate resolves the compaction call site to an effective model and checks
// the catalog's vision flag. Pin the resolved model per test; the resolver's
// own precedence rules are covered by its own tests.
let resolvedModel = "claude-opus-4-8";
mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({ model: resolvedModel }),
  resolveDefaultProfileKey: () => null,
  resolveProfilelessModelKey: () => null,
}));

const ATTACHMENT_IMAGE_DATA = Buffer.from("retained-image-bytes");

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getMessages: () => [
    { id: "row-1", role: "user", createdAt: 1_750_000_000_000 },
  ],
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: (messageId: string) =>
    messageId === "row-1"
      ? [{ id: "att-1", kind: "image", originalFilename: "mockup.png" }]
      : [],
  getAttachmentContent: (attachmentId: string) =>
    attachmentId === "att-1" ? ATTACHMENT_IMAGE_DATA : null,
}));

// Pass the image through untouched so the assertion can match on its bytes.
mock.module("../agent/image-optimize.js", () => ({
  optimizeImageForTransport: (data: string, mediaType: string) => ({
    data,
    mediaType,
  }),
}));

import { runAssistantDrivenCompaction } from "../context/compactor.js";
import type { Message, Provider } from "../providers/types.js";

const TAIL_TIMESTAMP =
  "2026-05-21 (Thursday) 10:00:00 -05:00 (America/Chicago)";

// The model answers with a retention request for the manifest image.
const compactionResponseRetainingImage = `
<compaction_result>
<summary>
Earlier turns summarized here.
</summary>

<key_state>
- Nothing critical pending.
</key_state>

<retained_images>
<image file="mockup.png" />
</retained_images>

<tail_start timestamp="${TAIL_TIMESTAMP}" preview="tail anchor message" />
</compaction_result>
`;

const messages = (): Message[] => [
  {
    role: "user",
    content: [{ type: "text", text: "here is a mockup to work from" }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "working on it" }],
  },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: `<turn_context>\ncurrent_time: ${TAIL_TIMESTAMP}\n</turn_context>\ntail anchor message`,
      },
    ],
  },
];

function recordingProvider(sink: { sent: Message[] }): Provider {
  return {
    name: "mock-provider",
    sendMessage: async (msgs: Message[]) => {
      sink.sent = msgs;
      return {
        content: [{ type: "text", text: compactionResponseRetainingImage }],
        model: resolvedModel,
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: "end_turn",
      };
    },
  };
}

async function runCompaction(sink: { sent: Message[] }) {
  return runAssistantDrivenCompaction({
    conversationId: "conv-vision-gate",
    messages: messages(),
    provider: recordingProvider(sink),
    systemPrompt: "system",
    compaction: { enabled: true, autoThreshold: 0.7 },
    maxInputTokens: 100000,
    previousEstimatedInputTokens: 90000,
    // Guardian trust so the manifest walk sees the row without provenance
    // filtering — this test exercises the vision gate, not trust filtering.
    actorTrustClass: "guardian",
  });
}

function findImageBlocks(rebuilt: Message[]): unknown[] {
  return rebuilt.flatMap((m) => m.content.filter((b) => b.type === "image"));
}

beforeEach(() => {
  resolvedModel = "claude-opus-4-8";
});

// Retained images are re-attached to the rebuilt history as raw image blocks.
// A model the catalog marks text-only rejects the whole next request over a
// single image block, and the compacted context persists — so retention must
// be disabled for those models at both ends: the manifest offered to the
// summarizer and the hydration of whatever it asks for anyway.
describe("compaction image retention — model vision gate", () => {
  test("vision-capable model: manifest is offered and retained images are hydrated", async () => {
    const sink = { sent: [] as Message[] };
    const result = await runCompaction(sink);

    expect(result.compacted).toBe(true);
    const instruction = JSON.stringify(sink.sent.at(-1));
    expect(instruction).toContain("mockup.png");

    const imageBlocks = findImageBlocks(result.messages);
    expect(imageBlocks).toHaveLength(1);
    expect(JSON.stringify(result.messages)).toContain(
      ATTACHMENT_IMAGE_DATA.toString("base64"),
    );
  });

  test("catalog text-only model: no manifest is offered and retention requests are dropped", async () => {
    resolvedModel = "accounts/fireworks/models/glm-5p2";
    const sink = { sent: [] as Message[] };
    const result = await runCompaction(sink);

    expect(result.compacted).toBe(true);

    // The instruction tells the model retention is unavailable instead of
    // listing images.
    const instruction = JSON.stringify(sink.sent.at(-1));
    expect(instruction).not.toContain("mockup.png");
    expect(instruction).toContain("image retention unavailable");

    // Even though the model asked for the image anyway, nothing is hydrated.
    expect(findImageBlocks(result.messages)).toHaveLength(0);
    expect(JSON.stringify(result.messages)).not.toContain(
      ATTACHMENT_IMAGE_DATA.toString("base64"),
    );
  });

  test("model unknown to the catalog: retention stays enabled (fail open)", async () => {
    resolvedModel = "some-uncataloged-model";
    const sink = { sent: [] as Message[] };
    const result = await runCompaction(sink);

    expect(result.compacted).toBe(true);
    expect(JSON.stringify(sink.sent.at(-1))).toContain("mockup.png");
    expect(findImageBlocks(result.messages)).toHaveLength(1);
  });
});
