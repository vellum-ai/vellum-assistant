import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { readFileSync } from "fs";
import { dirname, join } from "path";

import { __resetRegistryForTesting, getTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock dependencies for the tool wrapper
// ---------------------------------------------------------------------------

let mockApiKey: string | undefined = "test-gemini-key";
let mockGenerateResult = {
  images: [{ mimeType: "image/png", dataBase64: "generated-data" }],
  text: "A beautiful image",
  resolvedModel: "gemini-3.1-flash-image-preview",
};
let mockGenerateError: Error | null = null;
let lastGenerateCredentials: unknown = null;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => {
    if (account === "gemini") return mockApiKey;
    return undefined;
  },
}));

mock.module("../media/gemini-image-service.js", () => ({
  generateImage: async (
    credentials: unknown,
    _request: Record<string, unknown>,
  ) => {
    lastGenerateCredentials = credentials;
    if (mockGenerateError) throw mockGenerateError;
    return mockGenerateResult;
  },
  mapGeminiError: (error: unknown) => {
    if (error instanceof Error) return `Mock error: ${error.message}`;
    return "Mock unknown error";
  },
}));

let mockManagedBaseUrl: string | undefined;
let mockManagedProxyContext = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};

mock.module("../providers/managed-proxy/context.js", () => ({
  buildManagedBaseUrl: async () => mockManagedBaseUrl,
  resolveManagedProxyContext: async () => mockManagedProxyContext,
}));

let mockAttachments: Array<{
  id: string;
  assistantId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  createdAt: number;
  dataBase64: string;
}> = [];

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: (_assistantId: string, _ids: string[]) =>
    mockAttachments,
  getAttachmentContent: (id: string) => {
    const att = mockAttachments.find((a) => a.id === id);
    if (!att) return null;
    return Buffer.from(att.dataBase64, "base64");
  },
}));

mock.module("../memory/db.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => ({ assistantId: "test-assistant" }),
        }),
      }),
    }),
  }),
}));

mock.module("../memory/schema.js", () => ({
  conversationKeys: {
    assistantId: "assistantId",
    conversationId: "conversationId",
  },
}));

mock.module("drizzle-orm", () => ({
  eq: () => true,
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getConversationType: () => "standard",
}));

mock.module("../daemon/media-visibility-policy.js", () => ({
  isAttachmentVisible: () => true,
}));

mock.module("../tools/assets/search.js", () => ({
  getAttachmentSourceConversations: () => [],
}));

// Import after mocking
import { run } from "../config/bundled-skills/image-studio/tools/media-generate-image.js";

// Clean up after this file to prevent contamination of later test files.
afterAll(() => {
  __resetRegistryForTesting();
});

const CONFIG_DIR = join(
  dirname(import.meta.dirname!),
  "config",
  "bundled-skills",
  "image-studio",
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiKey = "test-gemini-key";
  mockGenerateResult = {
    images: [{ mimeType: "image/png", dataBase64: "generated-data" }],
    text: "A beautiful image",
    resolvedModel: "gemini-3.1-flash-image-preview",
  };
  mockGenerateError = null;
  mockAttachments = [];
  lastGenerateCredentials = null;
  mockManagedBaseUrl = undefined;
  mockManagedProxyContext = {
    enabled: false,
    platformBaseUrl: "",
    assistantApiKey: "",
  };
});

const fakeContext = {
  conversationId: "conv-123",
  workingDir: "/tmp",
} as unknown as ToolContext;

describe("image-studio skill script wrapper", () => {
  test("exports a run function without registering media_generate_image in the tool registry", async () => {
    expect(getTool("media_generate_image")).toBeUndefined();
    expect(typeof run).toBe("function");
    expect(getTool("media_generate_image")).toBeUndefined();
  });

  test("returns error when no API key and no managed proxy", async () => {
    mockApiKey = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No Gemini API key");
  });

  test("falls back to managed proxy when no API key is configured", async () => {
    mockApiKey = undefined;
    mockManagedBaseUrl = "https://platform.example.com/v1/runtime-proxy/vertex";
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    const result = await run({ prompt: "a hippo" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Generated 1 image");
    expect(lastGenerateCredentials).toEqual({
      type: "managed-proxy",
      assistantApiKey: "managed-key-123",
      baseUrl: "https://platform.example.com/v1/runtime-proxy/vertex",
    });
  });

  test("prefers direct API key over managed proxy", async () => {
    mockApiKey = "direct-key";
    mockManagedBaseUrl = "https://platform.example.com/v1/runtime-proxy/vertex";
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    await run({ prompt: "a cat" }, fakeContext);

    expect(lastGenerateCredentials).toEqual({
      type: "direct",
      apiKey: "direct-key",
    });
  });

  test("returns generated image with contentBlocks", async () => {
    const result = await run({ prompt: "a sunset" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Generated 1 image");
    expect(result.content).toContain("gemini-3.1-flash-image-preview");
    expect(result.content).toContain("A beautiful image");
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks![0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "generated-data",
      },
    });
  });

  test("handles multiple images in result", async () => {
    mockGenerateResult = {
      images: [
        { mimeType: "image/png", dataBase64: "img1" },
        { mimeType: "image/png", dataBase64: "img2" },
      ],
      text: undefined as unknown as string,
      resolvedModel: "gemini-3.1-flash-image-preview",
    };

    const result = await run({ prompt: "test", variants: 2 }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Generated 2 images");
    expect(result.contentBlocks).toHaveLength(2);
  });

  test("handles generation error gracefully", async () => {
    mockGenerateError = new Error("API failure");

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Mock error: API failure");
  });

  test("passes attachment data as sourceImages for edit mode", async () => {
    mockAttachments = [
      {
        id: "att-1",
        assistantId: "test-assistant",
        originalFilename: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        kind: "image",
        createdAt: Date.now(),
        dataBase64: "attachment-data",
      },
    ];

    const result = await run(
      { prompt: "remove bg", mode: "edit", attachment_ids: ["att-1"] },
      fakeContext,
    );

    expect(result.isError).toBe(false);
  });
});

describe("image-studio TOOLS.json manifest", () => {
  const manifest = JSON.parse(
    readFileSync(join(CONFIG_DIR, "TOOLS.json"), "utf-8"),
  );

  test("has version 1", () => {
    expect(manifest.version).toBe(1);
  });

  test("declares exactly one tool", () => {
    expect(manifest.tools).toHaveLength(1);
  });

  test("tool is named media_generate_image", () => {
    expect(manifest.tools[0].name).toBe("media_generate_image");
  });

  test("tool executor points to the skill script wrapper", () => {
    expect(manifest.tools[0].executor).toBe("tools/media-generate-image.ts");
  });

  test("tool execution_target is host", () => {
    expect(manifest.tools[0].execution_target).toBe("host");
  });

  test("tool risk is low", () => {
    expect(manifest.tools[0].risk).toBe("low");
  });

  test("tool category is media", () => {
    expect(manifest.tools[0].category).toBe("media");
  });

  test("input schema requires prompt", () => {
    const schema = manifest.tools[0].input_schema;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["prompt"]);
    expect(schema.properties.prompt.type).toBe("string");
  });

  test("input schema has optional mode, attachment_ids, model, variants", () => {
    const props = manifest.tools[0].input_schema.properties;
    expect(props.mode.enum).toEqual(["generate", "edit"]);
    expect(props.attachment_ids.type).toBe("array");
    expect(props.model.enum).toEqual([
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
    ]);
    expect(props.variants.type).toBe("number");
  });
});
