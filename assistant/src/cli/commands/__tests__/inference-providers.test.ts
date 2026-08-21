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
let openedUrls: string[] = [];
let storedSecrets: Array<{ key: string; value: string }> = [];
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

mock.module("../../lib/open-browser.js", () => ({
  openInHostBrowser: (url: string) => {
    openedUrls.push(url);
  },
}));

mock.module("../../../security/oauth2.js", () => ({
  startOAuth2Flow: async (
    _config: unknown,
    callbacks: { openUrl: (url: string) => void },
  ) => {
    callbacks.openUrl("https://auth.openai.com/oauth/authorize?state=test");
    return {
      tokens: {
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresIn: 3600,
      },
    };
  },
}));

mock.module("../../../security/secure-keys.js", () => ({
  setSecureKeyAsync: async (key: string, value: string) => {
    storedSecrets.push({ key, value });
    return true;
  },
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
  openedUrls = [];
  storedSecrets = [];
  mockIpcResult = { ok: true, result: CONNECTION_RESULT };
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrorWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  const errorChunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errorChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

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
    process.stderr.write = originalErrorWrite;
  }
  const stdout = chunks.join("");
  const stderr = errorChunks.join("");
  const exitCode = (process.exitCode as number) ?? 0;
  process.exitCode = prevExit;
  return { stdout, stderr, exitCode };
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

  test("forwards optional --base-url for ollama create", async () => {
    await run([
      "providers",
      "create",
      "ollama-home",
      "--provider",
      "ollama",
      "--base-url",
      "http://192.168.1.50:11434/v1",
    ]);
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "ollama-home",
      provider: "ollama",
      auth: { type: "none" },
      base_url: "http://192.168.1.50:11434/v1",
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

  test("openai-compatible without --credential derives none auth (local endpoints)", async () => {
    await run([
      "providers",
      "create",
      "local-llm",
      "--provider",
      "openai-compatible",
      "--base-url",
      "http://localhost:1234/v1",
      "--model",
      "model-a",
    ]);
    expect(lastIpcCall()?.params?.body).toEqual({
      name: "local-llm",
      provider: "openai-compatible",
      auth: { type: "none" },
      base_url: "http://localhost:1234/v1",
      models: [{ id: "model-a" }],
    });
  });

  test("openai-compatible with --credential derives api_key auth", async () => {
    await run([
      "providers",
      "create",
      "hosted-llm",
      "--provider",
      "openai-compatible",
      "--credential",
      "credential/hosted/key",
      "--base-url",
      "https://api.example.com/v1",
      "--model",
      "model-a",
    ]);
    expect(lastIpcCall()?.params?.body).toMatchObject({
      auth: { type: "api_key", credential: "credential/hosted/key" },
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
    mockIpcResult = {
      ok: true,
      result: {
        ...CONNECTION_RESULT,
        name: "anthropic-personal",
        provider: "anthropic",
        auth: { type: "api_key", credential: "credential/anthropic/old_key" },
      },
    };
    await run([
      "providers",
      "update",
      "anthropic-personal",
      "--credential",
      "credential/anthropic/new_key",
    ]);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "inference_provider_connections_get",
      "inference_provider_connections_update",
    ]);
    expect(lastIpcCall()?.params).toEqual({
      pathParams: { name: "anthropic-personal" },
      body: {
        auth: { type: "api_key", credential: "credential/anthropic/new_key" },
      },
    });
  });

  test("a bare --credential refuses to rotate subscription auth", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ...CONNECTION_RESULT,
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
      },
    };
    const { exitCode } = await run([
      "providers",
      "update",
      "chatgpt-subscription",
      "--credential",
      "credential/other",
    ]);
    expect(exitCode).toBe(1);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "inference_provider_connections_get",
    ]);
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

  test("ollama update forwards --base-url after GET", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ...CONNECTION_RESULT,
        name: "ollama",
        provider: "ollama",
        auth: { type: "none" },
      },
    };
    await run([
      "providers",
      "update",
      "ollama",
      "--base-url",
      "http://192.168.1.50:11434/v1",
    ]);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "inference_provider_connections_get",
      "inference_provider_connections_update",
    ]);
    expect(lastIpcCall()?.params).toEqual({
      pathParams: { name: "ollama" },
      body: {
        auth: { type: "none" },
        base_url: "http://192.168.1.50:11434/v1",
      },
    });
  });
});

describe("providers get output", () => {
  test("prints base_url when the connection stores one", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        name: "ollama",
        provider: "ollama",
        auth: { type: "none" },
        baseUrl: "http://192.168.1.50:11434/v1",
        createdAt: 0,
        updatedAt: 0,
      },
    };
    const { stdout } = await run(["providers", "get", "ollama"]);
    expect(stdout).toContain("name:     ollama");
    expect(stdout).toContain("provider: ollama");
    expect(stdout).toContain("base_url: http://192.168.1.50:11434/v1");
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

  test("bare `providers` runs list", async () => {
    mockIpcResult = { ok: true, result: { connections: [] } };
    const { exitCode } = await run(["providers"]);
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_list");
    expect(exitCode).toBe(0);
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

describe("providers login-chatgpt", () => {
  test("delivers the authorization URL through the browser helper and stderr", async () => {
    const { stdout, stderr, exitCode } = await run([
      "providers",
      "login-chatgpt",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(stderr).toContain(
      "https://auth.openai.com/oauth/authorize?state=test",
    );
    expect(openedUrls).toEqual([
      "https://auth.openai.com/oauth/authorize?state=test",
    ]);
    expect(storedSecrets).toContainEqual({
      key: "credential/chatgpt/access_token",
      value: "test-access-token",
    });
    expect(lastIpcCall()?.method).toBe("inference_provider_connections_update");
  });
});
