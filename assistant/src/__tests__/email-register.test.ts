/**
 * Tests for `assistant email register` command.
 *
 * Uses mock.module for ESM-compatible mocking of secure-keys,
 * and globalThis.fetch for platform API mocking.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

let mockApiKey: string | undefined = "test-api-key-123";

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockApiKey,
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => "deleted" as const,
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: false }),
  _resetBackend: () => {},
}));

// ---------------------------------------------------------------------------
// Env overrides
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.VELLUM_PLATFORM_URL = "https://platform.test.vellum.ai";
  process.env.PLATFORM_ASSISTANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  mockApiKey = "test-api-key-123";
  process.exitCode = 0;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture stdout writes during a callback. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

/** Build a minimal program with the email command registered. */
async function buildProgram(): Promise<Command> {
  const { registerEmailCommand } = await import("../cli/commands/email.js");
  const program = new Command();
  program.exitOverride();
  registerEmailCommand(program);
  return program;
}

function mockFetch(
  body: unknown,
  status: number,
): { restore: () => void; calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { restore: () => (globalThis.fetch = originalFetch), calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant email register", () => {
  test("successful registration calls correct URL and body", async () => {
    const { restore, calls } = mockFetch(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        address: "mybot@vellum.me",
        created_at: "2026-04-04T21:00:00Z",
      },
      201,
    );

    try {
      const program = await buildProgram();

      await captureStdout(async () => {
        await program.parseAsync([
          "node",
          "test",
          "email",
          "register",
          "mybot",
        ]);
      });

      expect(calls).toHaveLength(1);
      const [url, opts] = calls[0];
      expect(url).toBe(
        "https://platform.test.vellum.ai/v1/assistants/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/email-addresses/",
      );
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body as string)).toEqual({ username: "mybot" });
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Api-Key test-api-key-123",
      );
      expect(process.exitCode).toBe(0);
    } finally {
      restore();
    }
  });

  test("--json outputs structured response", async () => {
    const { restore } = mockFetch(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        address: "support@vellum.me",
        created_at: "2026-04-04T21:00:00Z",
      },
      201,
    );

    try {
      const program = await buildProgram();

      const output = await captureStdout(async () => {
        await program.parseAsync([
          "node",
          "test",
          "email",
          "--json",
          "register",
          "support",
        ]);
      });

      const parsed = JSON.parse(output.trim());
      expect(parsed.address).toBe("support@vellum.me");
      expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(parsed.created_at).toBe("2026-04-04T21:00:00Z");
      expect(process.exitCode).toBe(0);
    } finally {
      restore();
    }
  });

  test("duplicate address returns error", async () => {
    const { restore } = mockFetch(
      { assistant_id: ["This assistant already has an email address."] },
      400,
    );

    try {
      const program = await buildProgram();

      const output = await captureStdout(async () => {
        await program.parseAsync([
          "node",
          "test",
          "email",
          "--json",
          "register",
          "mybot",
        ]);
      });

      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(output.trim());
      expect(parsed.error).toContain("already has an email address");
    } finally {
      restore();
    }
  });

  test("missing API key returns error", async () => {
    mockApiKey = undefined;

    const program = await buildProgram();

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "test",
        "email",
        "--json",
        "register",
        "mybot",
      ]);
    });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("API key");
  });

  test("missing assistant ID returns error", async () => {
    delete process.env.PLATFORM_ASSISTANT_ID;

    const program = await buildProgram();

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "test",
        "email",
        "--json",
        "register",
        "mybot",
      ]);
    });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("platform 5xx returns error", async () => {
    const { restore } = mockFetch({ detail: "Internal server error" }, 500);

    try {
      const program = await buildProgram();

      const output = await captureStdout(async () => {
        await program.parseAsync([
          "node",
          "test",
          "email",
          "--json",
          "register",
          "mybot",
        ]);
      });

      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(output.trim());
      expect(parsed.error).toContain("Internal server error");
    } finally {
      restore();
    }
  });

  test("username validation error from platform is surfaced", async () => {
    const { restore } = mockFetch({ username: ["Enter a valid value."] }, 400);

    try {
      const program = await buildProgram();

      const output = await captureStdout(async () => {
        await program.parseAsync([
          "node",
          "test",
          "email",
          "--json",
          "register",
          "invalid username!",
        ]);
      });

      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(output.trim());
      expect(parsed.error).toContain("valid value");
    } finally {
      restore();
    }
  });
});
