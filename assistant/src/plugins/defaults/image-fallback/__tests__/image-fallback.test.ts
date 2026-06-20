import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ImageContent,
  Message,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Control doesSupportVision per-profile from the test.
let visionProfiles: Set<string>;
mock.module("../../../../plugin-api/vision-support.js", () => ({
  doesSupportVision: (profile: { key: string }) =>
    visionProfiles.has(profile.key),
}));

// Control the profiles the hook sees.
type MockProfile = {
  key: string;
  label: string;
  description: string;
  isActive: boolean;
  isDisabled: boolean;
  isMix: boolean;
};
let mockProfiles: MockProfile[];
mock.module("../../../../plugin-api/model-profiles.js", () => ({
  getModelProfiles: () => mockProfiles,
}));

// Control provider resolution while keeping extractAllText real.
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
const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => (providerResolves ? fakeProvider : null),
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const userPromptSubmit = (await import("../hooks/user-prompt-submit.js"))
  .default;
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
    {
      key: "text-only",
      label: "Text Only",
      description: "",
      isActive: true,
      isDisabled: false,
      isMix: false,
    },
    {
      key: "vision-profile",
      label: "Vision",
      description: "",
      isActive: false,
      isDisabled: false,
      isMix: false,
    },
  ];
  sendMessageResponse = {
    content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
  };
  providerResolves = true;
  resetCaptionCacheForTests();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("image-fallback user-prompt-submit hook", () => {
  test("skips when isNonInteractive is true", async () => {
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages, isNonInteractive: true });
    await userPromptSubmit(ctx);
    // Image block should remain unchanged.
    expect(ctx.latestMessages[0].content[0].type).toBe("image");
  });

  test("is a no-op when the active model supports vision", async () => {
    visionProfiles = new Set(["text-only"]); // active profile supports vision
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("image");
  });

  test("replaces image blocks with captions when active model is text-only", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("[Image: A red chart showing Q3 revenue.]");
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
    expect(
      (ctx.latestMessages[0].content[1] as { text: string }).text,
    ).toContain("[Image:");
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
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("no vision-capable model");
  });

  test("uses fail-open placeholder when provider resolution returns null", async () => {
    providerResolves = false;
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("captioning failed");
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
    mock.module("../../../../providers/provider-send-message.js", () => ({
      ...realPsm,
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
    mock.module("../../../../providers/provider-send-message.js", () => ({
      ...realPsm,
      getConfiguredProvider: async () =>
        providerResolves ? fakeProvider : null,
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
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("[Image:");
    expect(ctx.latestMessages[2].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[2].content[0] as { text: string }).text,
    ).toContain("[Image:");
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
      {
        key: "text-only",
        label: "Text",
        description: "",
        isActive: true,
        isDisabled: false,
        isMix: false,
      },
      {
        key: "vision-profile",
        label: "Vision",
        description: "",
        isActive: false,
        isDisabled: true,
        isMix: false,
      },
    ];
    expect(findVisionProfile()).toBeNull();
  });

  test("returns null when no profiles support vision", () => {
    visionProfiles = new Set<string>();
    expect(findVisionProfile()).toBeNull();
  });
});
