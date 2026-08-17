import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { __resetRegistryForTesting, getTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// Mock dependencies for the tool wrapper
// ---------------------------------------------------------------------------

let mockGeminiKey: string | undefined = "test-gemini-key";
let mockOpenAIKey: string | undefined = "test-openai-key";
let mockGenerateResult = {
  images: [{ mimeType: "image/png", dataBase64: "generated-data" }],
  text: "A beautiful image",
  resolvedModel: "gemini-3.1-flash-image-preview",
};
let mockGenerateError: Error | null = null;
let lastGenerateProvider: unknown = null;
let lastGenerateCredentials: unknown = null;

/**
 * Seed the image-generation service entry in the real workspace config.
 * Omitted fields fall back to the schema defaults (`provider: "gemini"`,
 * model `gemini-3.1-flash-image-preview`).
 */
function seedImageGenService(
  overrides: {
    provider?: "vellum" | "gemini" | "openai";
    model?: string;
  } = {},
): void {
  setConfig("services", { "image-generation": overrides });
}

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => {
    if (account === "gemini") {
      return mockGeminiKey;
    }
    if (account === "openai") {
      return mockOpenAIKey;
    }
    return undefined;
  },
  getProviderKeyAsync: async (provider: string) => {
    if (provider === "gemini") {
      return mockGeminiKey;
    }
    if (provider === "openai") {
      return mockOpenAIKey;
    }
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
    if (mockGenerateError) {
      throw mockGenerateError;
    }
    return mockGenerateResult;
  },
  mapImageGenError: (provider: unknown, error: unknown) => {
    const providerLabel = provider === "openai" ? "OpenAI" : "Gemini";
    if (error instanceof Error) {
      return `Mock ${providerLabel} error: ${error.message}`;
    }
    return `Mock ${providerLabel} unknown error`;
  },
}));

let mockManagedBaseUrl: string | undefined;
let mockManagedProxyContext = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};

mock.module("../providers/platform-proxy/context.js", () => ({
  buildManagedBaseUrl: async () => mockManagedBaseUrl,
  resolveManagedProxyContext: async () => mockManagedProxyContext,
}));

// Import after mocking
import { run } from "../config/bundled-skills/image-studio/tools/media-generate-image.js";

// Clean up after this file to prevent contamination of later test files.
afterAll(() => {
  __resetRegistryForTesting();
  for (const dir of tempWorkingDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempWorkingDirs: string[] = [];

/** Build a ToolContext with a fresh temp working directory. */
function makeContext(): ToolContext {
  const workingDir = mkdtempSync(join(tmpdir(), "media-gen-test-"));
  tempWorkingDirs.push(workingDir);
  return {
    conversationId: "conv-123",
    workingDir,
  } as unknown as ToolContext;
}

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
  seedImageGenService();
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
  fakeContext = makeContext();
});

let fakeContext: ToolContext;

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

  test("provider vellum uses managed proxy credentials", async () => {
    seedImageGenService({ provider: "vellum" });
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

  test("provider vellum routes managed to the gemini proxy for gemini models", async () => {
    seedImageGenService({ provider: "vellum" });
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    const result = await run({ prompt: "a hippo" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(lastGenerateProvider).toBe("gemini");
    expect(lastGenerateCredentials).toEqual({
      type: "managed-proxy",
      assistantApiKey: "managed-key-123",
      baseUrl: "https://platform.example.com/v1/runtime-proxy/gemini",
    });
  });

  test("provider vellum routes a gpt model to the openai proxy", async () => {
    seedImageGenService({ provider: "vellum", model: "gpt-image-2" });
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-key-123",
    };

    const result = await run({ prompt: "a hippo" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(lastGenerateProvider).toBe("openai");
    expect(lastGenerateCredentials).toEqual({
      type: "managed-proxy",
      assistantApiKey: "managed-key-123",
      baseUrl: "https://platform.example.com/v1/runtime-proxy/openai",
    });
  });

  test("provider vellum with no platform is a hard error, not a BYOK fallback", async () => {
    // Billing rule: an explicit vellum choice never silently spends a stored
    // provider key.
    seedImageGenService({ provider: "vellum" });
    mockGeminiKey = "gemini-key-should-not-be-used";

    const result = await run({ prompt: "a hippo" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed proxy is not available");
    expect(lastGenerateProvider).toBeNull();
  });

  test("provider vellum returns error when managed proxy is unavailable", async () => {
    seedImageGenService({ provider: "vellum" });
    mockGeminiKey = "direct-key"; // should be ignored in managed mode
    mockManagedBaseUrl = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed proxy is not available");
  });

  test("your-own mode uses direct API key", async () => {
    seedImageGenService({ provider: "gemini" });
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
    seedImageGenService({ provider: "openai" });
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
    seedImageGenService({ provider: "openai" });
    mockOpenAIKey = undefined;

    const result = await run({ prompt: "a robot" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("OpenAI");
    expect(result.content).not.toContain("No Gemini API key");
  });

  test("explicit model override routes to owning provider (gemini config → openai call)", async () => {
    // Config says the user's default provider is gemini, but the LLM
    // explicitly requests a gpt-* model. The tool must dispatch to OpenAI
    // and resolve OpenAI credentials, not fall back to Gemini's default.
    seedImageGenService({ provider: "gemini" });
    mockOpenAIKey = "openai-direct-key";

    const result = await run(
      { prompt: "a robot", model: "gpt-image-2" },
      fakeContext,
    );

    expect(result.isError).toBe(false);
    expect(lastGenerateProvider).toBe("openai");
    expect(lastGenerateCredentials).toEqual({
      type: "direct",
      apiKey: "openai-direct-key",
    });
  });

  test("explicit model override routes to owning provider (openai config → gemini call)", async () => {
    // The inverse: config says openai but the LLM asks for a gemini-* model.
    seedImageGenService({ provider: "openai" });
    mockGeminiKey = "gemini-direct-key";

    const result = await run(
      { prompt: "a cat", model: "gemini-3-pro-image-preview" },
      fakeContext,
    );

    expect(result.isError).toBe(false);
    expect(lastGenerateProvider).toBe("gemini");
    expect(lastGenerateCredentials).toEqual({
      type: "direct",
      apiKey: "gemini-direct-key",
    });
  });

  test("cross-provider override surfaces owning provider's credential error", async () => {
    // Config: gemini (with a gemini key). LLM asks for gpt-image-2 but the
    // OpenAI key is missing. The error hint must reference OpenAI, not
    // Gemini, because the dispatch target is OpenAI.
    seedImageGenService({ provider: "gemini" });
    mockGeminiKey = "test-gemini-key";
    mockOpenAIKey = undefined;

    const result = await run(
      { prompt: "a robot", model: "gpt-image-2" },
      fakeContext,
    );

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
    expect(result.content).toContain(
      "Failed model: gemini-3.1-flash-image-preview",
    );
    expect(result.content).toContain(
      "Do not change service configuration (managed/your-own mode or default provider/model settings)",
    );
    expect(result.content).toContain(
      "Retrying this call once with a different model parameter is allowed",
    );
  });

  test("openai generation error uses OpenAI-specific mapping", async () => {
    seedImageGenService({ provider: "openai" });
    mockGenerateError = new Error("openai failure");

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Mock OpenAI error: openai failure");
    expect(result.content).toContain(
      "Do not change service configuration (managed/your-own mode or default provider/model settings)",
    );
    expect(result.content).toContain(
      "Retrying this call once with a different model parameter is allowed",
    );
  });

  test("missing credentials error includes guidance not to change service config", async () => {
    mockGeminiKey = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No Gemini API key");
    expect(result.content).toContain("Report this error to the user as-is");
    expect(result.content).toContain(
      "Do not change service configuration (managed/your-own mode or default provider/model settings)",
    );
  });

  test("provider vellum credential error includes guidance not to change service config", async () => {
    seedImageGenService({ provider: "vellum" });
    mockManagedBaseUrl = undefined;

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Managed proxy is not available");
    expect(result.content).toContain("Report this error to the user as-is");
    expect(result.content).toContain(
      "Do not change service configuration (managed/your-own mode or default provider/model settings)",
    );
  });

  test("reads source images from file paths on disk", async () => {
    // Write a temp image file inside the workspace
    const tmpPath = join(fakeContext.workingDir, "test-source-image.png");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    await Bun.write(tmpPath, pngBytes);

    const result = await run(
      { prompt: "edit this", mode: "edit", source_paths: [tmpPath] },
      fakeContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Generated 1 image");
  });

  test("saves the image into media/generated and returns the embed instruction", async () => {
    const result = await run({ prompt: "a sunset" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Saved to media/generated/a-sunset.png");
    expect(result.content).toContain(
      "![description](vellum://workspace/media/generated/a-sunset.png)",
    );
    const saved = Bun.file(
      join(fakeContext.workingDir, "media/generated/a-sunset.png"),
    );
    expect(await saved.exists()).toBe(true);
    const bytes = Buffer.from(await saved.arrayBuffer());
    expect(bytes.equals(Buffer.from("generated-data", "base64"))).toBe(true);
  });

  test("uses the image title for the filename when present", async () => {
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: "img1",
          title: "Twilight Gremlin!",
        } as never,
      ],
      text: "",
      resolvedModel: "gemini-3.1-flash-image-preview",
    };

    const result = await run({ prompt: "a pond creature" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "Saved to media/generated/twilight-gremlin.png",
    );
  });

  test("gives each variant a distinct filename", async () => {
    mockGenerateResult = {
      images: [
        { mimeType: "image/png", dataBase64: "img1" },
        { mimeType: "image/png", dataBase64: "img2" },
      ],
      text: undefined as unknown as string,
      resolvedModel: "gemini-3.1-flash-image-preview",
    };

    const result = await run({ prompt: "a robot", variants: 2 }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("- media/generated/a-robot.png");
    expect(result.content).toContain("- media/generated/a-robot-2.png");
    expect(
      await Bun.file(
        join(fakeContext.workingDir, "media/generated/a-robot-2.png"),
      ).exists(),
    ).toBe(true);
  });

  test("suffixes the filename when a previous generation already used it", async () => {
    const first = await run({ prompt: "a fox" }, fakeContext);
    expect(first.content).toContain("Saved to media/generated/a-fox.png");

    const second = await run({ prompt: "a fox" }, fakeContext);
    expect(second.content).toContain("Saved to media/generated/a-fox-2.png");
  });

  test("refuses to write through a symlink that escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "media-gen-outside-"));
    tempWorkingDirs.push(outside);
    symlinkSync(outside, join(fakeContext.workingDir, "media"));

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Could not save to the workspace");
    expect(result.content).not.toContain("vellum://workspace/");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("falls back to inline-only when the workspace write fails", async () => {
    // Occupy the media path with a regular file so the directory creation
    // under it fails.
    writeFileSync(join(fakeContext.workingDir, "media"), "not a directory");

    const result = await run({ prompt: "a cat" }, fakeContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Could not save to the workspace");
    expect(result.content).toContain(
      "will be attached to your reply automatically",
    );
    expect(result.content).not.toContain("vellum://workspace/");
    expect(result.contentBlocks).toHaveLength(1);
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
    // No enum by design: model accepts tier aliases or concrete IDs, and is
    // validated at runtime against the registry so the schema never goes
    // stale when models change.
    expect(props.model.type).toBe("string");
    expect(props.model.enum).toBeUndefined();
    expect(props.variants.type).toBe("number");
  });
});
