/**
 * Tests for `assistant inference profile` CLI subcommands.
 *
 * Validates:
 *   - open: TTL parsing (--ttl 30m, no --ttl, --ttl never), clamping warning, replaced session
 *   - open --json: JSON output shape
 *   - close: happy path and noop
 *   - list: queryParams routing, empty and non-empty output
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let lastIpcCall: { method: string; params?: any } | null = null;
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: {},
};

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE dynamic import of module under test
// ---------------------------------------------------------------------------

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
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

mock.module("../../../config/loader.js", () => ({
  loadConfig: () => ({ llm: { profileSession: { defaultTtlSeconds: 1800 } } }),
  getConfigReadOnly: () => ({ llm: { profileSession: { defaultTtlSeconds: 1800 } } }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { attachProfileSubcommand } = await import("../inference-profile.js");

// ---------------------------------------------------------------------------
// Env var helpers
// ---------------------------------------------------------------------------

let savedConvId: string | undefined;
let savedSkillCtx: string | undefined;

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: {} };
  process.exitCode = 0;

  // Save env vars and set a fixed conversation ID so resolveConversationId
  // returns a predictable value without mocking the module.
  savedConvId = process.env.__CONVERSATION_ID;
  savedSkillCtx = process.env.__SKILL_CONTEXT_JSON;
  delete process.env.__SKILL_CONTEXT_JSON;
  process.env.__CONVERSATION_ID = "conv-test-123";
});

afterEach(() => {
  if (savedConvId !== undefined) {
    process.env.__CONVERSATION_ID = savedConvId;
  } else {
    delete process.env.__CONVERSATION_ID;
  }
  if (savedSkillCtx !== undefined) {
    process.env.__SKILL_CONTEXT_JSON = savedSkillCtx;
  } else {
    delete process.env.__SKILL_CONTEXT_JSON;
  }
});

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

async function runCommand(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    const str = typeof chunk === "string" ? chunk : String(chunk);
    chunks.push(str);
    return true;
  }) as typeof process.stdout.write;

  const prevExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    const inferenceCmd = program.command("inference");
    attachProfileSubcommand(inferenceCmd);
    await program.parseAsync(["node", "assistant", "inference", ...args]);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("(outputHelp)")) {
      // ignore help output
    }
  } finally {
    process.stdout.write = originalWrite;
  }

  const stdout = chunks.join("");
  const exitCode = (process.exitCode as number) ?? 0;
  process.exitCode = prevExitCode;

  return { stdout, exitCode };
}

// ===========================================================================
// profile open
// ===========================================================================

describe("profile open", () => {
  test("--ttl 30m → IPC called with ttlSeconds: 1800", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: Date.now() + 1800 * 1000,
        ttlSeconds: 1800,
        replaced: null,
      },
    };

    await runCommand(["profile", "open", "balanced", "--ttl", "30m"]);

    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("inference_profile_open");
    expect(lastIpcCall!.params).toEqual({
      body: {
        conversationId: "conv-test-123",
        profile: "balanced",
        ttlSeconds: 1800,
      },
    });
  });

  test("no --ttl → IPC body has ttlSeconds: 1800 (default)", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: Date.now() + 1800 * 1000,
        ttlSeconds: 1800,
        replaced: null,
      },
    };

    await runCommand(["profile", "open", "balanced"]);

    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("inference_profile_open");
    expect(lastIpcCall!.params?.body?.ttlSeconds).toBe(1800);
  });

  test("--ttl never → IPC body has ttlSeconds: null", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: null,
        ttlSeconds: null,
        replaced: null,
      },
    };

    await runCommand(["profile", "open", "balanced", "--ttl", "never"]);

    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.params?.body?.ttlSeconds).toBeNull();
  });

  test("TTL clamping → human output includes 'note: ttl clamped'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: Date.now() + 900 * 1000,
        ttlSeconds: 900, // clamped from 1800
        replaced: null,
      },
    };

    const { stdout } = await runCommand([
      "profile",
      "open",
      "balanced",
      "--ttl",
      "30m",
    ]);

    expect(stdout).toContain("note: ttl clamped");
  });

  test("replaced session in response → human output shows 'replaced:'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: Date.now() + 1800 * 1000,
        ttlSeconds: 1800,
        replaced: {
          profile: "fast",
          sessionId: "sess-old",
          expiresAt: Date.now() + 600 * 1000,
        },
      },
    };

    const { stdout } = await runCommand([
      "profile",
      "open",
      "balanced",
      "--ttl",
      "30m",
    ]);

    expect(stdout).toContain("replaced:");
    expect(stdout).toContain("fast");
  });

  test("--json → JSON output shape matches", async () => {
    const now = Date.now();
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: now + 1800 * 1000,
        ttlSeconds: 1800,
        replaced: null,
      },
    };

    const { stdout } = await runCommand([
      "profile",
      "open",
      "balanced",
      "--ttl",
      "30m",
      "--json",
    ]);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.conversationId).toBe("conv-test-123");
    expect(parsed.profile).toBe("balanced");
    expect(parsed.sessionId).toBe("sess-abc");
    expect(typeof parsed.expiresAt).toBe("string"); // ISO string
    expect(parsed.ttlSeconds).toBe(1800);
    expect(parsed.replaced).toBeNull();
  });

  test("sticky (--ttl never) → human output says 'sticky, no expiry'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        profile: "balanced",
        sessionId: "sess-abc",
        expiresAt: null,
        ttlSeconds: null,
        replaced: null,
      },
    };

    const { stdout } = await runCommand([
      "profile",
      "open",
      "balanced",
      "--ttl",
      "never",
    ]);

    expect(stdout).toContain("sticky, no expiry");
  });
});

// ===========================================================================
// profile close
// ===========================================================================

describe("profile close", () => {
  test("happy path (closed != null, noop: false) → prints 'closed profile balanced'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        closed: { profile: "balanced", sessionId: "sess-abc" },
        noop: false,
      },
    };

    const { stdout } = await runCommand(["profile", "close"]);

    expect(stdout).toContain("closed profile balanced");
  });

  test("noop → prints 'no active profile session'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        conversationId: "conv-test-123",
        closed: null,
        noop: true,
      },
    };

    const { stdout } = await runCommand(["profile", "close"]);

    expect(stdout).toContain("no active profile session");
  });
});

// ===========================================================================
// profile list
// ===========================================================================

describe("profile list", () => {
  test("default (no --conversation-id) → IPC called with { queryParams: {} }", async () => {
    mockIpcResult = {
      ok: true,
      result: { sessions: [] },
    };

    await runCommand(["profile", "list"]);

    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("inference_profile_list");
    expect(lastIpcCall!.params).toEqual({ queryParams: {} });
  });

  test("--conversation-id conv-xyz → IPC called with { queryParams: { conversationId: 'conv-xyz' } }", async () => {
    mockIpcResult = {
      ok: true,
      result: { sessions: [] },
    };

    await runCommand([
      "profile",
      "list",
      "--conversation-id",
      "conv-xyz",
    ]);

    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.params).toEqual({
      queryParams: { conversationId: "conv-xyz" },
    });
  });

  test("empty → prints 'no active profile sessions'", async () => {
    mockIpcResult = {
      ok: true,
      result: { sessions: [] },
    };

    const { stdout } = await runCommand(["profile", "list"]);

    expect(stdout).toContain("no active profile sessions");
  });

  test("non-empty → prints 'active session(s)'", async () => {
    mockIpcResult = {
      ok: true,
      result: {
        sessions: [
          {
            conversationId: "conv-abc123",
            conversationTitle: "Refactoring config loader",
            profile: "balanced",
            sessionId: "sess-xyz",
            expiresAt: Date.now() + 1800 * 1000,
            remainingSeconds: 1740,
          },
        ],
      },
    };

    const { stdout } = await runCommand(["profile", "list"]);

    expect(stdout).toContain("active session(s)");
    expect(stdout).toContain("balanced");
    expect(stdout).toContain("conv-abc123");
  });
});
