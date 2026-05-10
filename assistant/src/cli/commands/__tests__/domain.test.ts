/**
 * Tests for the `assistant domain` CLI command (thin IPC wrapper).
 *
 * Validates:
 *   - `domain register <subdomain>` → cliIpcCall("domain_register", { body: { subdomain } })
 *   - `domain register` (no subdomain) → cliIpcCall("domain_register", { body: {} })
 *   - `domain status` → cliIpcCall("domain_status")
 *   - IPC error → exit non-zero
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let lastIpcCall: {
  method: string;
  params?: Record<string, unknown>;
} | null = null;

let mockIpcResult: {
  ok: boolean;
  result?: unknown;
  error?: string;
} = { ok: true, result: {} };

// ---------------------------------------------------------------------------
// Mocks (must come before module import)
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 1;
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

const { registerDomainCommand } = await import("../domain.js");

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

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
    registerDomainCommand(program);
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
});

// ---------------------------------------------------------------------------
// domain register
// ---------------------------------------------------------------------------

describe("domain register", () => {
  test("register with subdomain calls cliIpcCall with subdomain in body", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        domain: "velly.vellum.me",
        status: "active",
        verified: true,
      },
    };

    const { exitCode } = await runCommand(["domain", "register", "velly"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("domain_register");
    expect(lastIpcCall!.params).toEqual({ body: { subdomain: "velly" } });
  });

  test("register without subdomain calls cliIpcCall with empty body", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        domain: "my-assistant.vellum.me",
        status: "active",
        verified: true,
      },
    };

    const { exitCode } = await runCommand(["domain", "register"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("domain_register");
    expect(lastIpcCall!.params).toEqual({ body: {} });
  });

  test("register with --json outputs structured result", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        domain: "velly.vellum.me",
        status: "active",
        verified: true,
      },
    };

    const { exitCode, stdout } = await runCommand([
      "domain",
      "--json",
      "register",
      "velly",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.domain).toBe("velly.vellum.me");
    expect(parsed.verified).toBe(true);
  });

  test("IPC error → exit non-zero", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to the assistant",
    };

    const { exitCode } = await runCommand(["domain", "register", "velly"]);

    expect(exitCode).not.toBe(0);
    expect(lastIpcCall!.method).toBe("domain_register");
  });

  test("IPC error with --json outputs error object", async () => {
    mockIpcResult = {
      ok: false,
      error: "Platform credentials not configured. Run: assistant platform connect",
    };

    const { exitCode, stdout } = await runCommand([
      "domain",
      "--json",
      "register",
      "velly",
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Platform credentials not configured");
  });
});

// ---------------------------------------------------------------------------
// domain status
// ---------------------------------------------------------------------------

describe("domain status", () => {
  test("status calls cliIpcCall with domain_status method", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        results: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            domain: "velly.vellum.me",
            status: "active",
            verified: true,
            created_at: "2026-04-15T19:00:00Z",
          },
        ],
      },
    };

    const { exitCode } = await runCommand(["domain", "status"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("domain_status");
    expect(lastIpcCall!.params).toBeUndefined();
  });

  test("status with --json outputs structured result", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        results: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            domain: "velly.vellum.me",
            status: "active",
            verified: true,
            created_at: "2026-04-15T19:00:00Z",
          },
        ],
      },
    };

    const { exitCode, stdout } = await runCommand([
      "domain",
      "--json",
      "status",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].domain).toBe("velly.vellum.me");
  });

  test("IPC error on status → exit non-zero", async () => {
    mockIpcResult = {
      ok: false,
      error: "Could not connect to the assistant",
    };

    const { exitCode } = await runCommand(["domain", "status"]);

    expect(exitCode).not.toBe(0);
    expect(lastIpcCall!.method).toBe("domain_status");
  });

  test("IPC error with --json on status outputs error object", async () => {
    mockIpcResult = {
      ok: false,
      error: "Platform credentials not configured. Run: assistant platform connect",
    };

    const { exitCode, stdout } = await runCommand([
      "domain",
      "--json",
      "status",
    ]);

    expect(exitCode).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("empty results shows helpful message (no crash)", async () => {
    mockIpcResult = {
      ok: true,
      result: { results: [] },
    };

    const { exitCode } = await runCommand(["domain", "status"]);

    expect(exitCode).toBe(0);
  });
});
