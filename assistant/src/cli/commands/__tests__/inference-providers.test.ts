/**
 * Tests for `assistant inference providers connections` CLI arg parsing / IPC
 * wiring — focused on the openai-compatible `--base-url` / `--model` flags that
 * forward to the connection route's `base_url` + `models` fields.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let lastIpcCall: { method: string; params?: any } | null = null;
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {},
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

const { attachProvidersSubcommand } = await import("../inference-providers.js");

const CONNECTION_RESULT = {
  name: "local-llm",
  provider: "openai-compatible",
  auth: { type: "none" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: CONNECTION_RESULT };
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

async function run(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    const inference = program.command("inference");
    attachProvidersSubcommand(inference);
    await program.parseAsync(["node", "assistant", "inference", ...args]);
  } catch {
    // swallow commander exits
  } finally {
    process.stdout.write = originalWrite;
  }
  const stdout = chunks.join("");
  const exitCode = (process.exitCode as number) ?? 0;
  process.exitCode = prevExit;
  return { stdout, exitCode };
}

describe("providers connections create — openai-compatible", () => {
  test("forwards base_url and collected --model list to the route", async () => {
    await run([
      "providers",
      "connections",
      "create",
      "local-llm",
      "--provider",
      "openai-compatible",
      "--auth",
      "none",
      "--base-url",
      "http://localhost:1234/v1",
      "--model",
      "model-a",
      "--model",
      "model-b",
    ]);
    expect(lastIpcCall?.method).toBe("inference_provider_connections_create");
    expect(lastIpcCall?.params?.body).toEqual({
      name: "local-llm",
      provider: "openai-compatible",
      auth: { type: "none" },
      base_url: "http://localhost:1234/v1",
      models: [{ id: "model-a" }, { id: "model-b" }],
    });
  });

  test("rejects openai-compatible without --base-url before calling the daemon", async () => {
    const { exitCode } = await run([
      "providers",
      "connections",
      "create",
      "local-llm",
      "--provider",
      "openai-compatible",
      "--auth",
      "none",
      "--model",
      "model-a",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("omits base_url/models for a standard provider", async () => {
    await run([
      "providers",
      "connections",
      "create",
      "anthropic-personal",
      "--provider",
      "anthropic",
      "--auth",
      "api_key",
      "--credential",
      "credential/anthropic/api_key",
    ]);
    expect(lastIpcCall?.params?.body).toEqual({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
  });
});

describe("providers connections update — openai-compatible", () => {
  test("forwards base_url and models alongside auth", async () => {
    mockIpcResult = { ok: true, result: CONNECTION_RESULT };
    await run([
      "providers",
      "connections",
      "update",
      "local-llm",
      "--auth",
      "none",
      "--base-url",
      "http://localhost:5678/v1",
      "--model",
      "model-c",
    ]);
    expect(lastIpcCall?.method).toBe("inference_provider_connections_update");
    expect(lastIpcCall?.params).toEqual({
      pathParams: { name: "local-llm" },
      body: {
        auth: { type: "none" },
        base_url: "http://localhost:5678/v1",
        models: [{ id: "model-c" }],
      },
    });
  });
});
