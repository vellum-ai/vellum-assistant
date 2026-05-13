import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = { ok: true, result: { routes: [] } };

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

describe("assistant platform callback-routes list", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = { ok: true, result: { routes: [] } };
    process.exitCode = 0;
  });

  test("returns empty list when no routes registered", async () => {
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
        "callback-routes",
        "list",
        "--json",
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockCalls[0][0]).toBe("platform_callback_routes_list");

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toEqual([]);
  });

  test("returns registered routes", async () => {
    const routes = [
      {
        id: "route-1",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "email",
        callback_path: "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/email/",
      },
      {
        id: "route-2",
        assistant_id: "019d6d4f-6dbd-779f-91d3-cb273b9429a5",
        type: "telegram",
        callback_path:
          "019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram",
        callback_url:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/019d6d4f-6dbd-779f-91d3-cb273b9429a5/webhooks/telegram/",
      },
    ];
    mockResponse = { ok: true, result: { routes } };

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
        "callback-routes",
        "list",
        "--json",
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0].type).toBe("email");
    expect(parsed.routes[1].type).toBe("telegram");
  });

  test("fails when platform credentials are missing", async () => {
    mockResponse = {
      ok: false,
      error: "Platform credentials not available",
      statusCode: 422,
    };

    const program = buildProgram();
    await expect(
      program.parseAsync([
        "node",
        "assistant",
        "platform",
        "callback-routes",
        "list",
        "--json",
      ]),
    ).rejects.toThrow("exitFromIpcResult called");
  });

  test("callback-routes register calls platform_callback_routes_register", async () => {
    mockResponse = {
      ok: true,
      result: {
        callbackUrl:
          "https://dev-platform.vellum.ai/v1/gateway/callbacks/asst/webhooks/telegram/",
        callbackPath: "webhooks/telegram",
        type: "telegram",
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
        "callback-routes",
        "register",
        "--path",
        "webhooks/telegram",
        "--type",
        "telegram",
        "--json",
      ]);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(mockCalls[0][0]).toBe("platform_callback_routes_register");
    expect(
      (mockCalls[0][1].body as Record<string, unknown>).path,
    ).toBe("webhooks/telegram");
    expect(
      (mockCalls[0][1].body as Record<string, unknown>).type,
    ).toBe("telegram");

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.callbackPath).toBe("webhooks/telegram");
  });
});
