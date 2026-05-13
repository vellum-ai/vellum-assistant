import { beforeEach, describe, expect, it, mock } from "bun:test";

import { Command } from "commander";

// State for mock
let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: { images: [], resolvedModel: "gemini-3.1-flash-image-preview" },
};

// Mock BEFORE importing the command module
mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponse;
  },
  exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
    throw new Error(`exitFromIpcResult called`);
  },
}));

// Also mock the logger to suppress output
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

// We can set outputDir via --output-dir to avoid needing to mock os.tmpdir
const TEST_OUTPUT_DIR = "/tmp/test-image-gen";

const { registerImageGenerationCommand } = await import("../image-generation.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit
  registerImageGenerationCommand(program);
  return program;
}

describe("image-generation generate", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: { images: [], resolvedModel: "gemini-3.1-flash-image-preview" },
    };
    process.exitCode = 0;
  });

  it("calls image_generation_generate with prompt and mode defaults", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "image-generation",
      "generate",
      "--prompt",
      "A cat",
      "--output-dir",
      TEST_OUTPUT_DIR,
    ]);
    expect(mockCalls.length).toBe(1);
    expect(mockCalls[0][0]).toBe("image_generation_generate");
    const body = mockCalls[0][1].body as Record<string, unknown>;
    expect(body.prompt).toBe("A cat");
    expect(body.mode).toBe("generate");
    expect(body.variants).toBe(1);
  });

  it("does not call IPC when edit mode has no --source", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "image-generation",
      "generate",
      "--prompt",
      "P",
      "--mode",
      "edit",
      "--output-dir",
      TEST_OUTPUT_DIR,
    ]);
    expect(mockCalls.length).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it("passes model override", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "image-generation",
      "generate",
      "--prompt",
      "P",
      "--model",
      "gpt-image-2",
      "--output-dir",
      TEST_OUTPUT_DIR,
    ]);
    expect((mockCalls[0][1].body as Record<string, unknown>).model).toBe("gpt-image-2");
  });

  it("passes variants", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "image-generation",
      "generate",
      "--prompt",
      "P",
      "--variants",
      "3",
      "--output-dir",
      TEST_OUTPUT_DIR,
    ]);
    expect((mockCalls[0][1].body as Record<string, unknown>).variants).toBe(3);
  });

  it("calls exitFromIpcResult on daemon error", async () => {
    mockResponse = { ok: false, error: "no creds", statusCode: 422 };
    const program = buildProgram();
    await expect(
      program.parseAsync([
        "node",
        "assistant",
        "image-generation",
        "generate",
        "--prompt",
        "P",
        "--output-dir",
        TEST_OUTPUT_DIR,
      ]),
    ).rejects.toThrow("exitFromIpcResult called");
  });
});
