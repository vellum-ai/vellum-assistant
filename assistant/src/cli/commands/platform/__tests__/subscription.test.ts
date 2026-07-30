import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: {
    planId: "pro",
    status: "active",
    renewalDate: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    cancelAt: null,
    selectedCreditTier: "credits_50",
    package: { key: "super", name: "Super", version: 2, customized: false },
    entitlements: { managedEmail: true, phoneNumber: false },
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

describe("assistant platform subscription", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        planId: "pro",
        status: "active",
        renewalDate: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-08-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        cancelAt: null,
        selectedCreditTier: "credits_50",
        package: { key: "super", name: "Super", version: 2, customized: false },
        entitlements: { managedEmail: true, phoneNumber: false },
      },
    };
    process.exitCode = 0;
  });

  test("calls platform_subscription and emits plan JSON with --json", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "assistant",
        "platform",
        "subscription",
        "--json",
      ]);
    });

    expect(mockCalls[0][0]).toBe("platform_subscription");

    const parsed = JSON.parse(out.join(""));
    expect(parsed.planId).toBe("pro");
    expect(parsed.status).toBe("active");
    expect(parsed.package.name).toBe("Super");
    expect(parsed.entitlements.managedEmail).toBe(true);
  });

  test("plain text mode does not emit JSON to stdout", async () => {
    const out = await captureStdout(async () => {
      const program = buildProgram();
      await program.parseAsync([
        "node",
        "assistant",
        "platform",
        "subscription",
      ]);
    });

    // Plain-text mode logs via log.info — verify writeOutput (JSON) was NOT called
    expect(() => JSON.parse(out.join("").trim())).toThrow();
  });
});
