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

// Re-link controls: when `existingAttachmentIds` contains the attachment id,
// the persist path takes the "already exists" branch and calls
// `linkAttachmentToMessage`, which returns the conversation-scoped id (possibly
// cloned to a new id). `linkScopedIds` maps the source id to the scoped id the
// link returns; absent → returns the source id unchanged.
let existingAttachmentIds = new Set<string>();
let linkScopedIds: Record<string, string> = {};
const linkCalls: Array<{ attachmentId: string; position: number }> = [];

mock.module("../memory/attachments-store.js", () => ({
  attachmentExists: (id: string) => existingAttachmentIds.has(id),
  linkAttachmentToMessage: (
    _messageId: string,
    attachmentId: string,
    position: number,
  ) => {
    linkCalls.push({ attachmentId, position });
    return linkScopedIds[attachmentId] ?? attachmentId;
  },
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
    linkCalls.length = 0;
    existingAttachmentIds = new Set<string>();
    linkScopedIds = {};
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
    const rewritten = applyVisionPerceptionMarkers(ctx.messages, false);
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

  test("re-shared attachment: the scoped id replaces the source id on the in-memory block", async () => {
    // A previously-uploaded attachment ("src-att", existing in the store) is
    // re-shared into this conversation. Linking scopes it to the conversation
    // and clones it to a new id ("scoped-att"). The in-memory block — built with
    // the source id — must be re-tagged to the scoped id so a surfaced media_ref
    // resolves under the current conversation rather than the original one.
    existingAttachmentIds = new Set(["src-att"]);
    linkScopedIds = { "src-att": "scoped-att" };

    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "look again",
      attachments: [
        // Re-link: content lives on disk, so `data` is empty.
        {
          id: "src-att",
          filename: "shared.jpg",
          mimeType: "image/jpeg",
          data: "",
        },
      ],
      requestId: "req-relink",
    });

    // The link was taken via the "already exists" branch.
    expect(linkCalls).toEqual([{ attachmentId: "src-att", position: 0 }]);

    const imageBlock = ctx.messages
      .at(-1)!
      .content.find((b) => b.type === "image") as ImageContent;
    expect(imageBlock).toBeDefined();
    // The block now points at the conversation-scoped id, not the source id.
    expect(imageBlock._attachmentId).toBe("scoped-att");

    // The marker the non-vision backbone surfaces uses the scoped id.
    const rewritten = applyVisionPerceptionMarkers(ctx.messages, false);
    const marker = rewritten
      .at(-1)!
      .content.find(
        (b) => b.type === "text" && b.text.includes("media_ref="),
      ) as { type: "text"; text: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.text).toContain('media_ref="scoped-att"');
    expect(marker!.text).not.toContain('media_ref="src-att"');
  });

  test("re-shared attachment already in this conversation: id is left unchanged", async () => {
    // When linking returns the same id (the attachment already belongs to this
    // conversation, no clone), the in-memory block keeps that id.
    existingAttachmentIds = new Set(["same-att"]);
    linkScopedIds = {}; // returns the source id unchanged

    const ctx = createContext();
    await persistQueuedMessageBody(ctx, {
      content: "again",
      attachments: [
        {
          id: "same-att",
          filename: "shared.jpg",
          mimeType: "image/jpeg",
          data: "",
        },
      ],
      requestId: "req-relink-same",
    });

    const imageBlock = ctx.messages
      .at(-1)!
      .content.find((b) => b.type === "image") as ImageContent;
    expect(imageBlock._attachmentId).toBe("same-att");
  });
});
