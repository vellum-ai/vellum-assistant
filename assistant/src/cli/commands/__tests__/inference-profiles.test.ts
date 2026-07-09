/**
 * Tests for `assistant inference profiles` CLI arg parsing / IPC wiring.
 *
 * Validates that flags map onto the correct IPC method + body, that create
 * requires --provider/--model, that --thinking parses to a boolean, and that
 * `active` reads via config_get and writes via config_patch.
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

const { attachProfilesSubcommand } = await import("../inference-profiles.js");

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
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
    attachProfilesSubcommand(inference);
    await program.parseAsync(["node", "assistant", "inference", ...args]);
  } catch (err: unknown) {
    if (!(err instanceof Error && err.message.startsWith("(outputHelp)"))) {
      // swallow commander exits
    }
  } finally {
    process.stdout.write = originalWrite;
  }
  const stdout = chunks.join("");
  const exitCode = (process.exitCode as number) ?? 0;
  process.exitCode = prevExit;
  return { stdout, exitCode };
}

describe("profiles list", () => {
  test("calls inference_profiles_list", async () => {
    mockIpcResult = { ok: true, result: { profiles: [] } };
    await run(["profiles", "list"]);
    expect(lastIpcCall?.method).toBe("inference_profiles_list");
  });
});

describe("profiles create", () => {
  test("requires --provider", async () => {
    const { exitCode } = await run(["profiles", "create", "p", "--model", "m"]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("requires --model", async () => {
    const { exitCode } = await run([
      "profiles",
      "create",
      "p",
      "--provider",
      "anthropic",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("maps flags onto the create body with thinking→boolean and numeric parse", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, name: "p", entry: {}, warnings: [] },
    };
    await run([
      "profiles",
      "create",
      "p",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-8",
      "--connection",
      "anthropic-personal",
      "--effort",
      "high",
      "--max-tokens",
      "8000",
      "--temperature",
      "0.5",
      "--thinking",
      "on",
      "--allow-unlisted",
    ]);
    expect(lastIpcCall?.method).toBe("inference_profiles_create");
    expect(lastIpcCall?.params?.body).toEqual({
      name: "p",
      provider: "anthropic",
      model: "claude-opus-4-8",
      connection: "anthropic-personal",
      effort: "high",
      maxTokens: 8000,
      temperature: 0.5,
      thinking: true,
      allowUnlisted: true,
    });
  });

  test("prints the verification hint on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, name: "p", entry: {}, warnings: [] },
    };
    const { stdout } = await run([
      "profiles",
      "create",
      "p",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-8",
    ]);
    expect(stdout).toContain("Verify it works:");
    expect(stdout).toContain("assistant inference send --profile p");
  });

  test("rejects a non-numeric --max-tokens before calling the daemon", async () => {
    const { exitCode } = await run([
      "profiles",
      "create",
      "p",
      "--provider",
      "anthropic",
      "--model",
      "m",
      "--max-tokens",
      "lots",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("rejects an invalid --thinking value", async () => {
    const { exitCode } = await run([
      "profiles",
      "create",
      "p",
      "--provider",
      "anthropic",
      "--model",
      "m",
      "--thinking",
      "maybe",
    ]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

describe("profiles update", () => {
  test("sends pathParams + partial body", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, name: "p", entry: {}, warnings: [] },
    };
    await run(["profiles", "update", "p", "--effort", "low"]);
    expect(lastIpcCall?.method).toBe("inference_profiles_update");
    expect(lastIpcCall?.params).toEqual({
      pathParams: { name: "p" },
      body: { effort: "low" },
    });
  });

  test("refuses an empty update", async () => {
    const { exitCode } = await run(["profiles", "update", "p"]);
    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });
});

describe("profiles delete", () => {
  test("sends the name as a path param", async () => {
    mockIpcResult = { ok: true, result: { ok: true, name: "p" } };
    await run(["profiles", "delete", "p"]);
    expect(lastIpcCall?.method).toBe("inference_profiles_delete");
    expect(lastIpcCall?.params).toEqual({ pathParams: { name: "p" } });
  });
});

describe("profiles active", () => {
  test("no arg reads via config_get", async () => {
    mockIpcResult = {
      ok: true,
      result: { llm: { activeProfile: "balanced" } },
    };
    const { stdout } = await run(["profiles", "active"]);
    expect(lastIpcCall?.method).toBe("config_get");
    expect(stdout).toContain("balanced");
  });

  test("with a name writes via config_patch deep-merge", async () => {
    mockIpcResult = { ok: true, result: {} };
    await run(["profiles", "active", "my-fast"]);
    expect(lastIpcCall?.method).toBe("config_patch");
    expect(lastIpcCall?.params).toEqual({
      body: { llm: { activeProfile: "my-fast" } },
    });
  });
});
