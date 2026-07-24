import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  ConversationDeletedContext,
  ImageContent,
  Message,
  ModelProfileInfo,
  PostCompactContext,
  PostToolUseContext,
  ToolResultContent,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

// The current-turn boundary is the real host helper `caption-blocks.ts`
// reaches through `@vellumai/plugin-api`; wire it into the mock so the sweep
// tests exercise the shipped scope behavior rather than a stand-in.
import { lastToolResultUserMessageIndex } from "../../../../context/outbound-sanitize.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Control doesSupportVision from the test: by profile key for the
// user-prompt-submit path (ModelProfileInfo) and by model id for the
// post-tool-use path and the vision call-site default (bare string).
let visionProfiles: Set<string>;
let visionModels: Set<string>;
let mockProfiles: ModelProfileInfo[];
// Resolved input-token price ($/1M) per profile key, controlling how
// `buildVisionCandidates` orders vision-capable profiles. A key absent from the
// map reads as unknown price (ranked after every priced candidate).
let profilePrices: Map<string, number>;
// The model the `vision` call site resolves to with no override — the shipped
// call-site default captioner — or null when the test wants no call-site
// default candidate. Its vision capability is read from `visionModels` and its
// price from `modelPricesByProvider` (keyed by the resolved provider) or, when
// absent there, from `modelPrices`.
let callSiteVisionModel: string | null;
// The provider the `vision` call site resolves to alongside `callSiteVisionModel`.
// Threaded into the provider-scoped price lookup so a multi-provider model ranks
// by its resolved provider's rate.
let callSiteVisionProvider: string;
// Resolved input-token price ($/1M) per bare model id, for pricing the
// call-site default candidate. A model absent from the map reads as unknown.
let modelPrices: Map<string, number>;
// Provider-scoped resolved input-token price ($/1M), keyed `"<provider>:<model>"`.
// Consulted before `modelPrices` so a test can price the same model id
// differently per provider (a multi-provider model).
let modelPricesByProvider: Map<string, number>;
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

// The plugin resolves an image block's bytes via `resolveMediaSourceData`.
// Media in these tests is inline base64, so mirror the real helper's base64
// branch; a workspace reference would return null (not exercised here).
const mockResolveMediaSourceData = (source: ImageContent["source"]) =>
  source.type === "base64"
    ? { data: source.data, media_type: source.media_type }
    : null;

// The `getConfiguredProvider` a mock installs. A profile candidate passes
// `{ overrideProfile, forceOverrideProfile }`; the call-site default candidate
// passes `{}`, so `opts.overrideProfile` is undefined for it.
type GetConfiguredProviderMock = (
  callSite: unknown,
  opts: { overrideProfile?: string; forceOverrideProfile?: boolean },
) => Promise<unknown>;

// Single source of truth for the mocked `@vellumai/plugin-api` surface the
// plugin imports — only the runtime handles are mocked (`extractAllText` and
// the like stay real via relative imports). Only `getConfiguredProvider`
// varies per install; every other member reads the module-level fixture state
// the tests mutate.
function pluginApiExports(getConfiguredProvider: GetConfiguredProviderMock) {
  return {
    doesSupportVision: (arg: ModelProfileInfo | string) =>
      typeof arg === "string"
        ? visionModels.has(arg)
        : visionProfiles.has(arg.key),
    getModelProfiles: () => mockProfiles,
    getProfileInputTokenPrice: (arg: ModelProfileInfo | string) => {
      const key = typeof arg === "string" ? arg : arg.key;
      return profilePrices.get(key) ?? null;
    },
    getModelInputTokenPrice: (model: string, provider?: string) => {
      if (provider != null) {
        const scoped = modelPricesByProvider.get(`${provider}:${model}`);
        if (scoped != null) {
          return scoped;
        }
      }
      return modelPrices.get(model) ?? null;
    },
    resolveCallSiteModel: () =>
      callSiteVisionModel == null
        ? null
        : { provider: callSiteVisionProvider, model: callSiteVisionModel },
    resolveMediaSourceData: mockResolveMediaSourceData,
    getConfiguredProvider,
    lastToolResultUserMessageIndex,
  };
}

// The module-load default: resolution is profile-agnostic and gated on the
// `providerResolves` flag beforeEach resets.
const defaultGetConfiguredProvider: GetConfiguredProviderMock = async () =>
  providerResolves ? fakeProvider : null;

mock.module("@vellumai/plugin-api", () =>
  pluginApiExports(defaultGetConfiguredProvider),
);

// Mock the image-persist module to avoid filesystem side effects in tests.
let mockPersistPath: string | null =
  "/workspace/data/attachments/mock-hash.png";
mock.module("../src/image-persist.js", () => ({
  persistImage: () => mockPersistPath,
}));

// ─── Imports (after mocks are registered) ───────────────────────────────────

const userPromptSubmit = (await import("../hooks/user-prompt-submit.js"))
  .default;
const postToolUse = (await import("../hooks/post-tool-use.js")).default;
const postCompact = (await import("../hooks/post-compact.js")).default;
const conversationDeleted = (await import("../hooks/conversation-deleted.js"))
  .default;
const { buildVisionCandidates } = await import("../src/vision-caption.js");
const { closeCaptionStore, initCaptionStore, resetCaptionCacheForTests } =
  await import("../src/caption-cache.js");

// Back the caption cache's durable layer with a per-file temp store, the way
// the plugin's `init` hook opens it in production.
const STORAGE_DIR = mkdtempSync(join(tmpdir(), "image-fallback-test-"));
initCaptionStore(STORAGE_DIR);

afterAll(() => {
  closeCaptionStore();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

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

function toolResult(contentBlocks?: ContentBlock[]): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: "tu1",
    content: "Took a screenshot.",
    ...(contentBlocks ? { contentBlocks } : {}),
  };
}

function makeCompactCtx(
  overrides: Partial<PostCompactContext> = {},
): PostCompactContext {
  return {
    history: [],
    requestId: "r1",
    conversationId: "c1",
    isNonInteractive: false,
    modelProfileKey: "text-only",
    logger,
    ...overrides,
  } as unknown as PostCompactContext;
}

function makeToolCtx(
  overrides: Partial<PostToolUseContext> = {},
): PostToolUseContext {
  return {
    conversationId: "c1",
    toolResponse: toolResult(),
    messages: [],
    additionalContext: null,
    model: "text-only-model",
    maxInputTokens: 100_000,
    logger,
    ...overrides,
  } as unknown as PostToolUseContext;
}

// Re-register the plugin-api mock with a caller-supplied `getConfiguredProvider`
// so a test can make provider resolution depend on the requested candidate (the
// resolver tries ranked candidates cheapest-first). Every other mocked member
// mirrors the module-load default via the shared factory.
function setPluginApiMock(getConfiguredProvider: GetConfiguredProviderMock) {
  mock.module("@vellumai/plugin-api", () =>
    pluginApiExports(getConfiguredProvider),
  );
}

// Restore the module-load default.
function restorePluginApiMock() {
  setPluginApiMock(defaultGetConfiguredProvider);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  visionProfiles = new Set<string>(["vision-profile"]);
  // "text-only-model" (the default post-tool-use ctx.model) is absent, so it
  // reads as text-only; a vision model id is added per-test.
  visionModels = new Set<string>();
  mockProfiles = [
    profile("text-only", { label: "Text Only", isActive: true }),
    profile("vision-profile", { label: "Vision" }),
  ];
  profilePrices = new Map<string, number>();
  // No call-site default candidate by default; opt in per-test.
  callSiteVisionModel = null;
  callSiteVisionProvider = "anthropic";
  modelPrices = new Map<string, number>();
  modelPricesByProvider = new Map<string, number>();
  sendMessageResponse = {
    content: [{ type: "text", text: "A red chart showing Q3 revenue." }],
  };
  providerResolves = true;
  mockPersistPath = "/workspace/data/attachments/mock-hash.png";
  resetCaptionCacheForTests();
  // Reset the plugin-api mock so a prior test's custom install can't leak.
  restorePluginApiMock();
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

  test("uses the model id fallback when no named profile exists", async () => {
    mockProfiles = [];
    const messages = [imageMsg()];
    const ctx = makeCtx({
      latestMessages: messages,
      modelProfileKey: "text-only-model",
    });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
  });

  test("leaves images alone when the profileless model id supports vision", async () => {
    mockProfiles = [];
    visionModels = new Set(["vision-model"]);
    const messages = [imageMsg()];
    const ctx = makeCtx({
      latestMessages: messages,
      modelProfileKey: "vision-model",
    });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("image");
  });

  test("does not gate on isNonInteractive — captions even for background runs", async () => {
    const messages = [imageMsg()];
    const ctx = makeCtx({ latestMessages: messages, isNonInteractive: true });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("[Image auto-described");
  });

  test("replaces image blocks with captions when active model is text-only", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect((ctx.latestMessages[0].content[0] as { text: string }).text).toBe(
      "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
    );
  });

  test("caption states the model can't view images and the text is derived", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
    expect(text).toContain("text-only model");
    expect(text).toContain("auto-described");
  });

  test("does not embed the saved image path in the caption text", async () => {
    const messages = [imageMsg("img1")];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
    expect(text).not.toContain("saved to");
    expect(text).not.toContain("/workspace/data/attachments/");
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
    ).toContain("[Image auto-described");
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
    ).toContain("auto-description failed");
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
    setPluginApiMock(async () => trackingProvider);

    const messages1 = [imageMsg("same-data")];
    const ctx1 = makeCtx({ latestMessages: messages1 });
    await userPromptSubmit(ctx1);
    expect(callCount).toBe(1);

    // Second turn with the same image — should hit cache, no new provider call.
    const messages2 = [imageMsg("same-data")];
    const ctx2 = makeCtx({ latestMessages: messages2 });
    await userPromptSubmit(ctx2);
    expect(callCount).toBe(1); // still 1 — cache hit
  });

  test("captions images nested in a historical tool_result's contentBlocks", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [toolResult([imageBlock("nested-shot")])],
      },
    ];
    const ctx = makeCtx({ latestMessages: messages });
    await userPromptSubmit(ctx);
    const result = ctx.latestMessages[0].content[0] as ToolResultContent;
    expect(result.type).toBe("tool_result");
    expect(result.contentBlocks![0].type).toBe("text");
    expect((result.contentBlocks![0] as { text: string }).text).toContain(
      "[Image auto-described",
    );
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
    ).toContain("[Image auto-described");
    expect(ctx.latestMessages[2].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[2].content[0] as { text: string }).text,
    ).toContain("[Image auto-described");
    expect((ctx.latestMessages[2].content[1] as { text: string }).text).toBe(
      "both?",
    );
  });
});

// The ranked candidates' `overrideProfile` values: a profile key per profile
// candidate, or `null` for the `vision` call-site default candidate. beforeEach
// leaves `callSiteVisionModel` null, so a test opts into the call-site default
// candidate by setting it (plus its vision flag and price).
function rankedOverrides(): Array<string | null> {
  return buildVisionCandidates().map((c) => c.overrideProfile);
}

describe("buildVisionCandidates", () => {
  test("returns the enabled vision-capable profile", () => {
    expect(rankedOverrides()).toEqual(["vision-profile"]);
  });

  test("skips disabled vision profiles", () => {
    mockProfiles = [
      profile("text-only", { label: "Text", isActive: true }),
      profile("vision-profile", { label: "Vision", isDisabled: true }),
    ];
    expect(rankedOverrides()).toEqual([]);
  });

  test("returns an empty list when nothing can caption", () => {
    visionProfiles = new Set<string>();
    expect(rankedOverrides()).toEqual([]);
  });

  test("returns the sole vision profile", () => {
    mockProfiles = [
      profile("text-only", { label: "Text", isActive: true }),
      profile("only-vision", { label: "Vision" }),
    ];
    visionProfiles = new Set(["only-vision"]);
    profilePrices = new Map<string, number>();
    expect(rankedOverrides()).toEqual(["only-vision"]);
  });

  test("orders vision-capable profiles cheapest first", () => {
    mockProfiles = [
      profile("premium-vision", { label: "Premium" }),
      profile("cheap-vision", { label: "Cheap" }),
      profile("mid-vision", { label: "Mid" }),
    ];
    visionProfiles = new Set(["premium-vision", "cheap-vision", "mid-vision"]);
    profilePrices = new Map<string, number>([
      ["premium-vision", 15],
      ["cheap-vision", 0.8],
      ["mid-vision", 3],
    ]);
    expect(rankedOverrides()).toEqual([
      "cheap-vision",
      "mid-vision",
      "premium-vision",
    ]);
  });

  test("ranks unknown-price vision profiles after priced ones", () => {
    mockProfiles = [
      profile("unknown-first", { label: "Unknown First" }),
      profile("priced", { label: "Priced" }),
      profile("unknown-last", { label: "Unknown Last" }),
    ];
    visionProfiles = new Set(["unknown-first", "priced", "unknown-last"]);
    // Only "priced" has a known price; it leads, then the unknowns keep picker
    // order behind it even though one precedes it in picker order.
    profilePrices = new Map<string, number>([["priced", 9]]);
    expect(rankedOverrides()).toEqual([
      "priced",
      "unknown-first",
      "unknown-last",
    ]);
  });

  test("keeps picker order among unknown-price vision profiles", () => {
    mockProfiles = [
      profile("first-vision", { label: "First" }),
      profile("second-vision", { label: "Second" }),
    ];
    visionProfiles = new Set(["first-vision", "second-vision"]);
    // Every profile is unknown-price, so picker order is preserved.
    profilePrices = new Map<string, number>();
    expect(rankedOverrides()).toEqual(["first-vision", "second-vision"]);
  });

  test("keeps picker order among equally-priced vision profiles", () => {
    mockProfiles = [
      profile("vision-a", { label: "A" }),
      profile("vision-b", { label: "B" }),
    ];
    visionProfiles = new Set(["vision-a", "vision-b"]);
    profilePrices = new Map<string, number>([
      ["vision-a", 2],
      ["vision-b", 2],
    ]);
    expect(rankedOverrides()).toEqual(["vision-a", "vision-b"]);
  });

  test("never includes a disabled or non-vision profile even when cheaper", () => {
    mockProfiles = [
      profile("cheap-disabled-vision", {
        label: "Cheap Disabled",
        isDisabled: true,
      }),
      profile("cheap-text-only", { label: "Cheap Text" }),
      profile("enabled-vision", { label: "Enabled Vision" }),
    ];
    // Only "enabled-vision" is both enabled and vision-capable.
    visionProfiles = new Set(["cheap-disabled-vision", "enabled-vision"]);
    profilePrices = new Map<string, number>([
      ["cheap-disabled-vision", 0.1],
      ["cheap-text-only", 0.2],
      ["enabled-vision", 20],
    ]);
    expect(rankedOverrides()).toEqual(["enabled-vision"]);
  });

  test("includes the vision call-site default, priced by its resolved model", () => {
    // The managed default: the sole vision PROFILE is the $10 quality profile;
    // the vision call-site default resolves to a $1 model, the cheaper captioner.
    mockProfiles = [profile("quality-optimized", { label: "Quality" })];
    visionProfiles = new Set(["quality-optimized"]);
    profilePrices = new Map<string, number>([["quality-optimized", 10]]);
    callSiteVisionModel = "haiku-model";
    visionModels = new Set(["haiku-model"]);
    modelPrices = new Map<string, number>([["haiku-model", 1]]);
    // `null` (the call-site default) leads the pricier profile.
    expect(rankedOverrides()).toEqual([null, "quality-optimized"]);
  });

  test("excludes the call-site default when its resolved model is text-only", () => {
    // A workspace `llm.callSites.vision` override resolves the call site to a
    // cheaper text-only model — it must be excluded, not ranked then fail.
    mockProfiles = [profile("vision-profile", { label: "Vision" })];
    visionProfiles = new Set(["vision-profile"]);
    profilePrices = new Map<string, number>([["vision-profile", 12]]);
    callSiteVisionModel = "text-router";
    visionModels = new Set<string>(); // resolved model is text-only
    modelPrices = new Map<string, number>([["text-router", 0.1]]); // ineligible
    expect(rankedOverrides()).toEqual(["vision-profile"]);
  });

  test("excludes the call-site default when the call site resolves to no model", () => {
    callSiteVisionModel = null;
    mockProfiles = [profile("vision-profile", { label: "Vision" })];
    visionProfiles = new Set(["vision-profile"]);
    expect(rankedOverrides()).toEqual(["vision-profile"]);
  });

  test("ranks the call-site default among profiles by price", () => {
    mockProfiles = [
      profile("cheapest-vision", { label: "Cheapest" }),
      profile("premium-vision", { label: "Premium" }),
    ];
    visionProfiles = new Set(["cheapest-vision", "premium-vision"]);
    profilePrices = new Map<string, number>([
      ["cheapest-vision", 0.8],
      ["premium-vision", 15],
    ]);
    callSiteVisionModel = "haiku-model";
    visionModels = new Set(["haiku-model"]);
    modelPrices = new Map<string, number>([["haiku-model", 5]]);
    // $0.8 profile, then the $5 call-site default, then the $15 profile.
    expect(rankedOverrides()).toEqual([
      "cheapest-vision",
      null,
      "premium-vision",
    ]);
  });

  test("ranks the call-site default before an equal-priced profile", () => {
    mockProfiles = [profile("tied-vision", { label: "Tied" })];
    visionProfiles = new Set(["tied-vision"]);
    profilePrices = new Map<string, number>([["tied-vision", 5]]);
    callSiteVisionModel = "haiku-model";
    visionModels = new Set(["haiku-model"]);
    modelPrices = new Map<string, number>([["haiku-model", 5]]);
    // Equal price: the call-site default leads on assembly order.
    expect(rankedOverrides()).toEqual([null, "tied-vision"]);
  });

  test("prices the call-site default by its resolved provider, flipping the rank for a multi-provider model", () => {
    // A `vision` override resolves to a model two providers offer at different
    // rates ($0.60 vs $0.95). The model-id-only rate ($0.60) would always rank
    // the default ahead of the $0.80 profile — but the default must rank by the
    // rate of the provider it actually resolves to.
    mockProfiles = [profile("mid-vision", { label: "Mid" })];
    visionProfiles = new Set(["mid-vision"]);
    profilePrices = new Map<string, number>([["mid-vision", 0.8]]);
    callSiteVisionModel = "multi-provider-model";
    visionModels = new Set(["multi-provider-model"]);
    // Model-id-only rate (the misleading cheap one) plus per-provider rates.
    modelPrices = new Map<string, number>([["multi-provider-model", 0.6]]);
    modelPricesByProvider = new Map<string, number>([
      ["openrouter:multi-provider-model", 0.6],
      ["vercel-ai-gateway:multi-provider-model", 0.95],
    ]);

    // Cheaper provider ($0.60 < $0.80): the call-site default leads.
    callSiteVisionProvider = "openrouter";
    expect(rankedOverrides()).toEqual([null, "mid-vision"]);

    // Pricier provider ($0.95 > $0.80): the same model id now ranks behind the
    // profile — the resolved provider's rate, not the model-id-only rate, wins.
    callSiteVisionProvider = "vercel-ai-gateway";
    expect(rankedOverrides()).toEqual(["mid-vision", null]);
  });
});

describe("vision provider resilience", () => {
  // Two ranked vision profiles: "cheap-vision" (0.8) leads "premium-vision" (15).
  function twoRankedVisionProfiles() {
    mockProfiles = [
      profile("premium-vision", { label: "Premium" }),
      profile("cheap-vision", { label: "Cheap" }),
    ];
    visionProfiles = new Set(["premium-vision", "cheap-vision"]);
    profilePrices = new Map<string, number>([
      ["premium-vision", 15],
      ["cheap-vision", 0.8],
    ]);
  }

  test("captions via the next-cheapest profile when the cheapest can't resolve", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    let ranProfile: string | undefined;
    const capturingProvider = {
      name: "mock-vision-provider",
      async sendMessage(
        _messages: unknown,
        opts: { config: { overrideProfile: string } },
      ) {
        ranProfile = opts.config.overrideProfile;
        return sendMessageResponse;
      },
    };
    // The cheapest profile has a dangling connection; only premium resolves.
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      return opts.overrideProfile === "cheap-vision" ? null : capturingProvider;
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      await userPromptSubmit(ctx);

      // Tried cheapest first, then fell through to the next usable profile.
      expect(resolutionAttempts).toEqual(["cheap-vision", "premium-vision"]);
      // Captioning ran on premium and succeeded — not a fail-open placeholder.
      expect(ranProfile).toBe("premium-vision");
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      expect((ctx.latestMessages[0].content[0] as { text: string }).text).toBe(
        "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
      );
    } finally {
      restorePluginApiMock();
    }
  });

  test("falls open to the failed-description placeholder when no ranked profile resolves", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      return null; // every vision profile is unusable
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      await userPromptSubmit(ctx);

      // Exhausted every ranked candidate, cheapest-first.
      expect(resolutionAttempts).toEqual(["cheap-vision", "premium-vision"]);
      // Vision profiles exist but none resolve → "failed", not "no model".
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
      expect(text).toContain("auto-description failed");
      expect(text).not.toContain("no vision-capable model");
    } finally {
      restorePluginApiMock();
    }
  });

  test("resolves the provider once per sweep when the cheapest is usable", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    let sendCount = 0;
    const countingProvider = {
      name: "mock-vision-provider",
      async sendMessage(
        _messages: unknown,
        opts: { config: { overrideProfile: string } },
      ) {
        sendCount++;
        // The cheapest profile resolved, so it captions every image.
        expect(opts.config.overrideProfile).toBe("cheap-vision");
        return sendMessageResponse;
      },
    };
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      return countingProvider;
    });
    try {
      // Two distinct (uncached) images in a single sweep.
      const ctx = makeCtx({
        latestMessages: [imageMsg("img-a"), imageMsg("img-b")],
      });
      await userPromptSubmit(ctx);

      // Provider resolved exactly once for the whole sweep — no per-image churn.
      expect(resolutionAttempts).toEqual(["cheap-vision"]);
      // ...yet both images were captioned.
      expect(sendCount).toBe(2);
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      expect(ctx.latestMessages[1].content[0].type).toBe("text");
    } finally {
      restorePluginApiMock();
    }
  });

  test("captions via the next-cheapest profile when the cheapest throws a hard config error", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    let ranProfile: string | undefined;
    const capturingProvider = {
      name: "mock-vision-provider",
      async sendMessage(
        _messages: unknown,
        opts: { config: { overrideProfile: string } },
      ) {
        ranProfile = opts.config.overrideProfile;
        return sendMessageResponse;
      },
    };
    // The cheapest profile names a missing/mismatched provider_connection, so
    // resolution THROWS rather than returning null; only premium resolves.
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      if (opts.overrideProfile === "cheap-vision") {
        throw new Error("provider_connection 'ghost' not found");
      }
      return capturingProvider;
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      // No rejection escapes the sweep despite the cheapest candidate throwing.
      await userPromptSubmit(ctx);

      // Tried cheapest first (it threw), then fell through to the next usable.
      expect(resolutionAttempts).toEqual(["cheap-vision", "premium-vision"]);
      // Captioning ran on premium and succeeded — not a fail-open placeholder.
      expect(ranProfile).toBe("premium-vision");
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      expect((ctx.latestMessages[0].content[0] as { text: string }).text).toBe(
        "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
      );
    } finally {
      restorePluginApiMock();
    }
  });

  test("falls open to the failed-description placeholder when every candidate throws", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      throw new Error(`provider_connection for ${opts.overrideProfile} broken`);
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      // Every candidate throwing must not reject out of the hook.
      await userPromptSubmit(ctx);

      // Exhausted every ranked candidate, cheapest-first, despite each throwing.
      expect(resolutionAttempts).toEqual(["cheap-vision", "premium-vision"]);
      // Vision profiles exist but none resolve → "failed", not "no model".
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      const text = (ctx.latestMessages[0].content[0] as { text: string }).text;
      expect(text).toContain("auto-description failed");
      expect(text).not.toContain("no vision-capable model");
    } finally {
      restorePluginApiMock();
    }
  });

  test("memoizes the settled resolution when the cheapest throws — no rejection cached, no per-image re-attempt", async () => {
    twoRankedVisionProfiles();
    const resolutionAttempts: Array<string | undefined> = [];
    let sendCount = 0;
    const countingProvider = {
      name: "mock-vision-provider",
      async sendMessage(
        _messages: unknown,
        opts: { config: { overrideProfile: string } },
      ) {
        sendCount++;
        // The cheapest threw, so premium is the settled resolution for the sweep.
        expect(opts.config.overrideProfile).toBe("premium-vision");
        return sendMessageResponse;
      },
    };
    setPluginApiMock(async (_callSite, opts) => {
      resolutionAttempts.push(opts.overrideProfile);
      if (opts.overrideProfile === "cheap-vision") {
        throw new Error("provider_connection 'ghost' not found");
      }
      return countingProvider;
    });
    try {
      // Two distinct (uncached) images in a single sweep.
      const ctx = makeCtx({
        latestMessages: [imageMsg("img-a"), imageMsg("img-b")],
      });
      await userPromptSubmit(ctx);

      // Resolution ran exactly once (cheap threw, premium won) and the settled
      // result — not the rejection — was memoized for the second image.
      expect(resolutionAttempts).toEqual(["cheap-vision", "premium-vision"]);
      expect(sendCount).toBe(2);
      expect(ctx.latestMessages[0].content[0].type).toBe("text");
      expect(ctx.latestMessages[1].content[0].type).toBe("text");
    } finally {
      restorePluginApiMock();
    }
  });
});

describe("vision candidate selection (call-site default vs profiles)", () => {
  // A provider that records the override it captioned under (undefined for the
  // call-site default, which passes no `overrideProfile`).
  function capturingProvider(record: (override: string | undefined) => void) {
    return {
      name: "mock-vision-provider",
      async sendMessage(
        _messages: unknown,
        opts: { config: { overrideProfile?: string } },
      ) {
        record(opts.config.overrideProfile);
        return sendMessageResponse;
      },
    };
  }

  test("managed install captions via the call-site default over the pricier vision profile", async () => {
    // Only `quality-optimized` ($10) is a vision PROFILE; the vision call-site
    // default resolves to a $1 model — the managed population driving the
    // captioning spend must land on the cheaper call-site default.
    mockProfiles = [
      profile("balanced", { label: "Balanced", isActive: true }),
      profile("quality-optimized", { label: "Quality" }),
    ];
    visionProfiles = new Set(["quality-optimized"]);
    profilePrices = new Map<string, number>([["quality-optimized", 10]]);
    callSiteVisionModel = "haiku-model";
    visionModels = new Set(["haiku-model"]);
    modelPrices = new Map<string, number>([["haiku-model", 1]]);

    const attempts: Array<string | undefined> = [];
    let ranOverride: string | undefined;
    setPluginApiMock(async (_callSite, opts) => {
      attempts.push(opts.overrideProfile);
      return capturingProvider((o) => {
        ranOverride = o;
      });
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      await userPromptSubmit(ctx);
      // The call-site default (no override) was attempted first and captioned;
      // the pricier profile was never reached.
      expect(attempts).toEqual([undefined]);
      expect(ranOverride).toBeUndefined();
      expect((ctx.latestMessages[0].content[0] as { text: string }).text).toBe(
        "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
      );
    } finally {
      restorePluginApiMock();
    }
  });

  test("BYOK without the call-site default's provider falls through to the vision profile", async () => {
    mockProfiles = [profile("byok-vision", { label: "BYOK Vision" })];
    visionProfiles = new Set(["byok-vision"]);
    profilePrices = new Map<string, number>([["byok-vision", 12]]);
    // The call-site default resolves to a vision-capable model (ranked first at
    // $1) but its provider can't resolve — no Anthropic credentials.
    callSiteVisionModel = "haiku-model";
    visionModels = new Set(["haiku-model"]);
    modelPrices = new Map<string, number>([["haiku-model", 1]]);

    const attempts: Array<string | undefined> = [];
    let ranOverride: string | undefined;
    setPluginApiMock(async (_callSite, opts) => {
      attempts.push(opts.overrideProfile);
      return opts.overrideProfile === "byok-vision"
        ? capturingProvider((o) => {
            ranOverride = o;
          })
        : null;
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      await userPromptSubmit(ctx);
      // Tried the call-site default first (unresolvable), then the profile.
      expect(attempts).toEqual([undefined, "byok-vision"]);
      expect(ranOverride).toBe("byok-vision");
      expect(
        (ctx.latestMessages[0].content[0] as { text: string }).text,
      ).toContain("[Image auto-described");
    } finally {
      restorePluginApiMock();
    }
  });

  test("excludes a text-only call-site default before resolution and captions via the profile", async () => {
    mockProfiles = [profile("byok-vision", { label: "BYOK Vision" })];
    visionProfiles = new Set(["byok-vision"]);
    profilePrices = new Map<string, number>([["byok-vision", 12]]);
    // A workspace `llm.callSites.vision` override resolves the call site to a
    // cheaper text-only model; the vision guard excludes it, so it is never
    // attempted (which would fail at caption time).
    callSiteVisionModel = "text-router";
    visionModels = new Set<string>();
    modelPrices = new Map<string, number>([["text-router", 0.1]]);

    const attempts: Array<string | undefined> = [];
    setPluginApiMock(async (_callSite, opts) => {
      attempts.push(opts.overrideProfile);
      return capturingProvider(() => {});
    });
    try {
      const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
      await userPromptSubmit(ctx);
      expect(attempts).toEqual(["byok-vision"]);
      expect(
        (ctx.latestMessages[0].content[0] as { text: string }).text,
      ).toContain("[Image auto-described");
    } finally {
      restorePluginApiMock();
    }
  });

  test("uses the no-model placeholder when neither the call-site default nor a profile can caption", async () => {
    visionProfiles = new Set<string>(); // no vision profiles
    callSiteVisionModel = "text-router"; // resolves, but text-only
    visionModels = new Set<string>();
    const ctx = makeCtx({ latestMessages: [imageMsg("img1")] });
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0].content[0].type).toBe("text");
    expect(
      (ctx.latestMessages[0].content[0] as { text: string }).text,
    ).toContain("no vision-capable model");
  });
});

describe("image-fallback post-tool-use hook", () => {
  test("captions image blocks nested in a tool result for a text-only model", async () => {
    const ctx = makeToolCtx({
      toolResponse: toolResult([imageBlock("shot1")]),
    });
    await postToolUse(ctx);
    const block = ctx.toolResponse.contentBlocks![0];
    expect(block.type).toBe("text");
    expect((block as { text: string }).text).toBe(
      "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
    );
  });

  test("is a no-op when the model that ran supports vision", async () => {
    visionModels = new Set(["vision-model"]);
    const ctx = makeToolCtx({
      model: "vision-model",
      toolResponse: toolResult([imageBlock("shot1")]),
    });
    await postToolUse(ctx);
    expect(ctx.toolResponse.contentBlocks![0].type).toBe("image");
  });

  test("is a no-op when the tool result has no contentBlocks", async () => {
    const ctx = makeToolCtx({ toolResponse: toolResult() });
    await postToolUse(ctx);
    expect(ctx.toolResponse.contentBlocks).toBeUndefined();
  });

  test("preserves non-image contentBlocks and captions only images", async () => {
    const ctx = makeToolCtx({
      toolResponse: toolResult([
        { type: "text", text: "page title" },
        imageBlock("shot1"),
      ]),
    });
    await postToolUse(ctx);
    const blocks = ctx.toolResponse.contentBlocks!;
    expect((blocks[0] as { text: string }).text).toBe("page title");
    expect(blocks[1].type).toBe("text");
    expect((blocks[1] as { text: string }).text).toContain(
      "[Image auto-described",
    );
  });

  test("uses fail-open placeholder when no vision profile is configured", async () => {
    visionProfiles = new Set<string>(); // no vision profiles
    const ctx = makeToolCtx({
      toolResponse: toolResult([imageBlock("shot1")]),
    });
    await postToolUse(ctx);
    const block = ctx.toolResponse.contentBlocks![0];
    expect(block.type).toBe("text");
    expect((block as { text: string }).text).toContain(
      "no vision-capable model",
    );
  });

  test("does not embed the saved image path in the caption text", async () => {
    const ctx = makeToolCtx({
      toolResponse: toolResult([imageBlock("shot1")]),
    });
    await postToolUse(ctx);
    const text = (ctx.toolResponse.contentBlocks![0] as { text: string }).text;
    expect(text).not.toContain("saved to");
  });

  test("is a no-op when contentBlocks carry no image", async () => {
    const textBlock = { type: "text" as const, text: "just text" };
    const ctx = makeToolCtx({ toolResponse: toolResult([textBlock]) });
    await postToolUse(ctx);
    expect(ctx.toolResponse.contentBlocks![0]).toEqual(textBlock);
  });

  test("gates on ctx.model, not the workspace active profile", async () => {
    // The active profile is vision-capable, but the model that actually ran
    // (ctx.model) is text-only — the model that ran must win, so the image is
    // captioned.
    mockProfiles = [
      profile("vision-active", { isActive: true }),
      profile("vision-profile", {}),
    ];
    visionProfiles = new Set(["vision-active", "vision-profile"]);
    visionModels = new Set<string>(); // "text-only-model" is text-only
    const ctx = makeToolCtx({
      model: "text-only-model",
      toolResponse: toolResult([imageBlock("shot1")]),
    });
    await postToolUse(ctx);
    expect(ctx.toolResponse.contentBlocks![0].type).toBe("text");
  });
});

describe("image-fallback post-compact hook", () => {
  test("is a no-op when the compacted turn's model supports vision", async () => {
    visionProfiles = new Set(["text-only"]); // active profile supports vision
    const history = [imageMsg("retained")];
    const ctx = makeCompactCtx({ history });
    await postCompact(ctx);
    expect(ctx.history[0].content[0].type).toBe("image");
  });

  test("captions retained top-level image blocks for a text-only model", async () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Images retained from the compacted portion of the conversation:",
          },
          imageBlock("retained-shot"),
        ],
      },
    ];
    const ctx = makeCompactCtx({ history });
    await postCompact(ctx);
    expect(ctx.history[0].content[1].type).toBe("text");
    expect((ctx.history[0].content[1] as { text: string }).text).toBe(
      "[Image auto-described for text-only model: A red chart showing Q3 revenue.]",
    );
  });

  test("captions images nested in restored tool_result contentBlocks", async () => {
    const history: Message[] = [
      textMsg("earlier turn"),
      {
        role: "user",
        content: [toolResult([imageBlock("tail-shot")])],
      },
    ];
    const ctx = makeCompactCtx({ history });
    await postCompact(ctx);
    const result = ctx.history[1].content[0] as ToolResultContent;
    expect(result.contentBlocks![0].type).toBe("text");
    expect((result.contentBlocks![0] as { text: string }).text).toContain(
      "[Image auto-described",
    );
  });

  test("reuses captions generated earlier in the conversation — no new vision call", async () => {
    let callCount = 0;
    const trackingProvider = {
      name: "mock-vision-provider",
      async sendMessage() {
        callCount++;
        return sendMessageResponse;
      },
    };
    setPluginApiMock(async () => trackingProvider);

    // The image is captioned once at ingestion (turn-start sweep)...
    const ctx1 = makeCtx({ latestMessages: [imageMsg("compacted-image")] });
    await userPromptSubmit(ctx1);
    expect(callCount).toBe(1);

    // ...then compaction re-attaches the same raw image from persistence; the
    // post-compact sweep must resolve it from the cache without a vision call.
    const ctx2 = makeCompactCtx({ history: [imageMsg("compacted-image")] });
    await postCompact(ctx2);
    expect(callCount).toBe(1); // still 1 — cache hit
    expect(ctx2.history[0].content[0].type).toBe("text");
  });

  test("uses fail-open placeholder when no vision profile is configured", async () => {
    visionProfiles = new Set<string>(); // no vision profiles
    const ctx = makeCompactCtx({ history: [imageMsg("retained")] });
    await postCompact(ctx);
    expect(ctx.history[0].content[0].type).toBe("text");
    expect((ctx.history[0].content[0] as { text: string }).text).toContain(
      "no vision-capable model",
    );
  });
});

describe("image-fallback conversation-deleted hook", () => {
  function makeDeletedCtx(conversationId: string): ConversationDeletedContext {
    return {
      conversationId,
      logger,
    } as unknown as ConversationDeletedContext;
  }

  test("a deleted conversation's captions no longer serve cache hits", async () => {
    let callCount = 0;
    const trackingProvider = {
      name: "mock-vision-provider",
      async sendMessage() {
        callCount++;
        return sendMessageResponse;
      },
    };
    setPluginApiMock(async () => trackingProvider);

    // Caption an image in the doomed conversation.
    const ctx1 = makeCtx({
      conversationId: "conv-doomed",
      latestMessages: [imageMsg("doomed-image")],
    });
    await userPromptSubmit(ctx1);
    expect(callCount).toBe(1);

    await conversationDeleted(makeDeletedCtx("conv-doomed"));

    // The same image in another conversation must re-caption: the derived
    // text did not outlive the conversation that produced it.
    const ctx2 = makeCtx({
      conversationId: "conv-other",
      latestMessages: [imageMsg("doomed-image")],
    });
    await userPromptSubmit(ctx2);
    expect(callCount).toBe(2);
  });

  test("captions shared with a surviving conversation keep serving hits", async () => {
    let callCount = 0;
    const trackingProvider = {
      name: "mock-vision-provider",
      async sendMessage() {
        callCount++;
        return sendMessageResponse;
      },
    };
    setPluginApiMock(async () => trackingProvider);

    // The same image is captioned in one conversation and cache-hit in a
    // second, which records the second conversation's association.
    const ctxA = makeCtx({
      conversationId: "conv-a",
      latestMessages: [imageMsg("shared-image")],
    });
    await userPromptSubmit(ctxA);
    const ctxB = makeCtx({
      conversationId: "conv-b",
      latestMessages: [imageMsg("shared-image")],
    });
    await userPromptSubmit(ctxB);
    expect(callCount).toBe(1);

    await conversationDeleted(makeDeletedCtx("conv-a"));

    // conv-b still references the image, so its caption survives.
    const ctxB2 = makeCtx({
      conversationId: "conv-b",
      latestMessages: [imageMsg("shared-image")],
    });
    await userPromptSubmit(ctxB2);
    expect(callCount).toBe(1);
  });
});
