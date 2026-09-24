/**
 * `persistUserMessage` under a processing claim its caller already holds.
 *
 * The claim stays the caller's whatever the persist answers: a duplicate or a
 * failure leaves it held, so the caller is the one place that releases it and
 * drains whatever queued behind it. A claim the persist took for itself is
 * still given back by the persist.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let insertOutcome: "insert" | "duplicate" | "throw" = "insert";

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: async () => {
    if (insertOutcome === "throw") {
      throw new Error("insert failed");
    }
    return {
      id: "row-1",
      createdAt: 100,
      deduplicated: insertOutcome === "duplicate",
    };
  },
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../persistence/attachments-store.js", () => ({
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
  AttachmentUploadError: class extends Error {},
}));

import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistUserMessage } from "../daemon/conversation-messaging.js";
import type { MessageQueue } from "../daemon/conversation-queue-manager.js";

function makeContext() {
  let processing = false;
  let owner = 0;
  const ctx: MessagingConversationContext = {
    conversationId: "conv-held-claim",
    messages: [],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    acquireProcessingFenced: async () => {
      if (processing) {
        return null;
      }
      processing = true;
      owner += 1;
      return owner;
    },
    holdsProcessingClaim: (claim: number) => processing && claim === owner,
    releaseProcessing: (claim: number) => {
      if (!processing || claim !== owner) {
        return false;
      }
      processing = false;
      return true;
    },
    abortController: null,
    queue: {} as unknown as MessageQueue,
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  };
  return ctx;
}

describe("persistUserMessage with a caller's claim", () => {
  beforeEach(() => {
    insertOutcome = "insert";
  });

  test("a duplicate leaves the claim held and the turn unarmed", async () => {
    const ctx = makeContext();
    const claim = (await ctx.acquireProcessingFenced())!;
    insertOutcome = "duplicate";

    const result = await persistUserMessage(ctx, {
      content: "hello",
      requestId: "req-1",
      processingClaim: claim,
    });

    expect(result.deduplicated).toBe(true);
    expect(ctx.holdsProcessingClaim(claim)).toBe(true);
    expect(ctx.abortController).toBeNull();
    expect(ctx.currentRequestId).toBeUndefined();
  });

  test("a failure leaves the claim held and the turn unarmed", async () => {
    const ctx = makeContext();
    const claim = (await ctx.acquireProcessingFenced())!;
    insertOutcome = "throw";

    await expect(
      persistUserMessage(ctx, {
        content: "hello",
        requestId: "req-1",
        processingClaim: claim,
      }),
    ).rejects.toThrow("insert failed");

    expect(ctx.holdsProcessingClaim(claim)).toBe(true);
    expect(ctx.abortController).toBeNull();
    expect(ctx.currentRequestId).toBeUndefined();
  });

  test("a claim the persist took for itself is still given back on a duplicate", async () => {
    const ctx = makeContext();
    insertOutcome = "duplicate";

    await persistUserMessage(ctx, { content: "hello", requestId: "req-1" });

    expect(ctx.isProcessing()).toBe(false);
  });
});
