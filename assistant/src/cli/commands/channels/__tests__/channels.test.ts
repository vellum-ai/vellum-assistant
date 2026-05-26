import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown> | undefined]> = [];
let mockResponse: unknown = {
  ok: true,
  result: { success: true, snapshots: [] },
};

mock.module("../../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponse;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant channels", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: { success: true, snapshots: [] },
    };
    process.exitCode = 0;
  });

  describe("list", () => {
    test("calls channels_readiness_get with includeRemote=false by default", async () => {
      await runCli("channels", "list", "--json");
      expect(mockCalls).toHaveLength(1);
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "false" },
      });
    });

    test("--remote flips includeRemote to true", async () => {
      await runCli("channels", "list", "--remote", "--json");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { includeRemote: "true" },
      });
    });

    test("emits JSON snapshots when --json is set", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          snapshots: [
            {
              channel: "slack",
              ready: true,
              setupStatus: "ready",
              checkedAt: 0,
              stale: false,
              reasons: [],
              localChecks: [],
            },
          ],
        },
      };
      const out = await runCli("channels", "list", "--json");
      const parsed = JSON.parse(out);
      expect(parsed.snapshots[0].channel).toBe("slack");
    });
  });

  describe("status", () => {
    test("default reads cached snapshot via GET", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          snapshots: [
            {
              channel: "slack",
              ready: false,
              setupStatus: "not_configured",
              checkedAt: 0,
              stale: false,
              reasons: [],
              localChecks: [],
            },
          ],
        },
      };
      await runCli("channels", "status", "slack", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_get");
      expect(mockCalls[0][1]).toEqual({
        queryParams: { channel: "slack", includeRemote: "true" },
      });
    });

    test("--refresh invalidates cache via POST", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          snapshots: [
            {
              channel: "slack",
              ready: true,
              setupStatus: "ready",
              checkedAt: 0,
              stale: false,
              reasons: [],
              localChecks: [],
            },
          ],
        },
      };
      await runCli("channels", "status", "slack", "--refresh", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_refresh_post");
      expect(mockCalls[0][1]).toEqual({
        body: { channel: "slack", includeRemote: true },
      });
    });

    test("exits non-zero when channel is unknown", async () => {
      mockResponse = {
        ok: true,
        result: { success: true, snapshots: [] },
      };
      await runCli("channels", "status", "nope", "--json");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("refresh", () => {
    test("refreshes all channels when no argument is passed", async () => {
      await runCli("channels", "refresh", "--json");
      expect(mockCalls[0][0]).toBe("channels_readiness_refresh_post");
      expect(mockCalls[0][1]).toEqual({
        body: { includeRemote: true },
      });
    });

    test("refreshes a single channel when argument is passed", async () => {
      await runCli("channels", "refresh", "slack", "--json");
      expect(mockCalls[0][1]).toEqual({
        body: { includeRemote: true, channel: "slack" },
      });
    });
  });

  describe("slack status", () => {
    test("calls the slack config GET handler", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          hasBotToken: true,
          hasAppToken: true,
          hasUserToken: false,
          connected: true,
          teamId: "T123",
          teamName: "acme",
        },
      };
      await runCli("channels", "slack", "status", "--json");
      expect(mockCalls[0][0]).toBe("integrations_slack_channel_config_get");
    });
  });

  describe("slack reconnect", () => {
    test("requires at least one token", async () => {
      await runCli("channels", "slack", "reconnect", "--json");
      expect(process.exitCode).toBe(1);
      expect(mockCalls).toHaveLength(0);
    });

    test("passes provided tokens through to the POST handler", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          hasBotToken: true,
          hasAppToken: true,
          hasUserToken: false,
          connected: true,
        },
      };
      await runCli(
        "channels",
        "slack",
        "reconnect",
        "--bot-token",
        "xoxb-test",
        "--app-token",
        "xapp-test",
        "--json",
      );
      expect(mockCalls[0][0]).toBe("integrations_slack_channel_config_post");
      expect(mockCalls[0][1]).toEqual({
        body: { botToken: "xoxb-test", appToken: "xapp-test" },
      });
    });

    test("includes user_token when provided", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          hasBotToken: true,
          hasAppToken: false,
          hasUserToken: true,
          connected: true,
        },
      };
      await runCli(
        "channels",
        "slack",
        "reconnect",
        "--bot-token",
        "xoxb-test",
        "--user-token",
        "xoxp-test",
        "--json",
      );
      expect(mockCalls[0][1]).toEqual({
        body: { botToken: "xoxb-test", userToken: "xoxp-test" },
      });
    });
  });

  describe("slack clear", () => {
    test("calls the slack config DELETE handler", async () => {
      mockResponse = {
        ok: true,
        result: {
          success: true,
          hasBotToken: false,
          hasAppToken: false,
          hasUserToken: false,
          connected: false,
        },
      };
      await runCli("channels", "slack", "clear", "--json");
      expect(mockCalls[0][0]).toBe("integrations_slack_channel_config_delete");
    });
  });
});
