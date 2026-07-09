/**
 * Tests for the image-fallback plugin's vision-not-supported recovery: the
 * `post-model-call` hook that captions raw image blocks after a provider
 * vision rejection and retries once per turn, and the `stop` hook that clears
 * the per-conversation recovery bound.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  ImageContent,
  Message,
  ModelProfileInfo,
  PluginLogger,
  PostModelCallContext,
  StopContext,
} from "@vellumai/plugin-api";

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockProfiles: ModelProfileInfo[];
let visionProfiles: Set<string>;

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage() {
    return { content: [{ type: "text", text: "A bar chart of Q3 revenue." }] };
  },
};

const mockResolveMediaSourceData = (source: ImageContent["source"]) =>
  source.type === "base64"
    ? { data: source.data, media_type: source.media_type }
    : null;

mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (arg: ModelProfileInfo | string) =>
    typeof arg === "string" ? false : visionProfiles.has(arg.key),
  getModelProfiles: () => mockProfiles,
  resolveMediaSourceData: mockResolveMediaSourceData,
  getConfiguredProvider: async () => fakeProvider,
}));

mock.module("../src/image-persist.js", () => ({
  persistImage: () => "/workspace/data/attachments/mock-hash.png",
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const postModelCall = (await import("../hooks/post-model-call.js")).default;
const stop = (await import("../hooks/stop.js")).default;
const { resetVisionRecoveryStoreForTests, isVisionRecoveryAttempted } =
  await import("../src/recovery-state.js");
const { closeCaptionStore, initCaptionStore, resetCaptionCacheForTests } =
  await import("../src/caption-cache.js");

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "vision-recovery-test-"));
initCaptionStore(STORAGE_DIR);

afterAll(() => {
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const VISION_ERROR_MESSAGE =
  "This model (glm-5p2) doesn't support image input. Remove the image or switch to a vision-capable model.";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let imageSeq = 0;

/** A distinct inline image block per call, so the content-hash cache never collides across cases. */
function makeImage(): ImageContent {
  imageSeq += 1;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: Buffer.from(`image-bytes-${imageSeq}`).toString("base64"),
    },
  };
}

function userMessage(...blocks: ContentBlock[]): Message {
  return { role: "user", content: blocks };
}

function makeCtx(
  overrides: Partial<PostModelCallContext> = {},
): PostModelCallContext {
  return {
    conversationId: "conv-vision",
    callSite: "mainAgent",
    content: [],
    messages: [],
    stopReason: null,
    decision: "stop",
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

function makeStopCtx(): StopContext {
  return {
    conversationId: "conv-vision",
    messages: [],
    exitReason: "no_tool_calls",
    logger: noopLogger,
    broadcast: () => {},
  };
}

beforeEach(() => {
  resetVisionRecoveryStoreForTests();
  resetCaptionCacheForTests();
  mockProfiles = [
    { key: "vision-profile", isDisabled: false } as ModelProfileInfo,
  ];
  visionProfiles = new Set(["vision-profile"]);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback post-model-call vision recovery", () => {
  test("captions history images and retries on a vision-not-supported rejection", async () => {
    const messages = [
      userMessage({ type: "text", text: "look at this" }, makeImage()),
    ];
    const ctx = makeCtx({ messages, error: new Error(VISION_ERROR_MESSAGE) });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
    const blocks = ctx.messages[0].content;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const captioned = blocks.find(
      (b) => b.type === "text" && b.text.includes("[Image auto-described"),
    );
    expect(captioned).toBeDefined();
    expect(isVisionRecoveryAttempted("conv-vision")).toBe(true);
  });

  test("captions images nested in tool_result contentBlocks", async () => {
    const messages = [
      userMessage({
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "screenshot taken",
        contentBlocks: [makeImage()],
      } as ContentBlock),
    ];
    const ctx = makeCtx({ messages, error: new Error(VISION_ERROR_MESSAGE) });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("continue");
    const nested = (
      ctx.messages[0].content[0] as ContentBlock & {
        contentBlocks: ContentBlock[];
      }
    ).contentBlocks;
    expect(nested.some((b) => b.type === "image")).toBe(false);
    expect(nested[0].type).toBe("text");
  });

  test("substitutes a fail-open placeholder when no vision profile exists", async () => {
    mockProfiles = [];
    visionProfiles = new Set();
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({ messages, error: new Error(VISION_ERROR_MESSAGE) });

    await postModelCall(ctx);

    // The request must still be cleared of image input so the retry can land.
    expect(ctx.decision).toBe("continue");
    const block = ctx.messages[0].content[0];
    expect(block.type).toBe("text");
    expect((block as { text: string }).text).toContain(
      "no vision-capable model",
    );
  });

  test("recovers only once per turn", async () => {
    const first = makeCtx({
      messages: [userMessage(makeImage())],
      error: new Error(VISION_ERROR_MESSAGE),
    });
    await postModelCall(first);
    expect(first.decision).toBe("continue");

    const second = makeCtx({
      messages: [userMessage(makeImage())],
      error: new Error(VISION_ERROR_MESSAGE),
    });
    await postModelCall(second);

    expect(second.decision).toBe("stop");
    expect(second.messages[0].content[0].type).toBe("image");
  });

  test("stop hook clears the bound so the next turn recovers afresh", async () => {
    await postModelCall(
      makeCtx({
        messages: [userMessage(makeImage())],
        error: new Error(VISION_ERROR_MESSAGE),
      }),
    );
    expect(isVisionRecoveryAttempted("conv-vision")).toBe(true);

    await stop(makeStopCtx());
    expect(isVisionRecoveryAttempted("conv-vision")).toBe(false);

    const next = makeCtx({
      messages: [userMessage(makeImage())],
      error: new Error(VISION_ERROR_MESSAGE),
    });
    await postModelCall(next);
    expect(next.decision).toBe("continue");
  });

  test("does not retry when the rejection matches but history has no images", async () => {
    const ctx = makeCtx({
      messages: [userMessage({ type: "text", text: "just text" })],
      error: new Error(VISION_ERROR_MESSAGE),
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
  });

  test("ignores non-vision rejections", async () => {
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({
      messages,
      error: new Error("Provider returned error (500): upstream unavailable"),
    });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(ctx.messages[0].content[0].type).toBe("image");
    expect(isVisionRecoveryAttempted("conv-vision")).toBe(false);
  });

  test("leaves a finalized reply untouched", async () => {
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({ messages });

    await postModelCall(ctx);

    expect(ctx.decision).toBe("stop");
    expect(ctx.messages[0].content[0].type).toBe("image");
  });
});
