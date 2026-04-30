import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

const logLines: string[] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (message: string) => logLines.push(message),
    warn: (message: string) => logLines.push(message),
    error: (message: string) => logLines.push(message),
    debug: () => {},
  }),
}));

const { initializeDb } = await import("../memory/db-init.js");
const { getDb } = await import("../memory/db-connection.js");
const { recordUsageEvent } = await import("../memory/llm-usage-store.js");
const { registerUsageCommand } = await import("../cli/commands/usage.js");

initializeDb();

async function runCommand(args: string[]): Promise<{
  exitCode: number;
  output: string;
}> {
  process.exitCode = 0;
  logLines.length = 0;
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    process.exitCode = code ?? 0;
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;

  try {
    const program = new Command();
    program.exitOverride();
    registerUsageCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.exit = originalExit;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode, output: logLines.join("\n") };
}

function insertUsage(
  overrides: Partial<Parameters<typeof recordUsageEvent>[0]>,
  estimatedCostUsd = 0.01,
): void {
  recordUsageEvent(
    {
      conversationId: null,
      runId: null,
      requestId: null,
      actor: "main_agent",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      ...overrides,
    },
    { estimatedCostUsd, pricingStatus: "priced" },
  );
}

describe("assistant usage CLI", () => {
  beforeEach(() => {
    logLines.length = 0;
    getDb().run("DELETE FROM llm_usage_events");
  });

  test("breakdown JSON includes call-site display labels and groupKey", async () => {
    insertUsage({ callSite: "mainAgent" });
    insertUsage({ callSite: null, inputTokens: 200 }, 0.005);

    const result = await runCommand([
      "usage",
      "breakdown",
      "--range",
      "all",
      "--group-by",
      "call_site",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as {
      breakdown: Array<{ group: string; groupKey: string | null }>;
    };
    expect(parsed.breakdown.map((row) => row.group)).toEqual([
      "Main agent",
      "Unknown Task",
    ]);
    expect(parsed.breakdown.map((row) => row.groupKey)).toEqual([
      "mainAgent",
      null,
    ]);
  });

  test("breakdown table prints friendly profile fallback labels", async () => {
    insertUsage({ inferenceProfile: null });

    const result = await runCommand([
      "usage",
      "breakdown",
      "--range",
      "all",
      "--group-by",
      "inference_profile",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("PROFILE");
    expect(result.output).toContain("Default / Unset");
  });

  test("rejects invalid breakdown dimensions", async () => {
    const result = await runCommand([
      "usage",
      "breakdown",
      "--group-by",
      "invalid",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Invalid --group-by value");
    expect(result.output).toContain("call_site");
    expect(result.output).toContain("inference_profile");
  });
});
