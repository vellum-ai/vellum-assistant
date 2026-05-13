import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: { disconnected: true, previousBaseUrl: "https://platform.vellum.ai" },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponse;
  },
  exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
    throw new Error("exitFromIpcResult called");
  },
}));

const { registerPlatformDisconnectCommand } = await import(
  "../disconnect.js"
);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "JSON output");
  registerPlatformDisconnectCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform disconnect", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        disconnected: true,
        previousBaseUrl: "https://platform.vellum.ai",
      },
    };
    process.exitCode = 0;
  });

  test("calls platform_disconnect and reports success", async () => {
    const program = buildProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(["node", "assistant", "disconnect", "--json"]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockCalls.length).toBe(1);
    expect(mockCalls[0][0]).toBe("platform_disconnect");

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.disconnected).toBe(true);
    expect(parsed.previousBaseUrl).toBe("https://platform.vellum.ai");
  });

  test("rejects with error when running on a platform-hosted assistant", async () => {
    mockResponse = {
      ok: false,
      error:
        "Cannot disconnect from the platform on a platform-hosted assistant.",
      statusCode: 422,
    };

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "assistant", "disconnect", "--json"]),
    ).rejects.toThrow("exitFromIpcResult called");
  });

  test("rejects when not connected", async () => {
    mockResponse = {
      ok: false,
      error:
        "Not connected to a platform. Nothing to disconnect.\n\nRun 'assistant platform status' to check connection state.",
      statusCode: 422,
    };

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "assistant", "disconnect", "--json"]),
    ).rejects.toThrow("exitFromIpcResult called");
  });
});
