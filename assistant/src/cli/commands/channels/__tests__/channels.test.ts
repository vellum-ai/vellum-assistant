import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown> | undefined]> = [];
let mockResponses: unknown[] = [];

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponses.shift() ?? { ok: true, result: { success: true } };
  },
  exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
    throw new Error("exitFromIpcResult called");
  },
}));

const { registerChannelsCommand } = await import("../index.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerChannelsCommand(program);
  return program;
}

async function runCli(...argv: string[]): Promise<string> {
  const stdoutChunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildProgram().parseAsync(["node", "assistant", ...argv]);
  } finally {
    process.stdout.write = origWrite;
  }
  return stdoutChunks.join("");
}

function emptySnapshot(channel: string, overrides: Record<string, unknown> = {}) {
  return {
    channel,
    ready: false,
    setupStatus: "not_configured",
    checkedAt: 0,
    stale: false,
    reasons: [],
    localChecks: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant channels", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponses = [];
    process.exitCode = 0;
  });

  describe("list", () => {
    test("calls channels_readiness_get with includeRemote=false by default", async () => {
      mockResponses = [
        { ok: true, result: { success: true, snapshots: [] } },
      ];
      await runCli("channels", "list", "--json");
      expect(mockCalls).toHaveLength(1);
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "false" },
      });
    });

    test("--remote flips includeRemote to true (still GET, still cached)", async () => {
      mockResponses = [
        { ok: true, result: { success: true, snapshots: [] } },
      ];
      await runCli("channels", "list", "--remote", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "true" },
      });
    });
  });

  describe("get", () => {
    test("always re-probes via the refresh route (live, never cached)", async () => {
      mockResponses = [
        {
          ok: true,
          result: {
            success: true,
            snapshots: [emptySnapshot("slack")],
          },
        },
      ];
      await runCli("channels", "get", "slack", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_refresh_post");
      expect(mockCalls[0][1]).toEqual({
        body: { channel: "slack", includeRemote: true },
      });
    });

    test("requires a channel argument", async () => {
      // commander throws via exitOverride when arg is missing
      await expect(runCli("channels", "get")).rejects.toThrow();
      expect(mockCalls).toHaveLength(0);
    });

    test("exits non-zero when channel has no registered probe", async () => {
      mockResponses = [
        { ok: true, result: { success: true, snapshots: [] } },
      ];
      await runCli("channels", "get", "nope", "--json");
      expect(process.exitCode).toBe(1);
    });

    test("does NOT accept --refresh flag (every get is live)", async () => {
      // commander rejects unknown options via exitOverride
      await expect(
        runCli("channels", "get", "slack", "--refresh"),
      ).rejects.toThrow();
    });
  });

  describe("refresh", () => {
    test("is not registered (mutating verb deferred to its own PR)", async () => {
      // commander throws via exitOverride for unknown subcommands
      await expect(
        runCli("channels", "refresh", "slack"),
      ).rejects.toThrow();
    });
  });
});
