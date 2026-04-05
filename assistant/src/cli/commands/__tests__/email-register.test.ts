import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../../../config/assistant-feature-flags.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockPlatformClient: {
  platformAssistantId: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
} | null = null;

// ---------------------------------------------------------------------------
// Module mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

mock.module("../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClient,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let fetchCalls: [string, RequestInit][] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  process.exitCode = 0;

  _setOverridesForTesting({ "email-channel": true });

  mockPlatformClient = {
    platformAssistantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    fetch: async (path: string, init?: RequestInit) => {
      const url = `https://test-platform.vellum.ai${path}`;
      fetchCalls.push([url, init ?? {}]);
      return globalThis.fetch(url, init);
    },
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setOverridesForTesting({});
  process.exitCode = 0;
});

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

function setFetchResponse(body: unknown, status: number): void {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

async function runEmailCommand(...args: string[]): Promise<string> {
  const { buildCliProgram } = await import("../../program.js");
  const program = buildCliProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

  return captureStdout(async () => {
    try {
      await program.parseAsync(["node", "assistant", ...args]);
    } catch {
      /* commander exit override throws */
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant email register", () => {
  test("successful registration calls correct URL and body", async () => {
    setFetchResponse(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        address: "mybot@vellum.me",
        created_at: "2026-04-04T21:00:00Z",
      },
      201,
    );

    await runEmailCommand("email", "register", "mybot");

    expect(fetchCalls).toHaveLength(1);
    const [url, opts] = fetchCalls[0];
    expect(url).toBe(
      "https://test-platform.vellum.ai/v1/assistants/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/email-addresses/",
    );
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ username: "mybot" });
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    setFetchResponse(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        address: "support@vellum.me",
        created_at: "2026-04-04T21:00:00Z",
      },
      201,
    );

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "support",
    );

    const parsed = JSON.parse(output.trim());
    expect(parsed.address).toBe("support@vellum.me");
    expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parsed.created_at).toBe("2026-04-04T21:00:00Z");
    expect(process.exitCode).toBe(0);
  });

  test("duplicate address returns error", async () => {
    setFetchResponse(
      { assistant_id: ["This assistant already has an email address."] },
      400,
    );

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("already has an email address");
  });

  test("missing platform credentials returns error", async () => {
    mockPlatformClient = null;

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    mockPlatformClient = {
      ...mockPlatformClient!,
      platformAssistantId: "",
    };

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });

  test("platform 5xx returns error", async () => {
    setFetchResponse({ detail: "Internal server error" }, 500);

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "mybot",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Internal server error");
  });

  test("username validation error from platform is surfaced", async () => {
    setFetchResponse({ username: ["Enter a valid value."] }, 400);

    const output = await runEmailCommand(
      "email",
      "--json",
      "register",
      "invalid username!",
    );

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("valid value");
  });
});
