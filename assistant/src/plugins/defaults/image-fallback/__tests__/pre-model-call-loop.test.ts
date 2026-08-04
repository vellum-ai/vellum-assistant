/**
 * End-to-end tests for capability-aware media routing at the AgentLoop wire
 * boundary: the real `pre-model-call` hook registered as a plugin, driving a
 * real `AgentLoop.run` with a recording mock provider. Covers both invocation
 * paths' shared seam (main-turn and background wakes both traverse
 * `AgentLoop.run`, which is where the hook fires):
 *
 * - vision-capable model: outbound images reach the provider untouched
 * - non-vision model with a vision profile: the provider receives captions
 *   with NO image blocks on the wire, proactively (no rejection round-trip)
 * - text-only history: untouched
 * - non-vision model, no vision profile, `memoryRetrospective` call site: the
 *   run fails observably before any provider call (retryable fail-closed)
 * - same, `mainAgent` call site: unchanged fall-through to the provider (the
 *   reactive post-model-call recovery keeps ownership)
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
} from "@vellumai/plugin-api";

import type { AgentEvent } from "../../../../agent/loop.js";
import { AgentLoop } from "../../../../agent/loop.js";
import { lastToolResultUserMessageIndex } from "../../../../context/outbound-sanitize.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../../../registry.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockProfiles: ModelProfileInfo[];
let visionProfiles: Set<string>;
let visionModelKeys: Set<string>;
let captionProviderCalls: number;

const fakeCaptionProvider = {
  name: "mock-vision-provider",
  async sendMessage() {
    captionProviderCalls++;
    return { content: [{ type: "text", text: "A bar chart of Q3 revenue." }] };
  },
};

mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (arg: ModelProfileInfo | string) =>
    typeof arg === "string"
      ? visionModelKeys.has(arg)
      : visionProfiles.has(arg.key),
  getModelProfiles: () => mockProfiles,
  resolveMediaSourceData: (source: ImageContent["source"]) =>
    source.type === "base64"
      ? { data: source.data, media_type: source.media_type }
      : null,
  getConfiguredProvider: async () => fakeCaptionProvider,
  lastToolResultUserMessageIndex,
}));

mock.module("../src/image-persist.js", () => ({
  persistImage: () => "/workspace/data/attachments/mock-hash.png",
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const preModelCall = (await import("../hooks/pre-model-call.js")).default;
const { closeCaptionStore, initCaptionStore, resetCaptionCacheForTests } =
  await import("../src/caption-cache.js");

const STORAGE_DIR = mkdtempSync(join(tmpdir(), "pre-model-call-loop-test-"));
initCaptionStore(STORAGE_DIR);

afterAll(() => {
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/** A provider that records what it was sent and answers with plain text. */
function makeRecordingProvider(): {
  provider: ConstructorParameters<typeof AgentLoop>[0]["provider"];
  calls: Message[][];
} {
  const calls: Message[][] = [];
  return {
    calls,
    provider: {
      name: "mock-main-provider",
      async sendMessage(messages: Message[]) {
        calls.push(structuredClone(messages));
        return {
          content: [{ type: "text", text: "done" }] as ContentBlock[],
          model: "mock-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    },
  };
}

function hasImageBlocks(messages: Message[]): boolean {
  return messages.some((m) =>
    m.content.some(
      (b) =>
        b.type === "image" ||
        (b.type === "tool_result" &&
          b.contentBlocks?.some((cb) => cb.type === "image")),
    ),
  );
}

interface RunCase {
  callSite?: "mainAgent" | "memoryRetrospective";
  modelProfileKey: string;
}

async function runLoop(input: Message[], opts: RunCase) {
  const { provider, calls } = makeRecordingProvider();
  const loop = new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: "conv-media-routing",
  });
  const events: AgentEvent[] = [];
  const result = await loop.run({
    requestId: "test-request",
    messages: input,
    onEvent: (e) => {
      events.push(e);
    },
    trust: { sourceChannel: "vellum", trustClass: "unknown" },
    callSite: opts.callSite ?? "mainAgent",
    modelProfileKey: opts.modelProfileKey,
  });
  return { calls, events, result };
}

beforeEach(() => {
  resetPluginRegistryForTests();
  resetCaptionCacheForTests();
  captionProviderCalls = 0;
  mockProfiles = [
    { key: "vision-profile", isDisabled: false } as ModelProfileInfo,
    { key: "text-only-profile", isDisabled: false } as ModelProfileInfo,
  ];
  visionProfiles = new Set(["vision-profile"]);
  visionModelKeys = new Set();
  registerPlugin({
    manifest: { name: "image-fallback-under-test", version: "0.0.0" },
    hooks: { "pre-model-call": preModelCall },
  });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("agent loop capability-aware media routing (image-fallback pre-model-call)", () => {
  test("vision-capable model receives outbound images untouched", async () => {
    const { calls, events } = await runLoop(
      [userMessage({ type: "text", text: "see" }, makeImage())],
      { modelProfileKey: "vision-profile" },
    );

    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(true);
    expect(captionProviderCalls).toBe(0);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  test("non-vision model with a vision profile receives captions, no image blocks, proactively", async () => {
    const { calls, result } = await runLoop(
      [userMessage({ type: "text", text: "see" }, makeImage())],
      { modelProfileKey: "text-only-profile" },
    );

    // One provider round-trip: the substitution happened before the send, not
    // via a rejection-and-retry.
    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(false);
    expect(
      calls[0][0].content.some(
        (b) => b.type === "text" && b.text.includes("[Image auto-described"),
      ),
    ).toBe(true);
    expect(captionProviderCalls).toBe(1);
    // The loop's own history keeps the raw image (wire-only substitution).
    expect(hasImageBlocks(result.history)).toBe(true);
  });

  test("text-only history reaches a non-vision model untouched", async () => {
    const input = [userMessage({ type: "text", text: "just text" })];
    const { calls } = await runLoop(structuredClone(input), {
      modelProfileKey: "text-only-profile",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0].content).toEqual(input[0].content);
    expect(captionProviderCalls).toBe(0);
  });

  test("memoryRetrospective fails closed when no vision profile can caption for a non-vision model", async () => {
    mockProfiles = [];
    visionProfiles = new Set();
    const { calls, events } = await runLoop([userMessage(makeImage())], {
      callSite: "memoryRetrospective",
      modelProfileKey: "text-only-profile",
    });

    // The provider is never called with the media-bearing request.
    expect(calls).toHaveLength(0);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== "error") {
      throw new Error("type narrowing");
    }
    expect(errorEvent.error.message).toContain("memoryRetrospective");
    expect(errorEvent.error.message).toContain("text-only-profile");
    const exitEvent = events.find((e) => e.type === "agent_loop_exit");
    if (exitEvent?.type !== "agent_loop_exit") {
      throw new Error("expected an agent_loop_exit event");
    }
    // The turn ends through the ordinary error path, which background callers
    // treat as a failed (and therefore retryable) run.
    expect(exitEvent.reason).toBe("error");
  });

  test("mainAgent with no vision profile falls through to the provider unchanged", async () => {
    mockProfiles = [];
    visionProfiles = new Set();
    const { calls, events } = await runLoop([userMessage(makeImage())], {
      callSite: "mainAgent",
      modelProfileKey: "text-only-profile",
    });

    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(true);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });
});
