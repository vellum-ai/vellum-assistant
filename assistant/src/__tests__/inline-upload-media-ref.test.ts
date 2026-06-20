/**
 * Codex P2 — "Preserve media refs for inline uploads".
 *
 * For an INLINE image upload (data only, no preexisting attachment id), the
 * LLM message body is built and pushed onto `ctx.messages` before the
 * attachment row exists — `attachInlineAttachmentToMessage` mints the id later
 * in the same persist call. Without a backfill, the in-memory image block never
 * carries `_attachmentId`, so for a non-vision backbone the vision-perception
 * marker rewrite finds no id and the uploaded image becomes unreachable by the
 * `vlm_*` tools (no usable `media_ref`).
 *
 * This test drives `persistQueuedMessageBody` directly (same entry point as
 * `dm-persistence.test.ts`) with a stubbed attachments store that mints a
 * deterministic id, then asserts:
 *   1. the in-memory image block is backfilled with the minted id, and
 *   2. `applyVisionPerceptionMarkers` (non-vision backbone) replaces the block
 *      with a marker whose `media_ref` is that real id.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let nextAttachmentId = 0;
const inlineAttachCalls: Array<{ messageId: string; position: number }> = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "persisted-msg" }),
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  extractImageSourcePaths: () => undefined,
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../memory/attachments-store.js", () => ({
  // No attachment exists yet — this is an inline upload, not a re-link.
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
  AttachmentUploadError: class extends Error {},
  attachInlineAttachmentToMessage: (messageId: string, position: number) => {
    inlineAttachCalls.push({ messageId, position });
    const id = `att-${nextAttachmentId++}`;
    return {
      id,
      originalFilename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      kind: "image",
      thumbnailBase64: null,
      createdAt: Date.now(),
    };
  },
}));

import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistQueuedMessageBody } from "../daemon/conversation-messaging.js";
import type { MessageQueue } from "../daemon/conversation-queue-manager.js";
import { applyVisionPerceptionMarkers } from "../plugins/defaults/vision-perception/hooks/pre-model-call.js";
import type { ImageContent, Message } from "../providers/types.js";

function createContext(): MessagingConversationContext & {
  messages: Message[];
} {
  const queueStub = {
    push: () => true,
    drain: () => [],
    size: () => 0,
  } as unknown as MessageQueue;
  let processing = false;
  return {
    conversationId: "conv-inline-test",
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: null,
    queue: queueStub,
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as MessagingConversationContext & { messages: Message[] };
}

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("Codex P2 — inline upload media_ref", () => {
  beforeEach(() => {
    nextAttachmentId = 0;
    inlineAttachCalls.length = 0;
  });

  test("backfills the minted attachment id onto the in-memory image block", async () => {
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "what is in this image?",
      attachments: [
        // Inline upload: data only, no preexisting `id`.
        { filename: "photo.jpg", mimeType: "image/jpeg", data: PNG_1x1 },
      ],
      requestId: "req-inline",
    });

    expect(inlineAttachCalls).toHaveLength(1);
    expect(inlineAttachCalls[0].position).toBe(0);

    // The in-memory message (the one the model loop reads) must now carry the
    // freshly-minted attachment id on its image block.
    const message = ctx.messages.at(-1)!;
    const imageBlock = message.content.find(
      (b) => b.type === "image",
    ) as ImageContent;
    expect(imageBlock).toBeDefined();
    expect(imageBlock._attachmentId).toBe("att-0");
  });

  test("non-vision backbone surfaces the real id as the marker media_ref", async () => {
    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "describe this",
      attachments: [
        { filename: "photo.jpg", mimeType: "image/jpeg", data: PNG_1x1 },
      ],
      requestId: "req-inline-marker",
    });

    // Simulate the outbound sanitization for a non-vision backbone.
    const rewritten = applyVisionPerceptionMarkers(ctx.messages, {
      supportsVision: false,
      supportsVideo: false,
    });
    const userMsg = rewritten.at(-1)!;
    const marker = userMsg.content.find(
      (b) => b.type === "text" && b.text.includes('media_ref="att-0"'),
    ) as { type: "text"; text: string } | undefined;

    // The raw image must be gone (no bytes to a non-vision model) and replaced
    // by a marker that names the real attachment id as the media_ref the
    // vlm_* tools can resolve.
    expect(userMsg.content.some((b) => b.type === "image")).toBe(false);
    expect(marker).toBeDefined();
    expect(marker!.text).toContain('id="att-0"');
    expect(marker!.text).toContain('media_ref="att-0"');
  });
});
