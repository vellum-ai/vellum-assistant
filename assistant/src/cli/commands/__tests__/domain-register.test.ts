/**
 * Tests for the domain register CLI subcommand (thin IPC wrapper).
 *
 * Validates:
 *   - register calls domain_register with subdomain param
 *   - register without subdomain sends empty body
 *   - --json outputs structured response
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
// register
// ---------------------------------------------------------------------------

describe("assistant domain register", () => {
  test("calls domain_register with subdomain param", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "becky.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
      }),
    );

    await runDomainCommand("domain", "register", "becky");

    expect(mockIpcCallFn).toHaveBeenCalledWith("domain_register", {
      body: { subdomain: "becky" },
    });
    expect(process.exitCode).toBe(0);
  });

  test("registration without subdomain sends empty body", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "my-assistant.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
      }),
    );

    await runDomainCommand("domain", "register");

    expect(mockIpcCallFn).toHaveBeenCalledWith("domain_register", {
      body: {},
    });
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "becky.vellum.me",
          status: "active",
          verified: true,
          created_at: "2026-04-15T19:00:00Z",
        },
      }),
    );

    const output = await runDomainCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.domain).toBe("becky.vellum.me");
    expect(parsed.verified).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("IPC error with --json outputs error envelope", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "This assistant already has a registered domain.",
        statusCode: 400,
      }),
    ) as unknown as typeof mockIpcCallFn;

    const output = await runDomainCommand(
      "domain",
      "--json",
      "register",
      "becky",
    );

    expect(process.exitCode).not.toBe(0);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("already has a registered domain");
  });

  test("IPC error without --json calls exitFromIpcResult", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: false,
        error: "Platform credentials not configured",
        statusCode: 401,
      }),
    ) as unknown as typeof mockIpcCallFn;

    await runDomainCommand("domain", "register", "velly");
    expect(process.exitCode).not.toBe(0);
  });

  test("--email-username is included in IPC body", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "velly.vellum.me",
          status: "active",
          verified: true,
        },
      }),
    );

    await runDomainCommand(
      "domain",
      "register",
      "velly",
      "--email-username",
      "hello",
    );

    expect(mockIpcCallFn).toHaveBeenCalledWith("domain_register", {
      body: { subdomain: "velly", email_username: "hello" },
    });
    expect(process.exitCode).toBe(0);
  });

  test("email error in response is surfaced as warning", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "velly.vellum.me",
          status: "active",
          verified: true,
          email_error: {
            detail: "MX records not ready",
            code: "email_setup_failed",
          },
        },
      }),
    );

    await runDomainCommand(
      "domain",
      "register",
      "velly",
      "--email-username",
      "hello",
    );

    expect(process.exitCode).toBe(0);
  });

  test("--json includes email_error in output", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "velly.vellum.me",
          status: "active",
          verified: true,
          email_error: {
            detail: "MX records not ready",
            code: "email_setup_failed",
          },
        },
      }),
    );

    const output = await runDomainCommand(
      "domain",
      "--json",
      "register",
      "velly",
      "--email-username",
      "hello",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.email_error).toEqual({
      detail: "MX records not ready",
      code: "email_setup_failed",
    });
    expect(process.exitCode).toBe(0);
  });

  test("without --email-username behavior is unchanged", async () => {
    mockIpcCallFn = mock(() =>
      Promise.resolve({
        ok: true,
        result: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          domain: "velly.vellum.me",
          status: "active",
          verified: true,
        },
      }),
    );

    await runDomainCommand("domain", "register", "velly");

    expect(mockIpcCallFn).toHaveBeenCalledWith("domain_register", {
      body: { subdomain: "velly" },
    });
    expect(process.exitCode).toBe(0);
  });
});
