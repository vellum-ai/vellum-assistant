import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = { ok: true, result: { showPlatformLogin: true } };

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

const { registerPlatformConnectCommand } = await import("../connect.js");
const { applyCommandHelp } = await import("../../../lib/cli-command-help.js");
const { platformHelp } = await import("../index.help.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  applyCommandHelp(program, platformHelp);
  registerPlatformConnectCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform connect", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = { ok: true, result: { showPlatformLogin: true } };
    process.exitCode = 0;
  });

  test("calls platform_connect and reports login UI triggered", async () => {
    const program = buildProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(["node", "assistant", "connect", "--json"]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockCalls.length).toBe(1);
    expect(mockCalls[0][0]).toBe("platform_connect");

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.showPlatformLogin).toBe(true);
  });

  test("already connected returns success with existing base URL", async () => {
    mockResponse = {
      ok: true,
      result: {
        alreadyConnected: true,
        baseUrl: "https://platform.vellum.ai",
      },
    };

    const program = buildProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(["node", "assistant", "connect", "--json"]);
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.alreadyConnected).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
  });

  test("calls exitFromIpcResult on error", async () => {
    mockResponse = {
      ok: false,
      error: "Could not connect to the assistant",
      statusCode: undefined,
    };
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "assistant", "connect", "--json"]),
    ).rejects.toThrow("exitFromIpcResult called");
  });
});
