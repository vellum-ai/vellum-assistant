import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

let ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };
let logLines: string[] = [];
let errorLines: string[] = [];

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return mockIpcResult;
  },
  exitFromIpcResult: (result: { error?: string }) => {
    process.exitCode = 10;
    errorLines.push(result.error ?? "");
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getCliLogger: () => ({
    info: (message: string) => logLines.push(message),
    warn: () => {},
    error: (message: string) => errorLines.push(message),
    debug: () => {},
  }),
}));

const { registerCredentialsCommand } = await import("../credentials.js");

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerCredentialsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) {
      process.exitCode = 1;
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return { exitCode, stdout: stdoutChunks.join("") };
}

beforeEach(() => {
  ipcCalls = [];
  logLines = [];
  errorLines = [];
  mockIpcResult = { ok: true, result: {} };
  process.exitCode = 0;
});

describe("credentials command", () => {
  test("registers inspect with a get alias", () => {
    const program = new Command();
    registerCredentialsCommand(program);

    const credentials = program.commands.find(
      (command) => command.name() === "credentials",
    );
    expect(credentials).toBeDefined();

    const inspect = credentials!.commands.find(
      (command) => command.name() === "inspect",
    );
    expect(inspect).toBeDefined();
    expect(inspect!.aliases()).toContain("get");
  });
});

describe("credentials inspect / get", () => {
  const credentialFixture = {
    service: "twilio",
    field: "account_sid",
    credentialId: "cred-1",
    scrubbedValue: "****c123",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    injectionTemplateCount: 0,
  };

  test("inspect calls credentials_inspect with service/field", async () => {
    mockIpcResult = { ok: true, result: credentialFixture };

    const { exitCode } = await runCommand([
      "credentials",
      "inspect",
      "--service",
      "twilio",
      "--field",
      "account_sid",
    ]);

    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "credentials_inspect",
        params: {
          body: { service: "twilio", field: "account_sid", id: undefined },
        },
      },
    ]);
  });

  test("get alias resolves to the same credentials_inspect handler", async () => {
    // GIVEN the assistant returns a masked credential for the requested lookup
    mockIpcResult = { ok: true, result: credentialFixture };

    // WHEN the user invokes the `get` alias instead of `inspect`
    const { exitCode } = await runCommand([
      "credentials",
      "get",
      "--service",
      "twilio",
      "--field",
      "account_sid",
    ]);

    // THEN it calls the same credentials_inspect IPC method with the same body
    expect(exitCode).toBe(0);
    expect(ipcCalls).toEqual([
      {
        method: "credentials_inspect",
        params: {
          body: { service: "twilio", field: "account_sid", id: undefined },
        },
      },
    ]);
    // AND it renders the same masked human-readable view
    expect(logLines.join("\n")).toContain("****c123");
  });
});
