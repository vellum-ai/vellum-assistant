/**
 * Tests for the `assistant image-generation` CLI command.
 *
 * Validates:
 *   - Help text for `image-generation` and `image-generation generate`
 *   - Required --prompt enforcement
 *   - Managed vs your-own credential resolution
 *   - Error when no credentials are available
 *   - Generate mode success (file written, path on stdout)
 *   - --json output format
 *   - Edit mode with --source (source images passed through)
 *   - --variants passed through
 *   - --model override
 *   - Provider dispatch (gemini vs openai)
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** Config returned by getConfig() */
let mockConfig = {
  services: {
    "image-generation": {
      mode: "your-own" as "managed" | "your-own",
      provider: "gemini" as "gemini" | "openai",
      model: "gemini-3.1-flash-image-preview",
    },
  },
};

/** Result returned by buildManagedBaseUrl() */
let mockManagedBaseUrl: string | undefined = undefined;

/** Context returned by resolveManagedProxyContext() */
let mockManagedProxyContext = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};

/** Key returned by getProviderKeyAsync(). Keyed by provider. */
let mockProviderKeys: Record<string, string | undefined> = {};

/** Result returned by generateImage() */
let mockGenerateResult: {
  images: Array<{ mimeType: string; dataBase64: string; title?: string }>;
  text?: string;
  resolvedModel: string;
} = {
  images: [
    {
      mimeType: "image/png",
      dataBase64: Buffer.from("fake-png-data").toString("base64"),
    },
  ],
  resolvedModel: "gemini-3.1-flash-image-preview",
};

/** Error to throw from generateImage() (if set) */
let mockGenerateError: Error | undefined = undefined;

/** Captured generateImage call args */
let lastGenerateCall: {
  provider: unknown;
  credentials: unknown;
  request: unknown;
} | null = null;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../config/loader.js", () => ({
  getConfig: () => mockConfig,
  getConfigReadOnly: () => mockConfig,
}));

mock.module("../../../providers/managed-proxy/context.js", () => ({
  buildManagedBaseUrl: async () => mockManagedBaseUrl,
  resolveManagedProxyContext: async () => mockManagedProxyContext,
}));

mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async (provider: string) => mockProviderKeys[provider],
}));

mock.module("../../../media/image-service.js", () => ({
  generateImage: async (
    provider: unknown,
    credentials: unknown,
    request: unknown,
  ) => {
    lastGenerateCall = { provider, credentials, request };
    if (mockGenerateError) throw mockGenerateError;
    return mockGenerateResult;
  },
  mapImageGenError: (provider: unknown, error: unknown) => {
    if (error instanceof Error)
      return `Mapped error (${String(provider)}): ${error.message}`;
    return "An unexpected error occurred during image generation.";
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerImageGenerationCommand } =
  await import("../image-generation.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: (str: string) => stderrChunks.push(str),
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerImageGenerationCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConfig = {
    services: {
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
    },
  };
  mockManagedBaseUrl = undefined;
  mockManagedProxyContext = {
    enabled: false,
    platformBaseUrl: "",
    assistantApiKey: "",
  };
  mockProviderKeys = {};
  mockGenerateResult = {
    images: [
      {
        mimeType: "image/png",
        dataBase64: Buffer.from("fake-png-data").toString("base64"),
      },
    ],
    resolvedModel: "gemini-3.1-flash-image-preview",
  };
  mockGenerateError = undefined;
  lastGenerateCall = null;
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("help text", () => {
  test("image-generation --help renders mode explanation and examples", async () => {
    const { stdout } = await runCommand(["image-generation", "--help"]);
    expect(stdout).toContain("AI image generation and editing");
    expect(stdout).toContain("managed");
    expect(stdout).toContain("your-own");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("generate");
    // Both providers mentioned and gpt-image-2 listed as a supported model.
    expect(stdout).toContain("Gemini");
    expect(stdout).toContain("OpenAI");
    expect(stdout).toContain("gpt-image-2");
  });

  test("image-generation generate --help renders argument docs and examples", async () => {
    const { stdout } = await runCommand([
      "image-generation",
      "generate",
      "--help",
    ]);
    expect(stdout).toContain("--prompt");
    expect(stdout).toContain("--mode");
    expect(stdout).toContain("--source");
    expect(stdout).toContain("--variants");
    expect(stdout).toContain("--output-dir");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("Examples:");
  });
});

// ---------------------------------------------------------------------------
// Required --prompt enforcement
// ---------------------------------------------------------------------------

describe("required arguments", () => {
  test("generate requires --prompt", async () => {
    mockProviderKeys.gemini = "test-key";
    const { exitCode } = await runCommand(["image-generation", "generate"]);
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No credentials error
// ---------------------------------------------------------------------------

describe("credential errors", () => {
  test("exits with code 1 when no credentials in your-own mode", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockProviderKeys.gemini = undefined;

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
    ]);
    expect(exitCode).toBe(1);
  });

  test("exits with code 1 when no credentials in managed mode", async () => {
    mockConfig.services["image-generation"].mode = "managed";
    mockManagedBaseUrl = undefined;

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
    ]);
    expect(exitCode).toBe(1);
  });

  test("--json outputs error when no credentials in your-own mode (gemini)", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "gemini";
    mockProviderKeys.gemini = undefined;

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Gemini API key");
  });

  test("--json outputs OpenAI-specific hint when provider=openai and no key set", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "openai";
    mockConfig.services["image-generation"].model = "gpt-image-2";
    mockProviderKeys.openai = undefined;

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("OpenAI API key");
  });

  test("--json outputs error when no credentials in managed mode", async () => {
    mockConfig.services["image-generation"].mode = "managed";
    mockManagedBaseUrl = undefined;

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    // Base hint from image-credentials.ts is preserved.
    expect(parsed.error).toContain("Managed proxy");
    // CLI augments the hint with CLI-specific recovery guidance so users
    // know how to resolve the problem from the CLI (the shared hint is
    // tool-flavored and only mentions the Vellum app).
    expect(parsed.error).toContain("assistant auth login");
    expect(parsed.error).toContain(
      "services.image-generation.mode to 'your-own'",
    );
  });

  test("your-own mode hint is NOT augmented with CLI auth guidance", async () => {
    // The CLI-specific `assistant auth login` guidance only makes sense when
    // the user is trying to use managed mode. In your-own mode, the shared
    // hint (pointing at Settings > Models & Services for the API key) is
    // already actionable from the CLI perspective (the key is in secure
    // storage, the user just hasn't set it). Augmenting here would confuse
    // the user into thinking they need to authenticate to Vellum.
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "gemini";
    mockProviderKeys.gemini = undefined;

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset",
      "--json",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).not.toContain("assistant auth login");
  });
});

// ---------------------------------------------------------------------------
// Credential resolution paths
// ---------------------------------------------------------------------------

describe("credential resolution", () => {
  test("your-own mode uses getProviderKeyAsync for direct credentials", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockProviderKeys.gemini = "test-gemini-key";

    await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--output-dir",
      os.tmpdir(),
    ]);

    expect(lastGenerateCall).toBeDefined();
    const creds = lastGenerateCall!.credentials as {
      type: string;
      apiKey: string;
    };
    expect(creds.type).toBe("direct");
    expect(creds.apiKey).toBe("test-gemini-key");
  });

  test("managed mode uses buildManagedBaseUrl + resolveManagedProxyContext", async () => {
    mockConfig.services["image-generation"].mode = "managed";
    mockManagedBaseUrl = "https://platform.example.com/proxy/gemini";
    mockManagedProxyContext = {
      enabled: true,
      platformBaseUrl: "https://platform.example.com",
      assistantApiKey: "managed-api-key",
    };

    await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--output-dir",
      os.tmpdir(),
    ]);

    expect(lastGenerateCall).toBeDefined();
    const creds = lastGenerateCall!.credentials as {
      type: string;
      assistantApiKey: string;
      baseUrl: string;
    };
    expect(creds.type).toBe("managed-proxy");
    expect(creds.assistantApiKey).toBe("managed-api-key");
    expect(creds.baseUrl).toBe("https://platform.example.com/proxy/gemini");
  });
});

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

describe("provider dispatch", () => {
  test("provider=gemini is forwarded to the dispatcher", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "gemini";
    mockProviderKeys.gemini = "test-gemini-key";
    const outDir = join(os.tmpdir(), `img-dispatch-gemini-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    expect(lastGenerateCall!.provider).toBe("gemini");
  });

  test("provider=openai with --model gpt-image-2 is forwarded to the dispatcher", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "openai";
    mockConfig.services["image-generation"].model = "gpt-image-2";
    mockProviderKeys.openai = "test-openai-key";
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("fake-png-data").toString("base64"),
        },
      ],
      resolvedModel: "gpt-image-2",
    };
    const outDir = join(os.tmpdir(), `img-dispatch-openai-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--model",
      "gpt-image-2",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    expect(lastGenerateCall!.provider).toBe("openai");
    const req = lastGenerateCall!.request as { model: string };
    expect(req.model).toBe("gpt-image-2");
    const creds = lastGenerateCall!.credentials as {
      type: string;
      apiKey: string;
    };
    expect(creds.type).toBe("direct");
    expect(creds.apiKey).toBe("test-openai-key");
  });

  test("cross-provider override: config=gemini + --model gpt-image-2 dispatches to openai", async () => {
    // Config still points at gemini (the user's Settings default), but the
    // CLI caller explicitly picks gpt-image-2. The command must dispatch to
    // OpenAI and resolve OpenAI credentials, not fall back to Gemini's
    // default model.
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "gemini";
    mockConfig.services["image-generation"].model =
      "gemini-3.1-flash-image-preview";
    mockProviderKeys.openai = "test-openai-key";
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("fake-png-data").toString("base64"),
        },
      ],
      resolvedModel: "gpt-image-2",
    };
    const outDir = join(os.tmpdir(), `img-cross-openai-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--model",
      "gpt-image-2",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    expect(lastGenerateCall!.provider).toBe("openai");
    const req = lastGenerateCall!.request as { model: string };
    expect(req.model).toBe("gpt-image-2");
    const creds = lastGenerateCall!.credentials as {
      type: string;
      apiKey: string;
    };
    expect(creds.type).toBe("direct");
    expect(creds.apiKey).toBe("test-openai-key");
  });

  test("cross-provider override: config=openai + --model gemini-3-pro-image-preview dispatches to gemini", async () => {
    mockConfig.services["image-generation"].mode = "your-own";
    mockConfig.services["image-generation"].provider = "openai";
    mockConfig.services["image-generation"].model = "gpt-image-2";
    mockProviderKeys.gemini = "test-gemini-key";
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("fake-png-data").toString("base64"),
        },
      ],
      resolvedModel: "gemini-3-pro-image-preview",
    };
    const outDir = join(os.tmpdir(), `img-cross-gemini-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--model",
      "gemini-3-pro-image-preview",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    expect(lastGenerateCall!.provider).toBe("gemini");
    const req = lastGenerateCall!.request as { model: string };
    expect(req.model).toBe("gemini-3-pro-image-preview");
    const creds = lastGenerateCall!.credentials as {
      type: string;
      apiKey: string;
    };
    expect(creds.type).toBe("direct");
    expect(creds.apiKey).toBe("test-gemini-key");
  });
});

// ---------------------------------------------------------------------------
// Generate mode success
// ---------------------------------------------------------------------------

describe("generate mode", () => {
  test("generates image and prints file path to stdout", async () => {
    mockProviderKeys.gemini = "test-key";
    const outDir = join(os.tmpdir(), `img-gen-test-${Date.now()}`);

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "A sunset over the ocean",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    const outputPath = stdout.trim();
    expect(outputPath).toContain("image-1.png");
    expect(existsSync(outputPath)).toBe(true);

    // Verify file content matches decoded base64
    const written = readFileSync(outputPath);
    const expected = Buffer.from(
      mockGenerateResult.images[0].dataBase64,
      "base64",
    );
    expect(written).toEqual(expected);
  });

  test("--json produces structured output with paths, MIME types, and sizes", async () => {
    mockProviderKeys.gemini = "test-key";
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("test-data").toString("base64"),
        },
      ],
      text: "A beautiful sunset",
      resolvedModel: "gemini-3.1-flash-image-preview",
    };
    const outDir = join(os.tmpdir(), `img-gen-json-${Date.now()}`);

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--output-dir",
      outDir,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.model).toBe("gemini-3.1-flash-image-preview");
    expect(parsed.text).toBe("A beautiful sunset");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].path).toContain("image-1.png");
    expect(parsed.images[0].mimeType).toBe("image/png");
    expect(typeof parsed.images[0].sizeBytes).toBe("number");
    expect(parsed.images[0].sizeBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edit mode with --source
// ---------------------------------------------------------------------------

describe("edit mode", () => {
  test("exits with code 1 when --mode edit is used without --source", async () => {
    mockProviderKeys.gemini = "test-key";

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Remove background",
      "--mode",
      "edit",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe(
      "Edit mode requires at least one --source image file.",
    );
  });

  test("passes source images to generateImage in edit mode", async () => {
    mockProviderKeys.gemini = "test-key";

    // Use a real temp file for the source image
    const sourceDir = join(os.tmpdir(), `img-src-test-${Date.now()}`);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "input.png");
    writeFileSync(sourcePath, Buffer.from("fake-source-png"));

    const outDir = join(os.tmpdir(), `img-edit-test-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Remove background",
      "--mode",
      "edit",
      "--source",
      sourcePath,
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    const req = lastGenerateCall!.request as {
      mode: string;
      sourceImages: Array<{ mimeType: string; dataBase64: string }>;
    };
    expect(req.mode).toBe("edit");
    expect(req.sourceImages).toBeDefined();
    expect(req.sourceImages).toHaveLength(1);
    expect(req.sourceImages[0].dataBase64).toBe(
      Buffer.from("fake-source-png").toString("base64"),
    );
  });
});

// ---------------------------------------------------------------------------
// --variants
// ---------------------------------------------------------------------------

describe("variants", () => {
  test("non-numeric --variants defaults to 1", async () => {
    mockProviderKeys.gemini = "test-key";
    const outDir = join(os.tmpdir(), `img-nan-variants-${Date.now()}`);

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--variants",
      "abc",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    const req = lastGenerateCall!.request as { variants: number };
    expect(req.variants).toBe(1);
  });

  test("--variants is passed through to generateImage", async () => {
    mockProviderKeys.gemini = "test-key";
    mockGenerateResult = {
      images: [
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("img1").toString("base64"),
        },
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("img2").toString("base64"),
        },
        {
          mimeType: "image/png",
          dataBase64: Buffer.from("img3").toString("base64"),
        },
      ],
      resolvedModel: "gemini-3.1-flash-image-preview",
    };
    const outDir = join(os.tmpdir(), `img-variants-test-${Date.now()}`);

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Logo design",
      "--variants",
      "3",
      "--output-dir",
      outDir,
    ]);

    expect(exitCode).toBe(0);
    expect(lastGenerateCall).toBeDefined();
    const req = lastGenerateCall!.request as { variants: number };
    expect(req.variants).toBe(3);

    // Should output 3 file paths
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("image-1.png");
    expect(lines[1]).toContain("image-2.png");
    expect(lines[2]).toContain("image-3.png");
  });
});

// ---------------------------------------------------------------------------
// --model override
// ---------------------------------------------------------------------------

describe("model override", () => {
  test("--model overrides config model", async () => {
    mockProviderKeys.gemini = "test-key";
    const outDir = join(os.tmpdir(), `img-model-test-${Date.now()}`);

    await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--model",
      "gemini-3-pro-image-preview",
      "--output-dir",
      outDir,
    ]);

    expect(lastGenerateCall).toBeDefined();
    const req = lastGenerateCall!.request as { model: string };
    expect(req.model).toBe("gemini-3-pro-image-preview");
  });

  test("falls back to config model when --model is not provided", async () => {
    mockProviderKeys.gemini = "test-key";
    mockConfig.services["image-generation"].model =
      "gemini-3.1-flash-image-preview";
    const outDir = join(os.tmpdir(), `img-model-fallback-${Date.now()}`);

    await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--output-dir",
      outDir,
    ]);

    expect(lastGenerateCall).toBeDefined();
    const req = lastGenerateCall!.request as { model: string };
    expect(req.model).toBe("gemini-3.1-flash-image-preview");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("maps generateImage error and exits with code 1", async () => {
    mockProviderKeys.gemini = "test-key";
    mockGenerateError = new Error("API rate limit exceeded");

    const { exitCode } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs mapped error on generateImage failure", async () => {
    mockProviderKeys.gemini = "test-key";
    mockGenerateError = new Error("Connection timeout");

    const { exitCode, stdout } = await runCommand([
      "image-generation",
      "generate",
      "--prompt",
      "Test",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Connection timeout");
  });
});
