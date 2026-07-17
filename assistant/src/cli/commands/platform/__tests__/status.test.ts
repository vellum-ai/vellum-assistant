import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: {
    isPlatform: false,
    baseUrl: "",
    assistantId: "",
    hasAssistantApiKey: false,
    hasWebhookSecret: false,
    available: false,
    organizationId: null,
    userId: null,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant platform status", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        isPlatform: false,
        baseUrl: "",
        assistantId: "",
        hasAssistantApiKey: false,
        hasWebhookSecret: false,
        available: false,
        organizationId: null,
        userId: null,
      },
    };
    process.exitCode = 0;
  });

  test("platform pod returns full status from context", async () => {
    mockResponse = {
      ok: true,
      result: {
        isPlatform: true,
        baseUrl: "https://platform.vellum.ai",
        assistantId: "asst-abc-123",
        hasAssistantApiKey: true,
        hasWebhookSecret: true,
        available: true,
        organizationId: "org-456",
        userId: "user-789",
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
      await program.parseAsync([
        "node",
        "assistant",
        "platform",
        "status",
        "--json",
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockCalls[0][0]).toBe("platform_status");

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.isPlatform).toBe(true);
    expect(parsed.baseUrl).toBe("https://platform.vellum.ai");
    expect(parsed.assistantId).toBe("asst-abc-123");
    expect(parsed.hasAssistantApiKey).toBe(true);
    expect(parsed.hasWebhookSecret).toBe(true);
    expect(parsed.available).toBe(true);
    expect(parsed.organizationId).toBe("org-456");
    expect(parsed.userId).toBe("user-789");
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const program = buildProgram();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(["node", "assistant", "platform", "status"]);
    } finally {
      process.stdout.write = origWrite;
    }

    // Plain-text mode logs via log.info — verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(stdoutChunks.join("").trim())).toThrow();
  });
});
