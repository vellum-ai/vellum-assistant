import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ImageContent,
  Message,
  ModelProfileInfo,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Control doesSupportVision per-profile from the test.
let visionProfiles: Set<string>;
let mockProfiles: ModelProfileInfo[];
let sendMessageResponse = {
  content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
};
let providerResolves = true;

const fakeProvider = {
  name: "mock-vision-provider",
  async sendMessage() {
    return sendMessageResponse;
  },
};

// Mock @vellumai/plugin-api — only the runtime handles the plugin imports.
// `extractAllText` stays real (imported from the relative path, not plugin-api).
mock.module("@vellumai/plugin-api", () => ({
  doesSupportVision: (profile: ModelProfileInfo) => visionProfiles.has(profile.key),
  getModelProfiles: () => mockProfiles,
  getConfiguredProvider: async () => (providerResolves ? fakeProvider : null),
}));

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
  visionProfiles = new Set<string>(["vision-profile"]);
  mockProfiles = [
    profile("text-only", { label: "Text Only", isActive: true }),
    profile("vision-profile", { label: "Vision" }),
  ];
  sendMessageResponse = {
    content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
  };
  providerResolves = true;
  mockPersistPath = "/workspace/data/attachments/mock-hash.png";
  resetCaptionCacheForTests();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback user-prompt-submit hook", () => {
  test("is a no-op when the active model supports vision", async () => {
    visionProfiles = new Set(["text-only"]); // active profile supports vision
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
    visionProfiles = new Set<string>(); // no vision profiles
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
    let callCount = 0;
    const trackingProvider = {
      name: "mock-vision-provider",
      async sendMessage() {
        callCount++;
        return sendMessageResponse;
      },
    };
    // Override the mock to track calls.
    mock.module("@vellumai/plugin-api", () => ({
      doesSupportVision: (p: ModelProfileInfo) => visionProfiles.has(p.key),
      getModelProfiles: () => mockProfiles,
      getConfiguredProvider: async () => trackingProvider,
    }));

    const messages1 = [imageMsg("same-data")];
    const ctx1 = makeCtx({ latestMessages: messages1 });
    await userPromptSubmit(ctx1);
    expect(callCount).toBe(1);

    // Second turn with the same image — should hit cache, no new provider call.
    const messages2 = [imageMsg("same-data")];
    const ctx2 = makeCtx({ latestMessages: messages2 });
    await userPromptSubmit(ctx2);
    expect(callCount).toBe(1); // still 1 — cache hit

    // Restore the original mock for other tests.
    mock.module("@vellumai/plugin-api", () => ({
      doesSupportVision: (p: ModelProfileInfo) => visionProfiles.has(p.key),
      getModelProfiles: () => mockProfiles,
      getConfiguredProvider: async () => (providerResolves ? fakeProvider : null),
    }));
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
  test("returns the first enabled vision-capable profile", () => {
    expect(findVisionProfile()).toBe("vision-profile");
  });

  test("skips disabled vision profiles", () => {
    mockProfiles = [
      profile("text-only", { label: "Text", isActive: true }),
      profile("vision-profile", { label: "Vision", isDisabled: true }),
    ];
    expect(findVisionProfile()).toBeNull();
  });

  test("returns null when no profiles support vision", () => {
    visionProfiles = new Set<string>();
    expect(findVisionProfile()).toBeNull();
  });

  // ── Regression: active profile must never be returned even if flagged as
  //    vision-capable, because routing the caption call back to the same
  //    model would cause the provider to reject the image. ──────────────
  test("skips the active profile even when it is flagged as vision-capable", () => {
    // Bug scenario: workspace has both profiles marked as supporting vision,
    // but only the non-active one actually does. The active profile must be
    // skipped so we never route the caption call back to the text-only model.
    visionProfiles = new Set(["text-only", "vision-profile"]);
    mockProfiles = [
      profile("text-only", { label: "Text", isActive: true }),
      profile("vision-profile", { label: "Vision" }),
    ];
    expect(findVisionProfile("text-only")).toBe("vision-profile");
  });

  test("returns null when the active profile is the only vision-capable one", () => {
    // Fail-open path: if the only "vision-capable" profile IS the active
    // profile, we must not pick it — the hook falls through to the
    // placeholder path so the image is replaced with a text marker instead
    // of being routed back to the same model.
    visionProfiles = new Set(["text-only"]);
    mockProfiles = [profile("text-only", { label: "Text", isActive: true })];
    expect(findVisionProfile("text-only")).toBeNull();
  });

  test("treats null activeProfileKey the same as omitting the argument", () => {
    // Backwards compatibility: callers that don't know the active key
    // (or where it resolves to null) still get the legacy behavior.
    expect(findVisionProfile(null)).toBe("vision-profile");
  });
});
