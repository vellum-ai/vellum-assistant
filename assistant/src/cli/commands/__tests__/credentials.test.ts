/**
 * Tests for the `assistant credentials` CLI command.
 *
 * Validates:
 *   - Subcommand registration (list, status, set, delete, inspect, reveal, prompt)
 *   - list success and error paths (JSON + plain)
 *   - list --search flag passes correct query param
 *   - status success and error paths
 *   - set success and error paths
 *   - delete success and error paths
 *   - inspect success and error paths
 *   - reveal success, untrusted-shell guard, and error paths
 *   - IPC error propagation (daemon down)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/** The last `cliIpcCall` invocation captured for assertions. */
let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

/** The result that cliIpcCall will return. */
let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (
    method: string,
    params?: Record<string, unknown>,
    _opts?: Record<string, unknown>,
  ) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
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
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { registerCredentialsCommand } = await import("../credentials.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

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
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
  process.exitCode = 0;
  delete process.env.VELLUM_UNTRUSTED_SHELL;
});

// ---------------------------------------------------------------------------
// credentials list
// ---------------------------------------------------------------------------

describe("credentials list", () => {
  test("calls credential_list IPC without search", async () => {
    mockIpcResult = {
      ok: true,
      result: { credentials: [], managedCredentials: [] },
    };

    const { exitCode } = await runCommand(["credentials", "list"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("credential_list");
    expect(lastIpcCall!.params).toBeUndefined();
  });

  test("calls credential_list IPC with search query param", async () => {
    mockIpcResult = {
      ok: true,
      result: { credentials: [], managedCredentials: [] },
    };

    const { exitCode } = await runCommand([
      "credentials",
      "list",
      "--search",
      "twilio",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_list");
    expect(lastIpcCall!.params).toEqual({
      queryParams: { search: "twilio" },
    });
  });

  test("--json outputs structured credentials array", async () => {
    const fakeCred = {
      ok: true,
      source: "local",
      service: "twilio",
      field: "auth_token",
      credentialId: "cred-123",
      scrubbedValue: "****abcd",
      hasSecret: true,
      alias: null,
      usageDescription: null,
      allowedTools: [],
      allowedDomains: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      injectionTemplateCount: 0,
      grantedScopes: null,
      expiresAt: null,
    };

    mockIpcResult = {
      ok: true,
      result: { credentials: [fakeCred], managedCredentials: [] },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.credentials)).toBe(true);
    expect(parsed.credentials[0].service).toBe("twilio");
  });

  test("error (daemon not running): exits 1", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant. Is it running?",
    };

    const { exitCode } = await runCommand(["credentials", "list"]);
    expect(exitCode).toBe(1);
  });

  test("error --json: outputs structured error", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to assistant. Is it running?",
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Could not connect");
  });
});

// ---------------------------------------------------------------------------
// credentials status
// ---------------------------------------------------------------------------

describe("credentials status", () => {
  test("calls credential_status IPC", async () => {
    mockIpcResult = {
      ok: true,
      result: { backend: "ces-rpc", ready: true },
    };

    const { exitCode } = await runCommand(["credentials", "status"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_status");
  });

  test("--json outputs backend info", async () => {
    mockIpcResult = {
      ok: true,
      result: { backend: "ces-rpc", ready: true },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "status",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.backend).toBe("ces-rpc");
  });

  test("error: exits 1", async () => {
    mockIpcResult = {
      ok: false,
      error: "daemon down",
    };

    const { exitCode } = await runCommand(["credentials", "status"]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// credentials set
// ---------------------------------------------------------------------------

describe("credentials set", () => {
  test("calls credential_set with correct body", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, credentialId: "cred-abc", service: "foo", field: "bar" },
    };

    const { exitCode } = await runCommand([
      "credentials",
      "set",
      "--service",
      "foo",
      "--field",
      "bar",
      "myval",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_set");
    expect(lastIpcCall!.params).toEqual({
      body: {
        service: "foo",
        field: "bar",
        value: "myval",
        label: undefined,
        description: undefined,
        allowedTools: undefined,
      },
    });
  });

  test("passes optional flags to body", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, credentialId: "cred-abc", service: "foo", field: "bar" },
    };

    await runCommand([
      "credentials",
      "set",
      "--service",
      "foo",
      "--field",
      "bar",
      "--label",
      "prod",
      "--description",
      "My key",
      "--allowed-tools",
      "bash,host_bash",
      "secret123",
    ]);

    const body = lastIpcCall!.params!.body as Record<string, unknown>;
    expect(body.label).toBe("prod");
    expect(body.description).toBe("My key");
    expect(body.allowedTools).toEqual(["bash", "host_bash"]);
  });

  test("--json outputs credentialId", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, credentialId: "cred-xyz", service: "svc", field: "fld" },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "set",
      "--service",
      "svc",
      "--field",
      "fld",
      "--json",
      "val",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.credentialId).toBe("cred-xyz");
  });

  test("error: exits 1", async () => {
    mockIpcResult = { ok: false, error: "daemon down" };

    const { exitCode } = await runCommand([
      "credentials",
      "set",
      "--service",
      "foo",
      "--field",
      "bar",
      "val",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// credentials delete
// ---------------------------------------------------------------------------

describe("credentials delete", () => {
  test("calls credential_delete with correct body", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, service: "foo", field: "bar" },
    };

    const { exitCode } = await runCommand([
      "credentials",
      "delete",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_delete");
    expect(lastIpcCall!.params).toEqual({
      body: { service: "foo", field: "bar" },
    });
  });

  test("--json outputs ok", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, service: "foo", field: "bar" },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "delete",
      "--service",
      "foo",
      "--field",
      "bar",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("foo");
  });

  test("error: exits 1", async () => {
    mockIpcResult = { ok: false, error: "daemon down" };

    const { exitCode } = await runCommand([
      "credentials",
      "delete",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// credentials inspect
// ---------------------------------------------------------------------------

describe("credentials inspect", () => {
  test("calls credential_inspect with service+field query params", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ok: true,
        service: "foo",
        field: "bar",
        credentialId: "cred-123",
        scrubbedValue: "****1234",
        hasSecret: true,
        alias: null,
        usageDescription: null,
        allowedTools: [],
        allowedDomains: [],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        injectionTemplateCount: 0,
        grantedScopes: null,
        expiresAt: null,
      },
    };

    const { exitCode } = await runCommand([
      "credentials",
      "inspect",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_inspect");
    expect(lastIpcCall!.params).toEqual({
      queryParams: { service: "foo", field: "bar" },
    });
  });

  test("calls credential_inspect with id positional", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        ok: true,
        service: "svc",
        field: "fld",
        credentialId: "cred-abc",
        scrubbedValue: "****abcd",
        hasSecret: true,
        alias: null,
        usageDescription: null,
        allowedTools: [],
        allowedDomains: [],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        injectionTemplateCount: 0,
        grantedScopes: null,
        expiresAt: null,
      },
    };

    await runCommand([
      "credentials",
      "inspect",
      "7a3b1c2d-4e5f-6789-abcd-ef0123456789",
    ]);

    expect(lastIpcCall!.method).toBe("credential_inspect");
    expect((lastIpcCall!.params!.queryParams as Record<string, string>).id).toBe(
      "7a3b1c2d-4e5f-6789-abcd-ef0123456789",
    );
  });

  test("--json outputs result", async () => {
    const fakeResult = {
      ok: true,
      service: "foo",
      field: "bar",
      credentialId: "cred-123",
      scrubbedValue: "****1234",
      hasSecret: true,
      alias: null,
      usageDescription: null,
      allowedTools: [],
      allowedDomains: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      injectionTemplateCount: 0,
      grantedScopes: null,
      expiresAt: null,
    };

    mockIpcResult = { ok: true, result: fakeResult };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "inspect",
      "--service",
      "foo",
      "--field",
      "bar",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.credentialId).toBe("cred-123");
  });

  test("error: exits 1", async () => {
    mockIpcResult = { ok: false, error: "Credential not found" };

    const { exitCode } = await runCommand([
      "credentials",
      "inspect",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// credentials reveal
// ---------------------------------------------------------------------------

describe("credentials reveal", () => {
  test("calls credential_reveal with service+field query params", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, value: "supersecret" },
    };

    const { exitCode } = await runCommand([
      "credentials",
      "reveal",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("credential_reveal");
    expect(lastIpcCall!.params).toEqual({
      queryParams: { service: "foo", field: "bar" },
    });
  });

  test("prints plaintext value to stdout", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, value: "supersecret" },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "reveal",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("supersecret");
  });

  test("--json outputs structured value", async () => {
    mockIpcResult = {
      ok: true,
      result: { ok: true, value: "mysecretvalue" },
    };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "reveal",
      "--service",
      "foo",
      "--field",
      "bar",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toBe("mysecretvalue");
  });

  test("untrusted shell: exits 1 without making IPC call", async () => {
    process.env.VELLUM_UNTRUSTED_SHELL = "1";

    const { exitCode } = await runCommand([
      "credentials",
      "reveal",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("error: exits 1", async () => {
    mockIpcResult = { ok: false, error: "Credential not found" };

    const { exitCode } = await runCommand([
      "credentials",
      "reveal",
      "--service",
      "foo",
      "--field",
      "bar",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// IPC error propagation
// ---------------------------------------------------------------------------

describe("IPC error propagation", () => {
  test("daemon down: list exits 1 with error", async () => {
    mockIpcResult = { ok: false, error: "daemon down" };

    const { exitCode } = await runCommand(["credentials", "list"]);
    expect(exitCode).toBe(1);
  });

  test("daemon down --json: outputs structured error", async () => {
    mockIpcResult = { ok: false, error: "daemon down" };

    const { exitCode, stdout } = await runCommand([
      "credentials",
      "list",
      "--json",
    ]);

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("daemon down");
  });
});
