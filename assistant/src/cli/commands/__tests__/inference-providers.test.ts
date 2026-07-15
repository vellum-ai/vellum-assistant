/**
 * Tests for `assistant inference providers` CLI arg parsing / IPC wiring —
 * the provider-first verbs (auth derived from the provider, explicit --auth
 * as an override), the openai-compatible `--base-url` / `--model` flags that
 * forward to the connection route's `base_url` + `models` fields, and the
 * deprecated `providers connections` alias.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let ipcCalls: { method: string; params?: any }[] = [];
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {},
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
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
const { applyCommandHelp } = await import("../../lib/cli-command-help.js");
const { inferenceHelp } = await import("../inference.help.js");

const CONNECTION_RESULT = {
  name: "local-llm",
  provider: "openai-compatible",
  auth: { type: "none" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function lastIpcCall(): { method: string; params?: any } | null {
  return ipcCalls[ipcCalls.length - 1] ?? null;
}

beforeEach(() => {
  ipcCalls = [];
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
    applyCommandHelp(inference, inferenceHelp);
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

describe("providers create — derived auth", () => {
  test("derives api_key auth from --credential for a keyed provider", async () => {
    await run([
      "providers",
      "create",
      "anthropic-personal",
      "--provider",
      "anthropic",
      "--credential",
      "credential/anthropic/api_key",
    ]);
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_create");
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
  });

  test("derives none auth for a keyless provider (ollama)", async () => {
    await run([
      "providers",
      "create",
      "ollama-personal",
      "--provider",
      "ollama",
    ]);
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "ollama-personal",
      provider: "ollama",
      auth: { type: "none" },
    });
  });

  test("rejects a keyed provider without --credential before calling the daemon", async () => {
    const { exitCode } = await run([
      "providers",
      "create",
      "anthropic-personal",
      "--provider",
      "anthropic",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall()).toBeNull();
  });

  test("an explicit --auth override wins over derivation", async () => {
    await run([
      "providers",
      "create",
      "managed-anthropic",
      "--provider",
      "anthropic",
      "--auth",
      "platform",
    ]);
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "managed-anthropic",
      provider: "anthropic",
      auth: { type: "platform" },
    });
  });
});

describe("providers create — openai-compatible", () => {
  test("forwards base_url and collected --model list to the route", async () => {
    await run([
      "providers",
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
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_create");
    expect(lastIpcCall()?.params?.body).toEqual({
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
    expect(lastIpcCall()).toBeNull();
  });
});

describe("providers update", () => {
  test("a bare --credential rotates via derived api_key auth", async () => {
    await run([
      "providers",
      "update",
      "anthropic-personal",
      "--credential",
      "credential/anthropic/new_key",
    ]);
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_update");
    expect(lastIpcCall()?.params).toEqual({
      pathParams: { name: "anthropic-personal" },
      body: {
        auth: { type: "api_key", credential: "credential/anthropic/new_key" },
      },
    });
  });

  test("with no auth flags, re-sends the stored auth (GET first)", async () => {
    await run([
      "providers",
      "update",
      "local-llm",
      "--base-url",
      "http://localhost:5678/v1",
      "--model",
      "model-c",
    ]);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "inference_provider_connections_get",
      "inference_provider_connections_update",
    ]);
    expect(lastIpcCall()?.params).toEqual({
      pathParams: { name: "local-llm" },
      body: {
        auth: { type: "none" },
        base_url: "http://localhost:5678/v1",
        models: [{ id: "model-c" }],
      },
    });
  });

  test("an explicit --auth override forwards verbatim", async () => {
    await run([
      "providers",
      "update",
      "local-llm",
      "--auth",
      "none",
      "--base-url",
      "http://localhost:5678/v1",
    ]);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "inference_provider_connections_update",
    ]);
    expect(lastIpcCall()?.params?.body).toEqual({
      auth: { type: "none" },
      base_url: "http://localhost:5678/v1",
    });
  });
});

describe("providers list output", () => {
  test("shows providers without auth details", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        connections: [
          {
            name: "vellum",
            provider: "vellum",
            auth: { type: "platform" },
          },
          {
            name: "anthropic-personal",
            provider: "anthropic",
            auth: { type: "api_key", credential: "credential/anthropic/x" },
          },
        ],
      },
    };
    const { stdout } = await run(["providers", "list"]);
    expect(stdout).toContain("vellum  provider=vellum");
    expect(stdout).toContain("anthropic-personal  provider=anthropic");
    expect(stdout).not.toContain("auth=");
    expect(stdout).not.toContain("api_key");
  });

  test("--json output keeps the full wire shape including auth", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        connections: [
          {
            name: "anthropic-personal",
            provider: "anthropic",
            auth: { type: "api_key", credential: "credential/anthropic/x" },
          },
        ],
      },
    };
    const { stdout } = await run(["providers", "list", "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.connections[0].auth).toEqual({
      type: "api_key",
      credential: "credential/anthropic/x",
    });
  });
});

describe("deprecated providers connections alias", () => {
  test("connections create still forwards to the same route", async () => {
    await run([
      "providers",
      "connections",
      "create",
      "anthropic-personal",
      "--provider",
      "anthropic",
      "--credential",
      "credential/anthropic/api_key",
    ]);
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_create");
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
  });

  test("connections list forwards to the same route", async () => {
    mockIpcResult = { ok: true, result: { connections: [] } };
    const { stdout } = await run(["providers", "connections", "list"]);
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_list");
    expect(stdout).toContain("No providers found.");
  });
});
