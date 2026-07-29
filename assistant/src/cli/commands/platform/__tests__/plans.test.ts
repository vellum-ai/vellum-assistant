import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: {
    plans: [
      {
        id: "base",
        name: "Base",
        price_cents: 0,
        billing_interval: "month",
        included_features: ["Pay-as-you-go credits"],
      },
      {
        id: "pro",
        name: "Pro",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: ["Configurable machine size"],
      },
    ],
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

describe("assistant platform plans", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        plans: [
          {
            id: "base",
            name: "Base",
            price_cents: 0,
            billing_interval: "month",
            included_features: ["Pay-as-you-go credits"],
          },
          {
            id: "pro",
            name: "Pro",
            base_price_cents: 2000,
            billing_interval: "month",
            included_features: ["Configurable machine size"],
          },
        ],
      },
    };
    process.exitCode = 0;
  });

  test("calls platform_plans and emits catalog JSON with --json", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "assistant",
        "platform",
        "plans",
        "--json",
      ]);
    });

    expect(mockCalls[0][0]).toBe("platform_plans");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.plans[0].id).toBe("base");
    expect(parsed.plans[1].base_price_cents).toBe(2000);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync(["node", "assistant", "platform", "plans"]);
    });

    // Plain-text mode logs via log.info — verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
