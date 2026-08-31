/**
 * The agent loop's post-compaction history transform.
 *
 * In-place compaction rebuilds history from the stored rows, so it can
 * reintroduce content the caller had already trimmed out of the array it handed
 * to `run()`. The rebuilt array is installed and sent on the very next request
 * of the same turn, so the caller's trim has to be re-applied at the
 * installation site rather than only before the run. The loop stays
 * conversation-ignorant: the caller injects a closure, and this suite drives
 * that seam with the real camera-frame retention transform.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PostCompactContext } from "@vellumai/plugin-api";

import { AgentLoop } from "../agent/loop.js";
import type { ContextWindowConfig } from "../config/types.js";
import { stripAgedSightFrames } from "../daemon/conversation-sight-frames.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { HOOKS } from "../plugin-api/constants.js";
import {
  createContextWindowManager,
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";

const testPostCompactPlugin = {
  manifest: { name: "test-post-compact-transform", version: "0.0.0" },
  hooks: {
    [HOOKS.POST_COMPACT]: async (input: PostCompactContext): Promise<void> => {
      void input;
    },
  },
};

const CONVERSATION_ID = "compacted-history-transform-conversation";

/** Capture times one second apart, the shape the row read produces. */
const CAPTURE_TIMES = new Map<string, number>([
  ["f1", 1000],
  ["f2", 2000],
  ["f3", 3000],
  ["f4", 4000],
]);

/** A retained frame as `buildRetainedImageBlocks` rebuilds it: inline + id. */
function retainedFrame(
  attachmentId: string,
): Extract<ContentBlock, { type: "image" }> {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAAAAAA" },
    _attachmentId: attachmentId,
  };
}

/**
 * The history compaction rebuilds here: four tagged frames in one synthetic
 * message, which is two more than the retention bound allows.
 */
function compactedHistoryWithFourFrames(): Message[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "Images retained from the compacted portion:" },
        retainedFrame("f1"),
        retainedFrame("f2"),
        retainedFrame("f3"),
        retainedFrame("f4"),
      ],
    },
  ];
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

/** Records every history the provider is asked to send. */
function createRecordingProvider(requests: Message[][]): Provider {
  return {
    name: "mock",
    async sendMessage(messages: Message[]): Promise<ProviderResponse> {
      requests.push(messages);
      return textResponse("done");
    },
  };
}

/** A provider that rejects once as context-too-large, then answers. */
function createOverflowingProvider(requests: Message[][]): Provider {
  let throwOnce = true;
  return {
    name: "mock",
    async sendMessage(messages: Message[]): Promise<ProviderResponse> {
      requests.push(messages);
      if (throwOnce) {
        throwOnce = false;
        throw new ContextOverflowError("prompt too long", "mock", {
          actualTokens: 999_999,
        });
      }
      return textResponse("done after overflow recovery");
    },
  };
}

/**
 * Install a manager whose compaction returns the four-frame history, so the
 * loop installs more frames than the bound allows.
 */
function installOverfullCompactionManager(): { trust: TrustContext } {
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    config: {} as unknown as ContextWindowConfig,
    conversationId: CONVERSATION_ID,
  });
  const manager = getContextWindowManager(CONVERSATION_ID);
  if (manager) {
    const rebuild = async () => ({
      messages: compactedHistoryWithFourFrames(),
      compacted: true,
      exhausted: false,
    });
    manager.maybeCompact = rebuild as unknown as typeof manager.maybeCompact;
    manager.recoverContextOverflow =
      rebuild as unknown as typeof manager.recoverContextOverflow;
  }
  return { trust: { sourceChannel: "vellum", trustClass: "unknown" } };
}

/** Image blocks in the last history the provider was asked to send. */
function imagesInLastRequest(requests: Message[][]): ContentBlock[] {
  const last = requests.at(-1) ?? [];
  return last.flatMap((message) =>
    message.content.filter((block) => block.type === "image"),
  );
}

function frameStubsInLastRequest(requests: Message[][]): string[] {
  const last = requests.at(-1) ?? [];
  return last.flatMap((message) =>
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .filter((text) => text.startsWith("[Camera frame omitted from context:")),
  );
}

describe("AgentLoop post-compaction history transform", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager(CONVERSATION_ID);
  });

  test("trims a budget-gate compaction before the next provider call", async () => {
    const requests: Message[][] = [];
    const loop = new AgentLoop({
      provider: createRecordingProvider(requests),
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
      transformCompactedHistory: (messages) =>
        stripAgedSightFrames(messages, CAPTURE_TIMES).messages,
    });

    await loop.run({
      requestId: "req",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: () => {},
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installOverfullCompactionManager(),
    });

    // The request that went out after compaction carries the bound, not the
    // four frames compaction rebuilt.
    expect(imagesInLastRequest(requests)).toHaveLength(2);
    expect(frameStubsInLastRequest(requests)).toHaveLength(2);
    // The newest two survived.
    expect(imagesInLastRequest(requests)).toEqual([
      retainedFrame("f3"),
      retainedFrame("f4"),
    ]);
  });

  test("trims an overflow-driven compaction before the retry", async () => {
    const requests: Message[][] = [];
    const loop = new AgentLoop({
      provider: createOverflowingProvider(requests),
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
      transformCompactedHistory: (messages) =>
        stripAgedSightFrames(messages, CAPTURE_TIMES).messages,
    });
    // Blocks the budget gate so only the overflow rejection drives compaction.
    loop.compactionCircuit.lastPostCompactionEstimate = 0;

    await loop.run({
      requestId: "req",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: () => {},
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: false,
      ...installOverfullCompactionManager(),
    });

    // The overflow retry is a second provider call, and it too is bounded.
    expect(requests.length).toBeGreaterThan(1);
    expect(imagesInLastRequest(requests)).toHaveLength(2);
    expect(frameStubsInLastRequest(requests)).toHaveLength(2);
  });

  test("installs the compacted history as built when no transform is configured", async () => {
    // The workflow leaf runner builds a loop with no conversation behind it.
    const requests: Message[][] = [];
    const loop = new AgentLoop({
      provider: createRecordingProvider(requests),
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });

    await loop.run({
      requestId: "req",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: () => {},
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installOverfullCompactionManager(),
    });

    expect(imagesInLastRequest(requests)).toHaveLength(4);
    expect(frameStubsInLastRequest(requests)).toHaveLength(0);
  });

  test("keeps the compacted history when the transform throws", async () => {
    const requests: Message[][] = [];
    const loop = new AgentLoop({
      provider: createRecordingProvider(requests),
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
      transformCompactedHistory: () => {
        throw new Error("row read failed");
      },
    });

    await loop.run({
      requestId: "req",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onEvent: () => {},
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installOverfullCompactionManager(),
    });

    // The turn still completed against the untrimmed compacted history.
    expect(requests.length).toBeGreaterThan(0);
    expect(imagesInLastRequest(requests)).toHaveLength(4);
  });
});
