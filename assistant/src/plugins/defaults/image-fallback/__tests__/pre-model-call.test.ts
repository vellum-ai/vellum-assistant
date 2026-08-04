/**
 * Unit tests for the image-fallback plugin's `pre-model-call` hook: the
 * wire-boundary guard that captions outbound images bound for a non-vision
 * model, fails the background memory call sites closed when no vision profile
 * exists to caption with, and passes everything else through untouched.
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
  PreModelCallContext,
} from "@vellumai/plugin-api";

// Real host helper wired into the mock so the tests exercise the shipped
// current-turn boundary behavior rather than a stand-in.
import { lastToolResultUserMessageIndex } from "../../../../context/outbound-sanitize.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockProfiles: ModelProfileInfo[];
let visionProfiles: Set<string>;
/** Bare-string identities (model ids / profile keys) that support vision. */
let visionModelKeys: Set<string>;
let captionProviderCalls: number;

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage() {
    captionProviderCalls++;
    return { content: [{ type: "text", text: "A bar chart of Q3 revenue." }] };
  },
};

const mockResolveMediaSourceData = (source: ImageContent["source"]) =>
  source.type === "base64"
    ? { data: source.data, media_type: source.media_type }
    : null;

mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (arg: ModelProfileInfo | string) =>
    typeof arg === "string"
      ? visionModelKeys.has(arg)
      : visionProfiles.has(arg.key),
  getModelProfiles: () => mockProfiles,
  resolveMediaSourceData: mockResolveMediaSourceData,
  getConfiguredProvider: async () => fakeProvider,
  lastToolResultUserMessageIndex,
}));

mock.module("../src/image-persist.js", () => ({
  persistImage: () => "/workspace/data/attachments/mock-hash.png",
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const preModelCall = (await import("../hooks/pre-model-call.js")).default;
const { closeCaptionStore, initCaptionStore, resetCaptionCacheForTests } =
  await import("../src/caption-cache.js");

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "pre-model-call-test-"));
initCaptionStore(STORAGE_DIR);

afterAll(() => {
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  overrides: Partial<PreModelCallContext> = {},
): PreModelCallContext {
  return {
    conversationId: "conv-pre-model-call",
    callSite: "mainAgent",
    systemPrompt: null,
    modelProfile: null,
    modelProfileKey: "text-only-profile",
    messages: [],
    deferAssistantOutput: false,
    decision: "proceed",
    failureReason: null,
    logger: noopLogger,
    broadcast: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  resetCaptionCacheForTests();
  captionProviderCalls = 0;
  mockProfiles = [
    { key: "vision-profile", isDisabled: false } as ModelProfileInfo,
    { key: "text-only-profile", isDisabled: false } as ModelProfileInfo,
  ];
  visionProfiles = new Set(["vision-profile"]);
  visionModelKeys = new Set();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback pre-model-call outbound guard", () => {
  test("leaves outbound images untouched for a vision-capable model", async () => {
    visionProfiles.add("text-only-profile");
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({ messages });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    expect(ctx.messages[0].content[0].type).toBe("image");
    expect(captionProviderCalls).toBe(0);
  });

  test("captions outbound images proactively for a non-vision model", async () => {
    const messages = [userMessage({ type: "text", text: "look" }, makeImage())];
    const ctx = makeCtx({ messages });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    const blocks = ctx.messages[0].content;
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    expect(
      blocks.some(
        (b) => b.type === "text" && b.text.includes("[Image auto-described"),
      ),
    ).toBe(true);
    expect(captionProviderCalls).toBe(1);
  });

  test("captions images nested in current-turn tool_result contentBlocks", async () => {
    const messages = [
      userMessage({
        type: "tool_result",
        tool_use_id: "tu-1",
        content: "screenshot taken",
        contentBlocks: [makeImage()],
      } as ContentBlock),
    ];
    const ctx = makeCtx({ messages });

    await preModelCall(ctx);

    const nested = (
      ctx.messages[0].content[0] as ContentBlock & {
        contentBlocks: ContentBlock[];
      }
    ).contentBlocks;
    expect(nested.some((b) => b.type === "image")).toBe(false);
    expect(nested[0].type).toBe("text");
  });

  test("reuses the caption cache: a repeated pass over the same image runs no new vision call", async () => {
    const image = makeImage();
    const first = makeCtx({ messages: [userMessage(structuredClone(image))] });
    await preModelCall(first);
    expect(captionProviderCalls).toBe(1);

    const second = makeCtx({ messages: [userMessage(structuredClone(image))] });
    await preModelCall(second);

    expect(captionProviderCalls).toBe(1);
    expect(second.messages[0].content[0].type).toBe("text");
  });

  test("text-only outbound history is untouched, even on a fail-closed call site with no vision profile", async () => {
    mockProfiles = [];
    visionProfiles = new Set();
    const messages = [userMessage({ type: "text", text: "just text" })];
    const ctx = makeCtx({ messages, callSite: "memoryRetrospective" });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    expect(ctx.messages).toEqual(messages);
    expect(captionProviderCalls).toBe(0);
  });

  test.each(["memoryRetrospective", "memoryV2Consolidation"] as const)(
    "fails %s closed when images meet a non-vision model and no vision profile exists",
    async (callSite) => {
      mockProfiles = [];
      visionProfiles = new Set();
      const messages = [userMessage(makeImage())];
      const ctx = makeCtx({ messages, callSite });

      await preModelCall(ctx);

      expect(ctx.decision).toBe("fail");
      expect(ctx.failureReason).toContain(callSite);
      expect(ctx.failureReason).toContain("text-only-profile");
      expect(ctx.failureReason).toContain("vision-capable");
      // The wire payload is not mutated; the loop never sends it.
      expect(ctx.messages[0].content[0].type).toBe("image");
      expect(captionProviderCalls).toBe(0);
    },
  );

  test("mainAgent with no vision profile falls through unchanged (reactive recovery keeps ownership)", async () => {
    mockProfiles = [];
    visionProfiles = new Set();
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({ messages, callSite: "mainAgent" });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    expect(ctx.failureReason).toBeNull();
    expect(ctx.messages[0].content[0].type).toBe("image");
  });

  test("a fail-closed call site with a vision profile captions instead of failing", async () => {
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({ messages, callSite: "memoryRetrospective" });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    expect(ctx.messages[0].content[0].type).toBe("text");
    expect(captionProviderCalls).toBe(1);
  });

  test("prefers the live per-call modelProfile override over the run-level modelProfileKey", async () => {
    // The run resolved a text-only profile, but an earlier hook rerouted the
    // call to a vision-capable profile: no captioning should run.
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({
      messages,
      modelProfile: "vision-profile",
      modelProfileKey: "text-only-profile",
    });

    await preModelCall(ctx);

    expect(ctx.messages[0].content[0].type).toBe("image");
    expect(captionProviderCalls).toBe(0);
  });

  test("a bare model id resolves through doesSupportVision when no profile matches", async () => {
    // Profileless configs carry the resolved model id as the identity.
    visionModelKeys = new Set(["gpt-6.2-vision"]);
    const messages = [userMessage(makeImage())];
    const seen = makeCtx({ messages, modelProfileKey: "gpt-6.2-vision" });
    await preModelCall(seen);
    expect(seen.messages[0].content[0].type).toBe("image");

    const textOnly = makeCtx({
      messages: [userMessage(makeImage())],
      modelProfileKey: "deepseek-v4-flash",
    });
    await preModelCall(textOnly);
    expect(textOnly.messages[0].content[0].type).toBe("text");
  });

  test("passes through when neither modelProfile nor modelProfileKey is set", async () => {
    const messages = [userMessage(makeImage())];
    const ctx = makeCtx({
      messages,
      callSite: null,
      modelProfile: null,
      modelProfileKey: null,
    });

    await preModelCall(ctx);

    expect(ctx.decision).toBe("proceed");
    expect(ctx.messages[0].content[0].type).toBe("image");
    expect(captionProviderCalls).toBe(0);
  });
});
