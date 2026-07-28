import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: {
    remaining: 42.17,
    settled: 50,
    pending: 7.83,
    unit: "USD",
    stale: false,
    as_of: "2026-07-06T00:00:00.000Z",
  },
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

const { registerPlatformCommand } = await import("../index.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerPlatformCommand(program);
  return program;
}

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then(() => chunks)
    .finally(() => {
      process.stdout.write = origWrite;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform credits", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        remaining: 42.17,
        settled: 50,
        pending: 7.83,
        unit: "USD",
        stale: false,
        as_of: "2026-07-06T00:00:00.000Z",
      },
    };
    process.exitCode = 0;
  });

  test("calls platform_credits and emits balance JSON with --json", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "assistant",
        "platform",
        "credits",
        "--json",
      ]);
    });

    expect(mockCalls[0][0]).toBe("platform_credits");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.remaining).toBe(42.17);
    expect(parsed.settled).toBe(50);
    expect(parsed.pending).toBe(7.83);
    expect(parsed.unit).toBe("USD");
    expect(parsed.stale).toBe(false);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync(["node", "assistant", "platform", "credits"]);
    });

    // Plain-text mode logs via log.info — verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
