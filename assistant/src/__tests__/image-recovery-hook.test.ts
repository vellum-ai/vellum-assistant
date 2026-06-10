/**
 * Tests for the default `image-recovery` plugin's `stop` hook.
 *
 * The hook recovers from a provider image-too-large rejection (an error stop):
 * - On a recoverable rejection it downscales the oversized image blocks in the
 *   working history (a text note when resize is a no-op on this host), persists
 *   the same downgrade durably, and asks the loop to continue.
 * - Bounded to one pass per turn via the per-conversation recovery state: a
 *   second consecutive image rejection is left to surface; the bound clears at
 *   the turn boundary.
 * - Ignores non-image errors and successful (non-error) stops.
 *
 * Uses the real SQLite DB wired up via `test-preload.ts` (per-file temp
 * workspace) so the durable-persist leg exercises the same path production does.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  addMessage,
  createConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { HOOKS } from "../plugin-api/constants.js";
import type { PluginLogger, StopContext } from "../plugin-api/types.js";
import stop from "../plugins/defaults/image-recovery/hooks/stop.js";
import {
  clearImageRecoveryAttempted,
  isImageRecoveryAttempted,
  markImageRecoveryAttempted,
  resetImageRecoveryStoreForTests,
} from "../plugins/defaults/image-recovery/image-recovery-state-store.js";
import { defaultImageRecoveryPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { ContentBlock, Message } from "../providers/types.js";

initializeDb();

/** Provider rejection text matched by `isImageDimensionsTooLargeError`. */
const IMAGE_ERROR_MESSAGE =
  "At least one of the image dimensions exceed max allowed size: 8000 pixels";

const PROVIDER_MAX_IMAGE_DIMENSION = 8000;

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/**
 * Build a minimal PNG whose IHDR declares the given dimensions. Only the 8-byte
 * signature and width/height fields (read by `parseImageDimensions`) need to be
 * correct — enough for the recovery path to classify the image as over the
 * provider pixel cap. Depending on whether this host can re-encode the image,
 * recovery either downscales it or replaces it with the unsendable note; the
 * tests assert the rejected payload is gone rather than which of those landed.
 */
function makePngBase64(width: number, height: number): string {
  return Buffer.from(
    Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length (13)
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      0x08,
      0x06,
      0x00,
      0x00,
      0x00, // bit depth / color type / etc.
    ]),
  ).toString("base64");
}

function imageBlock(data: string): ContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

/** A base64 PNG whose declared dimensions exceed the provider pixel cap. */
const OVERSIZED_IMAGE_DATA = makePngBase64(
  PROVIDER_MAX_IMAGE_DIMENSION + 1000,
  6000,
);

/** A user turn carrying an image past the provider pixel cap. */
function oversizedImageHistory(): Message[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        imageBlock(OVERSIZED_IMAGE_DATA),
      ],
    },
  ];
}

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-stop",
    messages: [],
    responseContent: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    ...overrides,
  };
}

describe("image-recovery stop hook — direct", () => {
  beforeEach(() => {
    resetImageRecoveryStoreForTests();
    resetTables();
  });

  test("recoverable image error → recovers oversized image and continues", async () => {
    // GIVEN an error stop carrying an image-too-large rejection over a history
    // with an oversized image block.
    const messages = oversizedImageHistory();
    const ctx = makeStopCtx({
      messages,
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it asks the loop to retry, marks the bound, and the oversized image
    // is recovered — downscaled to a smaller image or collapsed to the
    // unsendable note, depending on whether this host can resize — so the
    // rejected payload is gone from the working history either way.
    expect(ctx.decision).toBe("continue");
    expect(isImageRecoveryAttempted(ctx.conversationId)).toBe(true);
    expect(JSON.stringify(ctx.messages)).not.toContain(OVERSIZED_IMAGE_DATA);
    // The accompanying text block is preserved — only the image is rewritten.
    expect(ctx.messages[0].content).toContainEqual({
      type: "text",
      text: "look at this",
    });
  });

  test("durably persists the downgrade so the image cannot resurface", async () => {
    // GIVEN a conversation whose stored history holds an oversized image.
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "text", text: "look at this" },
        imageBlock(OVERSIZED_IMAGE_DATA),
      ]),
      { skipIndexing: true },
    );
    const ctx = makeStopCtx({
      conversationId: conv.id,
      messages: oversizedImageHistory(),
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN the hook recovers the rejection.
    await stop(ctx);

    // THEN the stored row no longer holds the oversized payload — it was
    // rewritten (downscaled or replaced with the unsendable note) so a later
    // turn cannot rehydrate the rejected upload from the DB.
    expect(getMessages(conv.id)[0].content).not.toContain(OVERSIZED_IMAGE_DATA);
  });

  test("second consecutive image rejection is left to surface", async () => {
    // GIVEN a turn whose first image rejection already triggered a recovery.
    const conversationId = "conv-bounded";
    markImageRecoveryAttempted(conversationId);
    const messages = oversizedImageHistory();
    const ctx = makeStopCtx({
      conversationId,
      messages,
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN a second image rejection reaches the hook.
    await stop(ctx);

    // THEN it does not recover again — the error surfaces.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);

    // AND the exhausted bound is cleared so the next turn recovers afresh.
    expect(isImageRecoveryAttempted(conversationId)).toBe(false);
  });

  test("a terminal stop clears the bound so a later turn recovers again", async () => {
    // GIVEN a conversation that already attempted a recovery this turn.
    const conversationId = "conv-reset";
    markImageRecoveryAttempted(conversationId);

    // AND a successful stop ends that turn, which the hook treats as terminal.
    await stop(
      makeStopCtx({
        conversationId,
        responseContent: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      }),
    );
    expect(isImageRecoveryAttempted(conversationId)).toBe(false);

    // WHEN a later turn hits an image-too-large rejection.
    const ctx = makeStopCtx({
      conversationId,
      messages: oversizedImageHistory(),
      error: new Error(IMAGE_ERROR_MESSAGE),
    });
    await stop(ctx);

    // THEN the hook recovers independently of the prior turn.
    expect(ctx.decision).toBe("continue");
  });

  test("non-image error is left untouched", async () => {
    // GIVEN an error stop whose rejection is not an image-size violation.
    const messages = oversizedImageHistory();
    const ctx = makeStopCtx({
      messages,
      error: new Error("rate limit exceeded"),
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN it defers — the decision and history are unchanged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });

  test("successful (non-error) stop is ignored", async () => {
    // GIVEN a successful stop — the model returned a response, no error.
    const messages = oversizedImageHistory();
    const ctx = makeStopCtx({
      messages,
      responseContent: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    });

    // WHEN the hook runs.
    await stop(ctx);

    // THEN the model response is left untouched — recovery only applies to
    // image rejections.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });
});

describe("image-recovery stop hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    resetImageRecoveryStoreForTests();
    resetTables();
    clearImageRecoveryAttempted("conv-stop");
  });

  test("registering the default plugin recovers an image rejection", async () => {
    // GIVEN the default image-recovery plugin is registered.
    registerPlugin(defaultImageRecoveryPlugin);
    const messages = oversizedImageHistory();

    // WHEN the stop chain runs on an image-too-large error stop.
    const result = await runHook<StopContext>(
      HOOKS.STOP,
      makeStopCtx({ messages, error: new Error(IMAGE_ERROR_MESSAGE) }),
    );

    // THEN the working history is recovered (the rejected payload is gone) and
    // the loop is asked to retry.
    expect(result.decision).toBe("continue");
    expect(JSON.stringify(result.messages)).not.toContain(OVERSIZED_IMAGE_DATA);
  });
});
