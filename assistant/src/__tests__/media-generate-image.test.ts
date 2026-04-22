import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { readFileSync } from "fs";
import { dirname, join } from "path";

import { __resetRegistryForTesting, getTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock dependencies for the tool wrapper
// ---------------------------------------------------------------------------

let mockGeminiKey: string | undefined = "test-gemini-key";
let mockOpenAIKey: string | undefined = "test-openai-key";
let mockImageGenMode: "your-own" | "managed" = "your-own";
let mockImageGenProvider: "gemini" | "openai" = "gemini";
let mockGenerateResult = {
  images: [{ mimeType: "image/png", dataBase64: "generated-data" }],
  text: "A beautiful image",
  resolvedModel: "gemini-3.1-flash-image-preview",
};
let mockGenerateError: Error | null = null;
let lastGenerateProvider: unknown = null;
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
        mode: mockImageGenMode,
        provider: mockImageGenProvider,
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => {
    if (account === "gemini") return mockGeminiKey;
    if (account === "openai") return mockOpenAIKey;
    return undefined;
  },
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "gemini") return mockGeminiKey;
    if (provider === "openai") return mockOpenAIKey;
    return undefined;
  },
}));

mock.module("../media/image-service.js", () => ({
  generateImage: async (
    provider: unknown,
    credentials: unknown,
    _request: Record<string, unknown>,
  ) => {
    lastGenerateProvider = provider;
    lastGenerateCredentials = credentials;
    if (mockGenerateError) throw mockGenerateError;
    return mockGenerateResult;
  },
  mapImageGenError: (provider: unknown, error: unknown) => {
    const providerLabel = provider === "openai" ? "OpenAI" : "Gemini";
    if (error instanceof Error)
      return `Mock ${providerLabel} error: ${error.message}`;
    return `Mock ${providerLabel} unknown error`;
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
  mockGeminiKey = "test-gemini-key";
  mockOpenAIKey = "test-openai-key";
  mockImageGenMode = "your-own";
  mockImageGenProvider = "gemini";
  mockGenerateResult = {
    images: [{ mimeType: "image/png", dataBase64: "generated-data" }],
    text: "A beautiful image",
    resolvedModel: "gemini-3.1-flash-image-preview",
  };
  mockGenerateError = null;
  lastGenerateProvider = null;
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
    mockGeminiKey = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No Gemini API key");
  });

  test("managed mode uses managed proxy credentials", async () => {
    mockImageGenMode = "managed";
    mockManagedBaseUrl = "https://platform.example.com/v1/runtime-proxy/gemini";
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    const result = await run({ prompt: "a hippo" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Generated 1 image");
    expect(lastGenerateProvider).toBe("gemini");
    expect(lastGenerateCredentials).toEqual({
      type: "managed-proxy",
      assistantApiKey: "managed-key-123",
      baseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
    });
  });

  test("managed mode returns error when managed proxy is unavailable", async () => {
    mockImageGenMode = "managed";
    mockGeminiKey = "direct-key"; // should be ignored in managed mode
    mockManagedBaseUrl = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed proxy is not available");
  });

  test("your-own mode uses direct API key", async () => {
    mockImageGenMode = "your-own";
    mockGeminiKey = "direct-key";
    mockManagedBaseUrl = "https://platform.example.com/v1/runtime-proxy/gemini";
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    await run({ prompt: "a cat" }, fakeContext);

    expect(lastGenerateProvider).toBe("gemini");
    expect(lastGenerateCredentials).toEqual({
      type: "direct",
      apiKey: "direct-key",
    });
  });

  test("openai provider dispatches to OpenAI with its key", async () => {
    mockImageGenProvider = "openai";
    mockOpenAIKey = "openai-direct-key";

    const result = await run({ prompt: "a robot" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(lastGenerateProvider).toBe("openai");
    expect(lastGenerateCredentials).toEqual({
      type: "direct",
      apiKey: "openai-direct-key",
    });
  });

  test("openai provider returns OpenAI-specific error hint when no key", async () => {
    mockImageGenProvider = "openai";
    mockOpenAIKey = undefined;

    const result = await run({ prompt: "a robot" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("OpenAI");
    expect(result.content).not.toContain("No Gemini API key");
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
    expect(result.content).toContain("Mock Gemini error: API failure");
  });

  test("openai generation error uses OpenAI-specific mapping", async () => {
    mockImageGenProvider = "openai";
    mockGenerateError = new Error("openai failure");

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Mock OpenAI error: openai failure");
  });

  test("reads source images from file paths on disk", async () => {
    // Write a temp image file inside the workspace (fakeContext.workingDir = /tmp)
    const tmpPath = join("/tmp", "test-source-image.png");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await Bun.write(tmpPath, pngBytes);

    try {
      const result = await run(
        { prompt: "edit this", mode: "edit", source_paths: [tmpPath] },
        fakeContext,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Generated 1 image");
    } finally {
      const { unlink } = await import("fs/promises");
      if (await Bun.file(tmpPath).exists()) await unlink(tmpPath);
    }
  });

  test("returns error when all source_paths are invalid", async () => {
    const result = await run(
      {
        prompt: "edit this",
        mode: "edit",
        source_paths: ["/nonexistent/path.png"],
      },
      fakeContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "None of the specified file paths could be read",
    );
  });

  test("rejects source_paths outside the workspace", async () => {
    const result = await run(
      {
        prompt: "edit this",
        mode: "edit",
        source_paths: ["/etc/passwd"],
      },
      fakeContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the working directory");
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

  test("input schema has optional mode, source_paths, model, variants", () => {
    const props = manifest.tools[0].input_schema.properties;
    expect(props.mode.enum).toEqual(["generate", "edit"]);
    expect(props.source_paths.type).toBe("array");
    expect(props.attachment_ids).toBeUndefined();
    expect(props.model.enum).toEqual([
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image-preview",
      "gpt-image-2",
    ]);
    expect(props.variants.type).toBe("number");
  });
});
