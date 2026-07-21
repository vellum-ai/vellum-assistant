/**
 * Tests for `assistant inference models list` CLI arg parsing / IPC wiring.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: any } | null = null;
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: { models: [] },
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

const { attachModelsSubcommand } = await import("../inference-models.js");
const { applyCommandHelp } = await import("../../lib/cli-command-help.js");
const { inferenceHelp } = await import("../inference.help.js");

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { models: [] } };
  process.exitCode = 0;
});

async function run(args: string[]): Promise<string> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const program = new Command();
    program.exitOverride();
    const inference = program.command("inference");
    applyCommandHelp(inference, inferenceHelp);
    attachModelsSubcommand(inference);
    await program.parseAsync(["node", "assistant", "inference", ...args]);
  } catch {
    // swallow commander exits
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

describe("models list", () => {
  test("no filter → empty queryParams", async () => {
    await run(["models", "list"]);
    expect(lastIpcCall?.method).toBe("inference_models_list");
    expect(lastIpcCall?.params).toEqual({ queryParams: {} });
  });

  test("--provider forwards the filter", async () => {
    await run(["models", "list", "--provider", "anthropic"]);
    expect(lastIpcCall?.params).toEqual({
      queryParams: { provider: "anthropic" },
    });
  });

  test("--json emits structured output", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        models: [
          { provider: "anthropic", id: "claude-opus-4-8", displayName: "X" },
        ],
      },
    };
    const out = await run(["models", "list", "--json"]);
    const parsed = JSON.parse(out.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.models[0].id).toBe("claude-opus-4-8");
  });
});
