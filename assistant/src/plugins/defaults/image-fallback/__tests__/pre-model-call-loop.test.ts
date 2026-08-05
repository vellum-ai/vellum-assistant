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
 *   provider receives static placeholders with NO image blocks on the wire,
 *   and the run completes (a text-only workspace keeps forming memories)
 * - same, `mainAgent` call site: the send-boundary enforcement placeholders
 *   proactively instead of burning a guaranteed provider rejection
 * - REGRESSIONS for the two hook-chain escapes: a failed/timed-out captioning
 *   hook (the pipeline discards its mutation) and a later model-router hook
 *   downgrading to a text-only profile. Both are caught by the loop's final
 *   send-boundary enforcement: raw media never reaches a text-only model.
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

// The loop's host-side send-boundary guard (`context/outbound-media-guard.ts`)
// imports these capability modules directly rather than through the
// "@vellumai/plugin-api" barrel mocked above, so the same fakes are wired at
// those specifiers too. Both layers must judge capabilities identically for
// the boundary regressions to be meaningful.
mock.module("../../../../plugin-api/model-profiles.js", () => ({
  getModelProfiles: () => mockProfiles,
}));
mock.module("../../../../plugin-api/vision-support.js", () => ({
  doesSupportVision: (arg: ModelProfileInfo | string) =>
    typeof arg === "string"
      ? visionModelKeys.has(arg)
      : visionProfiles.has(arg.key),
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

  test("memoryRetrospective gets static placeholders when no vision profile can caption for a non-vision model", async () => {
    // A failed call here would be a deterministic permanent stall for the
    // conversation's memory cursor (no retry can succeed until a vision
    // profile is configured), so the boundary substitutes the fail-open
    // placeholders and lets the pass extract the window's text.
    mockProfiles = [];
    visionProfiles = new Set();
    const { calls, events } = await runLoop([userMessage(makeImage())], {
      callSite: "memoryRetrospective",
      modelProfileKey: "text-only-profile",
    });

    // The provider is called exactly once, with no image blocks on the wire
    // and the static placeholder in their place.
    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(false);
    expect(
      calls[0].some((m) =>
        m.content.some(
          (b) =>
            b.type === "text" &&
            b.text.includes("[Image: no vision-capable model configured"),
        ),
      ),
    ).toBe(true);
    // No vision call was burned producing the placeholders.
    expect(captionProviderCalls).toBe(0);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  test("mainAgent with no vision profile gets boundary placeholders instead of a guaranteed rejection", async () => {
    // The hook itself falls through for non-memory call sites when no vision
    // profile exists, but the loop's send-boundary enforcement now keeps the
    // raw images off the wire: the provider receives static placeholders in
    // a single round trip rather than rejecting the request first and
    // relying on the reactive recovery to retry.
    mockProfiles = [];
    visionProfiles = new Set();
    const { calls, events } = await runLoop([userMessage(makeImage())], {
      callSite: "mainAgent",
      modelProfileKey: "text-only-profile",
    });

    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(false);
    expect(
      calls[0].some((m) =>
        m.content.some(
          (b) =>
            b.type === "text" &&
            b.text.includes("[Image: no vision-capable model configured"),
        ),
      ),
    ).toBe(true);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  // ── Send-boundary regressions (review blockers) ───────────────────────────

  test("REGRESSION: a failed or timed-out captioning hook cannot fail open into raw-media delivery", async () => {
    // The pipeline time-boxes each hook and contains its throws in the SAME
    // catch (`pipeline.ts`: "plugin hook failed" / timed-out hooks reject
    // through `callWithTimeout` into that catch), so timeout and throw both
    // produce the identical observable state: the hook's mutation is
    // discarded and the chain proceeds with the prior context. Register a
    // hook that dies in place of the real one to produce exactly that state
    // with a vision profile available: before the boundary enforcement, the
    // raw images sailed to the text-only provider.
    resetPluginRegistryForTests();
    registerPlugin({
      manifest: { name: "image-fallback-under-test", version: "0.0.0" },
      hooks: {
        "pre-model-call": async () => {
          throw new Error("caption sweep exceeded the hook budget");
        },
      },
    });

    const { calls, result } = await runLoop(
      [userMessage({ type: "text", text: "see" }, makeImage())],
      { modelProfileKey: "text-only-profile" },
    );

    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(false);
    expect(
      calls[0].some((m) =>
        m.content.some(
          (b) =>
            b.type === "text" &&
            b.text.includes("[Image: no vision-capable model configured"),
        ),
      ),
    ).toBe(true);
    // The boundary pass is deterministic: no captioning round-trip is burned
    // recovering from the dead hook.
    expect(captionProviderCalls).toBe(0);
    // Wire-only: the loop's own history keeps the raw image.
    expect(hasImageBlocks(result.history)).toBe(true);
  });

  test("REGRESSION: a later model-router hook downgrading to a text-only profile cannot re-expose raw media", async () => {
    // The real image-fallback hook runs first, sees a vision-capable model,
    // and passes the images through untouched. A router hook registered
    // AFTER it then reroutes the call to a text-only profile. The settled
    // chain previously sent the still-image-bearing payload to the
    // downgraded model; the send boundary must judge the FINAL profile.
    registerPlugin({
      manifest: { name: "model-router-under-test", version: "0.0.0" },
      hooks: {
        "pre-model-call": async (ctx) => {
          (ctx as { modelProfile: string | null }).modelProfile =
            "text-only-profile";
        },
      },
    });

    const { calls, result } = await runLoop(
      [userMessage({ type: "text", text: "see" }, makeImage())],
      { modelProfileKey: "vision-profile" },
    );

    expect(calls).toHaveLength(1);
    expect(hasImageBlocks(calls[0])).toBe(false);
    expect(
      calls[0].some((m) =>
        m.content.some(
          (b) =>
            b.type === "text" &&
            b.text.includes("[Image: no vision-capable model configured"),
        ),
      ),
    ).toBe(true);
    expect(captionProviderCalls).toBe(0);
    expect(hasImageBlocks(result.history)).toBe(true);
  });
});
