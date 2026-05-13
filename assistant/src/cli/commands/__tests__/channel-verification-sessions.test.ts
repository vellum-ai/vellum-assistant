/**
 * Tests for the `assistant channel-verification-sessions` CLI command.
 *
 * Validates:
 *   - Subcommand registration (create, status, resend, cancel, revoke)
 *   - `create` sends correct IPC method and params (channel, purpose default)
 *   - `create --destination` includes destination in params
 *   - `create --purpose trusted_contact` with contact-channel-id
 *   - `status` with no flags (channel: undefined)
 *   - `status --channel phone` sends channel param
 *   - `resend --channel telegram` sends correct method + params
 *   - `cancel --channel telegram` sends correct method + params
 *   - `revoke` with no flags (channel: undefined)
 *   - `revoke --channel phone` sends channel param
 *   - `create --channel fax` → invalid channel, exits with code 1, IPC not called
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
} = { ok: true, result: { success: true } };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
  exitFromIpcResult: (r: { ok: false; error?: string }, _cmd?: unknown) => {
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

const { registerChannelVerificationSessionsCommand } = await import(
  "../channel-verification-sessions.js"
);

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerChannelVerificationSessionsCommand(program);
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { success: true } };
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe("subcommand registration", () => {
  test("registers create, status, resend, cancel, revoke subcommands", () => {
    const program = new Command();
    registerChannelVerificationSessionsCommand(program);
    const cvs = program.commands.find(
      (c) => c.name() === "channel-verification-sessions",
    );
    expect(cvs).toBeDefined();
    const subcommandNames = cvs!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual([
      "cancel",
      "create",
      "resend",
      "revoke",
      "status",
    ]);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("channel-verification-sessions create", () => {
  test("--channel telegram calls channel_verification_sessions_create with purpose=guardian", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).toBeDefined();
    expect(lastIpcCall!.method).toBe("channel_verification_sessions_create");
    expect(lastIpcCall!.params).toMatchObject({
      body: {
        channel: "telegram",
        purpose: "guardian",
      },
    });
  });

  test("--channel telegram --destination '@handle' includes destination", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "telegram",
      "--destination",
      "@handle",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({
      body: {
        channel: "telegram",
        destination: "@handle",
        purpose: "guardian",
      },
    });
  });

  test("--purpose trusted_contact --contact-channel-id abc includes both", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--purpose",
      "trusted_contact",
      "--contact-channel-id",
      "abc",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({
      body: {
        purpose: "trusted_contact",
        contactChannelId: "abc",
      },
    });
  });

  test("--rebind flag is passed to IPC", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "telegram",
      "--rebind",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({
      body: {
        channel: "telegram",
        rebind: true,
      },
    });
  });

  test("--channel fax sets exitCode 1 and does not call IPC (invalid channel)", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "fax",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Could not connect" };

    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { success: true, sessionId: "sess-1" },
    };

    const { exitCode, stdout } = await runCommand([
      "channel-verification-sessions",
      "create",
      "--channel",
      "telegram",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ success: true, sessionId: "sess-1" });
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("channel-verification-sessions status", () => {
  test("no flags sends channel: undefined", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "status",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("channel_verification_sessions_status");
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: undefined } });
  });

  test("--channel phone sends channel: 'phone'", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "status",
      "--channel",
      "phone",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: "phone" } });
  });

  test("--channel fax sets exitCode 1 and does not call IPC", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "status",
      "--channel",
      "fax",
    ]);

    expect(exitCode).toBe(1);
    expect(lastIpcCall).toBeNull();
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Connection refused" };

    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "status",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { bound: true, channel: "telegram" },
    };

    const { exitCode, stdout } = await runCommand([
      "channel-verification-sessions",
      "status",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ bound: true, channel: "telegram" });
  });
});

// ---------------------------------------------------------------------------
// resend
// ---------------------------------------------------------------------------

describe("channel-verification-sessions resend", () => {
  test("--channel telegram calls channel_verification_sessions_resend", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "resend",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("channel_verification_sessions_resend");
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: "telegram" } });
  });

  test("--origin-conversation-id is passed to IPC", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "resend",
      "--channel",
      "telegram",
      "--origin-conversation-id",
      "conv-123",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({
      body: {
        channel: "telegram",
        originConversationId: "conv-123",
      },
    });
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "No active session" };

    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "resend",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("channel-verification-sessions cancel", () => {
  test("--channel telegram calls channel_verification_sessions_cancel", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "cancel",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("channel_verification_sessions_cancel");
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: "telegram" } });
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Not found" };

    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "cancel",
      "--channel",
      "telegram",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { success: true, channel: "telegram" },
    };

    const { exitCode, stdout } = await runCommand([
      "channel-verification-sessions",
      "cancel",
      "--channel",
      "telegram",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ success: true, channel: "telegram" });
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("channel-verification-sessions revoke", () => {
  test("no flags calls channel_verification_sessions_revoke with channel: undefined", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "revoke",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.method).toBe("channel_verification_sessions_revoke");
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: undefined } });
  });

  test("--channel phone sends channel: 'phone'", async () => {
    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "revoke",
      "--channel",
      "phone",
    ]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall!.params).toMatchObject({ body: { channel: "phone" } });
  });

  test("IPC error results in exit code 1", async () => {
    mockIpcResult = { ok: false, error: "Nothing to revoke" };

    const { exitCode } = await runCommand([
      "channel-verification-sessions",
      "revoke",
    ]);

    expect(exitCode).toBe(1);
  });

  test("--json outputs structured JSON on success", async () => {
    mockIpcResult = {
      ok: true,
      result: { success: true, revoked: true },
    };

    const { exitCode, stdout } = await runCommand([
      "channel-verification-sessions",
      "revoke",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ success: true, revoked: true });
  });
});
