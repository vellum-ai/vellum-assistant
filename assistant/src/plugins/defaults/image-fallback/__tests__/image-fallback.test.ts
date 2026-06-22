import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ImageContent,
  Message,
  ModelProfileInfo,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// `let` reassignments are not visible to bun's `mock.module` closure in all
// cases (reassignment of a `let` binding snapshots the original reference
// when the module factory runs). To keep test setup simple, we mutate the
// state containers in place instead of reassigning them.
const visionProfiles = new Set<string>();
const mockProfiles: ModelProfileInfo[] = [];
const providerMap = new Map<string, string>();
let sendMessageResponse = {
  content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
};
let providerResolves = true;
let sendMessageCallCount = 0;

function makeMockProvider(providerName: string) {
  return {
    name: providerName,
    async sendMessage() {
      sendMessageCallCount++;
      return sendMessageResponse;
    },
  };
}

// Mock @vellumai/plugin-api — only the runtime handles the plugin imports.
// `extractAllText` stays real (imported from the relative path, not plugin-api).
mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (profile: ModelProfileInfo) => visionProfiles.has(profile.key),
  getModelProfiles: () => mockProfiles,
  getConfiguredProvider: async (
    _callSite: string,
    opts?: { overrideProfile?: string },
  ) => {
    if (!providerResolves) return null;
    if (opts?.overrideProfile == null) {
      // Legacy call without an override — fall back to the default provider.
      return makeMockProvider("mock-vision-provider");
    }
    const name = providerMap.get(opts.overrideProfile);
    if (name == null) return null;
    return makeMockProvider(name);
  },
}));

// Helper to reset the in-place state containers with the default values.
function resetMockState(overrides?: {
  vision?: string[];
  profiles?: ModelProfileInfo[];
  providers?: Array<[string, string]>;
}) {
  visionProfiles.clear();
  for (const v of overrides?.vision ?? ["vision-profile"]) visionProfiles.add(v);

  mockProfiles.length = 0;
  for (const p of overrides?.profiles ?? [
    profile("text-only", { label: "Text Only", isActive: true }),
    profile("vision-profile", { label: "Vision" }),
  ]) mockProfiles.push(p);

  providerMap.clear();
  for (const [k, v] of overrides?.providers ?? [
    ["text-only", "fireworks"],
    ["vision-profile", "anthropic"],
  ]) providerMap.set(k, v);
}

// Mock the image-persist module to avoid filesystem side effects in tests.
let mockPersistPath: string | null = "/workspace/data/attachments/mock-hash.png";
mock.module("../src/image-persist.js", () => ({
  persistImage: () => mockPersistPath,
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const userPromptSubmit = (await import("../hooks/user-prompt-submit.js")).default;
const { findVisionProfile } = await import("../src/vision-caption.js");
const { resetCaptionCacheForTests } = await import("../src/caption-cache.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  warnOnce() {},
};

function profile(
  key: string,
  overrides: Partial<ModelProfileInfo> = {},
): ModelProfileInfo {
  return {
    key,
    label: key,
    description: null,
    isActive: false,
    isDisabled: false,
    isMix: false,
    ...overrides,
  };
}

function imageBlock(data = "base64data"): ImageContent {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

function imageMsg(data = "base64data"): Message {
  return { role: "user", content: [imageBlock(data)] };
}

function textMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeCtx(
  overrides: Partial<UserPromptSubmitContext> = {},
): UserPromptSubmitContext {
  return {
    conversationId: "c1",
    userMessageId: "m1",
    requestId: "r1",
    modelProfileKey: "text-only",
    isNonInteractive: false,
    prompt: "What is in this image?",
    originalMessages: [],
    latestMessages: [],
    logger,
    ...overrides,
  } as unknown as UserPromptSubmitContext;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Default: active resolves to "fireworks" (text-only), vision profile
  // resolves to "anthropic" (genuinely vision-capable). Mirrors the real
  // workspace state where os-beta → fireworks and a vision profile → anthropic.
  resetMockState();
  sendMessageResponse = {
    content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
  };
  providerResolves = true;
  sendMessageCallCount = 0;
  mockPersistPath = "/workspace/data/attachments/mock-hash.png";
  resetCaptionCacheForTests();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback user-prompt-submit hook", () => {
  test("is a no-op when the active model supports vision", async () => {
    visionProfiles.clear();
    visionProfiles.add("text-only"); // active profile supports vision
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("image");
  });

  test("does not gate on isNonInteractive — captions even for background runs", async () => {
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages, isNonInteractive: true });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toContain(
      "[Image:",
    );
  });

  test("replaces image blocks with captions when active model is text-only", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toContain(
      "[Image: A red chart showing Q3 revenue.]",
    );
  });

  test("references the saved image path in the caption text", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
    expect(text).toContain("(saved to /workspace/data/attachments/");
  });

  test("works without a saved path when persist fails", async () => {
    mockPersistPath = null;
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
    expect(text).toContain("[Image: A red chart showing Q3 revenue.]");
    expect(text).not.toContain("(saved to");
  });

  test("preserves non-image blocks and captions only images", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this:" },
          imageBlock("img1"),
          { type: "text", text: "What do you see?" },
        ],
      },
    ];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toBe(
      "Look at this:",
    );
    expect(ctx.latestMessages[0].content[1].type).toBe("text");
    expect((ctx.latestMessages[0].content[1] as { text: string }).text).toContain(
      "[Image:",
    );
    expect((ctx.latestMessages[0].content[2] as { text: string }).text).toBe(
      "What do you see?",
    );
  });

  test("uses fail-open placeholder when no vision profile is configured", async () => {
    visionProfiles.clear(); // no vision profiles
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toContain(
      "no vision-capable model",
    );
  });

  test("uses fail-open placeholder when provider resolution returns null", async () => {
    providerResolves = false;
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toContain(
      "captioning failed",
    );
  });

  test("caches captions — second call with same image does not invoke provider", async () => {
    // Uses the shared `sendMessageCallCount` counter that `makeMockProvider`
    // already increments — no need to re-mock `@vellumai/plugin-api`.
    const beforeCount = sendMessageCallCount;
    const messages1 = [imageMsg("same-data")];
    const ctx1 = makeCtx({ latestMessages: messages1 });
    await userPromptSubmit(ctx1);
    expect(sendMessageCallCount).toBe(beforeCount + 1);

    // Second turn with the same image — should hit cache, no new provider call.
    const messages2 = [imageMsg("same-data")];
    const ctx2 = makeCtx({ latestMessages: messages2 });
    await userPromptSubmit(ctx2);
    expect(sendMessageCallCount).toBe(beforeCount + 1); // still 1 — cache hit
  });

  test("handles multiple images across multiple messages", async () => {
    const messages: Message[] = [
      imageMsg("img-a"),
      textMsg("and another:"),
      {
        role: "user",
        content: [imageBlock("img-b"), { type: "text", text: "both?" }],
      },
    ];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toContain(
      "[Image:",
    );
    expect(ctx.latestMessages[2].content[0].type).toBe("text");
    expect((ctx.latestMessages[2].content[0] as { text: string }).text).toContain(
      "[Image:",
    );
    expect((ctx.latestMessages[2].content[1] as { text: string }).text).toBe(
      "both?",
    );
  });

  test("resolves active profile via isActive when modelProfileKey is null", async () => {
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages, modelProfileKey: null });
    await userPromptSubmit(ctx);
    // The active profile is "text-only" (isActive: true), which doesn't support
    // vision, so images should be captioned.
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
  });
});

describe("findVisionProfile", () => {
  test("returns the first enabled vision-capable profile", async () => {
    expect(await findVisionProfile()).toBe("vision-profile");
  });

  test("skips disabled vision profiles", async () => {
    mockProfiles.length = 0;
    mockProfiles.push(
      profile("text-only", { label: "Text", isActive: true }),
      profile("vision-profile", { label: "Vision", isDisabled: true }),
    );
    expect(await findVisionProfile()).toBeNull();
  });

  test("returns null when no profiles support vision", async () => {
    visionProfiles.clear();
    expect(await findVisionProfile()).toBeNull();
  });

  // ── Regression: active profile must never be returned even if flagged as
  //    vision-capable, because routing the caption call back to the same
  //    model would cause the provider to reject the image. ──────────────
  test("skips the active profile even when it is flagged as vision-capable", async () => {
    // Bug scenario: workspace has both profiles marked as supporting vision,
    // but only the non-active one actually does. The active profile must be
    visionProfiles.clear();
    visionProfiles.add("text-only");
    visionProfiles.add("vision-profile");
    mockProfiles.length = 0;
    mockProfiles.push(
      profile("text-only", { label: "Text", isActive: true }),
      profile("vision-profile", { label: "Vision" }),
    );
    expect(await findVisionProfile("text-only")).toBe("vision-profile");
  });

  test("returns null when the active profile is the only vision-capable one", async () => {
    // Fail-open path: if the only "vision-capable" profile IS the active
    // profile, we must not pick it — the hook falls through to the
    // placeholder path so the image is replaced with a text marker instead
    // of being routed back to the same model.
    visionProfiles.clear();
    visionProfiles.add("text-only");
    mockProfiles.length = 0;
    mockProfiles.push(profile("text-only", { label: "Text", isActive: true }));
    expect(await findVisionProfile("text-only")).toBeNull();
  });

  test("treats null activeProfileKey the same as omitting the argument", async () => {
    // Backwards compatibility: callers that don't know the active key
    // (or where it resolves to null) still get the legacy behavior.
    expect(await findVisionProfile(null)).toBe("vision-profile");
  });

  // ── Regression: skip candidates whose resolved PROVIDER matches the
  //    active profile's, even when the candidate has a different key.
  //    This is the actual bug from the log: `auto` resolves to the same
  //    fireworks provider as the active `os-beta`, but doesSupportVision
  //    returns true for `auto` due to a catalog miss (vision-support.ts
  //    is fail-open: `catalogModel?.supportsVision ?? true`). ────────────
  test("skips candidates that resolve to the same provider as the active profile", async () => {
    visionProfiles.clear();
    visionProfiles.add("auto");
    visionProfiles.add("balanced");
    visionProfiles.add("quality-optimized");
    mockProfiles.length = 0;
    mockProfiles.push(
      profile("os-beta", { label: "OS Beta", isActive: true }),
      profile("auto", { label: "Auto" }),
      profile("balanced", { label: "Balanced" }),
      profile("quality-optimized", { label: "Quality" }),
    );
    // os-beta, auto, balanced all resolve to fireworks (same text-only model).
    // Only quality-optimized resolves to a different provider.
    providerMap.clear();
    providerMap.set("os-beta", "fireworks");
    providerMap.set("auto", "fireworks");
    providerMap.set("balanced", "fireworks");
    providerMap.set("quality-optimized", "anthropic");
    expect(await findVisionProfile("os-beta")).toBe("quality-optimized");
  });

  test("returns null when every vision-capable profile resolves to the active provider", async () => {
    visionProfiles.clear();
    visionProfiles.add("auto");
    visionProfiles.add("balanced");
    mockProfiles.length = 0;
    mockProfiles.push(
      profile("os-beta", { label: "OS Beta", isActive: true }),
      profile("auto", { label: "Auto" }),
      profile("balanced", { label: "Balanced" }),
    );
    providerMap.clear();
    providerMap.set("os-beta", "fireworks");
    providerMap.set("auto", "fireworks");
    providerMap.set("balanced", "fireworks");
    expect(await findVisionProfile("os-beta")).toBeNull();
  });

  test("treats resolution failure as null and does not crash", async () => {
    // If the active profile resolution throws, we should still scan
    // candidates without exploding. The fallback is "no active identity
    // to compare against" → behavior matches the no-active-key case.
    providerMap.clear(); // every resolution returns null
    expect(await findVisionProfile("text-only")).toBe("vision-profile");
  });
});
