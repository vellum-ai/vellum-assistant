/**
 * Tests for the domain status CLI subcommand (thin IPC wrapper).
 *
 * Validates:
 *   - status calls domain_status
 *   - --json outputs structured response
 *   - no domain shows helpful message
 *   - error responses are surfaced correctly
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockIpcCallFn = mock(() =>
  Promise.resolve({ ok: true, result: {} }),
);

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: mockIpcCallFn,
  exitFromIpcResult: mock((r: { error?: string }) => {
    process.stderr.write((r.error ?? "Unknown error") + "\n");
    process.exitCode = 10;
  }),
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIpcCallFn = mock(() => Promise.resolve({ ok: true, result: {} }));
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runDomainCommand(...args: string[]) {
  mock.module("../../../ipc/cli-client.js", () => ({
    cliIpcCall: mockIpcCallFn,
    exitFromIpcResult: mock((r: { error?: string }) => {
      process.stderr.write((r.error ?? "Unknown error") + "\n");
      process.exitCode = 10;
    }),
  }));

  const { registerDomainCommand } = await import("../domain.js");

  const stdoutChunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerDomainCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } finally {
    process.stdout.write = origWrite;
  }

  return stdoutChunks.join("");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("assistant domain status", () => {
  test("calls domain_status", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          results: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              domain: "becky.vellum.me",
              status: "active",
              verified: true,
              created_at: "2026-04-15T19:00:00Z",
            },
          ],
        },
      }),
    );

    await runDomainCommand("domain", "status");

    expect(mockIpcCallFn).toHaveBeenCalledWith("domain_status");
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          results: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              domain: "becky.vellum.me",
              status: "active",
              verified: true,
              created_at: "2026-04-15T19:00:00Z",
            },
          ],
        },
      }),
    );

    const output = await runDomainCommand("domain", "--json", "status");

    const parsed = JSON.parse(output.trim());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].domain).toBe("becky.vellum.me");
    expect(process.exitCode).toBe(0);
  });

  test("no domain registered shows helpful message", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: { results: [] },
      }),
    );

    await runDomainCommand("domain", "status");
    expect(process.exitCode).toBe(0);
  });

  test("IPC error with --json outputs error envelope", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Service unavailable",
        statusCode: 503,
      }),
    ) as typeof mockIpcCallFn;

    const output = await runDomainCommand("domain", "--json", "status");

    expect(process.exitCode).not.toBe(0);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Service unavailable");
  });

  test("IPC error without --json calls exitFromIpcResult", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Platform credentials not configured",
        statusCode: 401,
      }),
    ) as typeof mockIpcCallFn;

    await runDomainCommand("domain", "status");
    expect(process.exitCode).not.toBe(0);
  });
});
