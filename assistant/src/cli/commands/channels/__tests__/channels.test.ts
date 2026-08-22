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

function emptySnapshot(
  channel: string,
  overrides: Record<string, unknown> = {},
) {
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
      mockResponses = [{ ok: true, result: { success: true, snapshots: [] } }];
      await runCli("channels", "list", "--json");
      expect(mockCalls).toHaveLength(1);
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "false" },
      });
    });

    test("--remote flips includeRemote to true (still GET, still cached)", async () => {
      mockResponses = [{ ok: true, result: { success: true, snapshots: [] } }];
      await runCli("channels", "list", "--remote", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "true" },
      });
    });
  });

  describe("two-axis rendering", () => {
    /**
     * A configured channel whose delivery stopped is the state this command
     * used to have no word for. Setup is finished, so telling the reader to
     * finish setup sends them to re-enter credentials that are already
     * correct, and the operational reason for the outage is the only thing
     * they can act on.
     */
    const configuredButDown = (health: string) =>
      emptySnapshot("slack", {
        ready: false,
        setupStatus: "ready",
        health,
        localChecks: [
          {
            name: "inbound_delivery",
            passed: health !== "failing",
            kind: "operational",
            message: "Slack Socket Mode holds no live connection",
          },
        ],
      });

    test("list calls a configured channel that stopped delivering down, not unfinished", async () => {
      mockResponses = [
        {
          ok: true,
          result: { success: true, snapshots: [configuredButDown("failing")] },
        },
      ];
      const out = await runCli("channels", "list");
      expect(out).toContain("not delivering");
      expect(out).not.toContain("incomplete");
      expect(out).not.toContain("not configured");
    });

    test("list distinguishes a verdict it could not obtain from an outage", async () => {
      mockResponses = [
        {
          ok: true,
          result: { success: true, snapshots: [configuredButDown("unknown")] },
        },
      ];
      const out = await runCli("channels", "list");
      expect(out).toContain("state unknown");
      expect(out).not.toContain("not delivering");
      expect(out).not.toContain("incomplete");
    });

    test("setup that genuinely did not finish still reads incomplete", async () => {
      // The sensitivity check on the two above: the word has to survive for
      // the state it was always correct for.
      mockResponses = [
        {
          ok: true,
          result: {
            success: true,
            snapshots: [
              emptySnapshot("slack", {
                ready: false,
                setupStatus: "incomplete",
              }),
            ],
          },
        },
      ];
      const out = await runCli("channels", "list");
      expect(out).toContain("incomplete");
    });

    test("the detail header agrees with its own glyph", async () => {
      // It used to print the raw setupStatus beside a glyph derived from both
      // axes, so an outage rendered as a warning sign next to the word ready.
      mockResponses = [
        {
          ok: true,
          result: { success: true, snapshots: [configuredButDown("failing")] },
        },
      ];
      const out = await runCli("channels", "get", "slack");
      expect(out).toContain("slack — not delivering");
      expect(out).not.toContain("slack — ready");
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
      mockResponses = [{ ok: true, result: { success: true, snapshots: [] } }];
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
      await expect(runCli("channels", "refresh", "slack")).rejects.toThrow();
    });
  });
});
