/**
 * Tests for the default `image-recovery` plugin's hooks.
 *
 * `post-model-call` (error-recovery):
 * - On a provider rejection carrying an image-too-large error, the hook
 *   downscales the oversized image blocks in the working history (a text note
 *   when resize is a no-op on this host), persists the same downgrade durably,
 *   and asks the loop to continue.
 * - Bounded to one pass per turn via the per-conversation recovery state: a
 *   second consecutive image rejection is left to surface; the bound clears at
 *   the turn boundary.
 * - Leaves the bound intact across a mid-turn tool-bearing turn so a later
 *   image rejection is still the exhausted second attempt.
 * - Ignores non-image errors and finalized (non-error) replies.
 *
 * `stop` (terminal cleanup):
 * - Clears the recovery bound on a terminal stop, covering the retry the loop's
 *   per-run backstop overrides — the one terminal `post-model-call` cannot
 *   resolve — so the next turn recovers afresh.
 * - Leaves the bound intact on a `"continue"` stop, where a hook is re-querying
 *   the model this turn.
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
import type {
  PluginLogger,
  PostModelCallContext,
  StopContext,
} from "../plugin-api/types.js";
import postModelCall from "../plugins/defaults/image-recovery/hooks/post-model-call.js";
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

function makePostModelCallCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-pmc",
    callSite: "mainAgent",
    content: [],
    messages: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    ...overrides,
  };
}

describe("image-recovery post-model-call hook — direct", () => {
  beforeEach(() => {
    resetImageRecoveryStoreForTests();
    resetTables();
  });

  test("recoverable image error → recovers oversized image and continues", async () => {
    // GIVEN a provider rejection carrying an image-too-large error over a
    // history with an oversized image block.
    const messages = oversizedImageHistory();
    const ctx = makePostModelCallCtx({
      messages,
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

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
    const ctx = makePostModelCallCtx({
      conversationId: conv.id,
      messages: oversizedImageHistory(),
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN the hook recovers the rejection.
    await postModelCall(ctx);

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
    const ctx = makePostModelCallCtx({
      conversationId,
      messages,
      error: new Error(IMAGE_ERROR_MESSAGE),
    });

    // WHEN a second image rejection reaches the hook.
    await postModelCall(ctx);

    // THEN it does not recover again — the error surfaces.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);

    // AND the exhausted bound is cleared so the next turn recovers afresh.
    expect(isImageRecoveryAttempted(conversationId)).toBe(false);
  });

  test("a finalized reply clears the bound so a later turn recovers again", async () => {
    // GIVEN a conversation that already attempted a recovery this turn.
    const conversationId = "conv-reset";
    markImageRecoveryAttempted(conversationId);

    // AND a finalized no-tool reply ends that turn, which the hook resolves as
    // terminal.
    await postModelCall(
      makePostModelCallCtx({
        conversationId,
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      }),
    );
    expect(isImageRecoveryAttempted(conversationId)).toBe(false);

    // WHEN a later turn hits an image-too-large rejection.
    const ctx = makePostModelCallCtx({
      conversationId,
      messages: oversizedImageHistory(),
      error: new Error(IMAGE_ERROR_MESSAGE),
    });
    await postModelCall(ctx);

    // THEN the hook recovers independently of the prior turn.
    expect(ctx.decision).toBe("continue");
  });

  test("a mid-turn tool-bearing turn keeps the bound", async () => {
    // GIVEN this turn already recovered an image rejection (bound marked), then
    // the model returns a tool-bearing turn that the loop continues mid-run.
    const conversationId = "conv-tool-turn";
    markImageRecoveryAttempted(conversationId);
    const ctx = makePostModelCallCtx({
      conversationId,
      content: [{ type: "tool_use", id: "tu_1", name: "do", input: {} }],
    });

    // WHEN the hook runs on that tool-bearing turn.
    await postModelCall(ctx);

    // THEN it leaves the bound intact, so a later image rejection in the same
    // turn is recognized as this hook's exhausted second attempt rather than a
    // fresh first one.
    expect(isImageRecoveryAttempted(conversationId)).toBe(true);
  });

  test("a non-image outcome already continuing this turn keeps the bound", async () => {
    // GIVEN this turn already recovered an image rejection (bound marked), then
    // an earlier hook (e.g. history-repair on an ordering rejection) recovered a
    // different error and set the decision to continue.
    const conversationId = "conv-cross-hook";
    markImageRecoveryAttempted(conversationId);
    const ctx = makePostModelCallCtx({
      conversationId,
      decision: "continue",
      error: new Error("messages: roles must alternate"),
    });

    // WHEN the image-recovery hook runs after that earlier hook.
    await postModelCall(ctx);

    // THEN it leaves the in-flight continue alone and keeps its bound, so a
    // later image rejection in the same turn is recognized as the exhausted
    // second attempt rather than a fresh first one. The error retry has no
    // loop-side cap, so clearing here could loop the provider call forever.
    expect(ctx.decision).toBe("continue");
    expect(isImageRecoveryAttempted(conversationId)).toBe(true);
  });

  test("non-image error is left untouched", async () => {
    // GIVEN a provider rejection that is not an image-size violation.
    const messages = oversizedImageHistory();
    const ctx = makePostModelCallCtx({
      messages,
      error: new Error("rate limit exceeded"),
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN it defers — the decision and history are unchanged.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });

  test("finalized (non-error) reply is ignored", async () => {
    // GIVEN a finalized reply — the model returned content, no error.
    const messages = oversizedImageHistory();
    const ctx = makePostModelCallCtx({
      messages,
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    });

    // WHEN the hook runs.
    await postModelCall(ctx);

    // THEN the model response is left untouched — recovery only applies to
    // image rejections.
    expect(ctx.decision).toBe("stop");
    expect(ctx.messages).toEqual(messages);
  });
});

// ─── stop hook (terminal cleanup) ────────────────────────────────────────────

describe("image-recovery stop hook — direct", () => {
  beforeEach(() => {
    resetImageRecoveryStoreForTests();
  });

  test("a terminal stop clears a bound the backstop stranded", async () => {
    // GIVEN a turn marked a recovery-retry, but the loop's per-run backstop
    // refused the continue and surfaced the rejection through the terminal stop
    // chain without re-running post-model-call — so the bound is stranded.
    const conversationId = "conv-backstop";
    markImageRecoveryAttempted(conversationId);

    // WHEN the terminal stop hook runs.
    await stop(makeStopCtx({ conversationId }));

    // THEN the stranded bound is cleared so the next turn recovers afresh.
    expect(isImageRecoveryAttempted(conversationId)).toBe(false);
  });

  test("a continuing stop keeps the bound for the in-flight retry", async () => {
    // GIVEN a turn marked a recovery-retry, and a stop hook is re-querying the
    // model this turn (decision is continue).
    const conversationId = "conv-continue";
    markImageRecoveryAttempted(conversationId);

    // WHEN the stop hook runs on that continuing stop.
    await stop(makeStopCtx({ conversationId, decision: "continue" }));

    // THEN the bound survives so a later image rejection this turn is still
    // recognized as the exhausted second attempt.
    expect(isImageRecoveryAttempted(conversationId)).toBe(true);
  });
});

describe("image-recovery post-model-call hook — via runHook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    resetImageRecoveryStoreForTests();
    resetTables();
    clearImageRecoveryAttempted("conv-pmc");
  });

  test("registering the default plugin recovers an image rejection", async () => {
    // GIVEN the default image-recovery plugin is registered.
    registerPlugin(defaultImageRecoveryPlugin);
    const messages = oversizedImageHistory();

    // WHEN the post-model-call chain runs on an image-too-large rejection.
    const result = await runHook<PostModelCallContext>(
      HOOKS.POST_MODEL_CALL,
      makePostModelCallCtx({ messages, error: new Error(IMAGE_ERROR_MESSAGE) }),
    );

    // THEN the working history is recovered (the rejected payload is gone) and
    // the loop is asked to retry.
    expect(result.decision).toBe("continue");
    expect(JSON.stringify(result.messages)).not.toContain(OVERSIZED_IMAGE_DATA);
  });
});
