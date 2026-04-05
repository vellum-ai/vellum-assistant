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
let fetchCalls: { path: string; init: RequestInit }[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  process.exitCode = 0;

  _setOverridesForTesting({ "email-channel": true });

  mockPlatformClient = {
    platformAssistantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    fetch: async (path: string, init?: RequestInit) => {
      fetchCalls.push({ path, init: init ?? {} });
      return globalThis.fetch(path, init);
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

type FetchHandler = (
  path: string,
  init?: RequestInit,
) => { body: unknown; status: number };

function setFetchSequence(handler: FetchHandler): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const { body, status } = handler(path, init);
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

const ASSISTANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ADDRESS_ID = "550e8400-e29b-41d4-a716-446655440000";
const ADDRESS = "mybot@vellum.me";

function standardHandler(
  deleteStatus = 204,
  deleteBody: unknown = null,
): FetchHandler {
  return (path: string, init?: RequestInit) => {
    if (
      path.includes("/email-addresses/") &&
      (!init?.method || init.method === "GET")
    ) {
      return {
        body: { results: [{ id: ADDRESS_ID, address: ADDRESS }] },
        status: 200,
      };
    }
    if (init?.method === "DELETE") {
      return { body: deleteBody, status: deleteStatus };
    }
    return { body: {}, status: 404 };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant email unregister", () => {
  test("successful unregister with --confirm lists then deletes", async () => {
    setFetchSequence(standardHandler());

    await runEmailCommand("email", "unregister", "--confirm");

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].path).toBe(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/`,
    );
    expect(fetchCalls[0].init.method).toBeUndefined();
    expect(fetchCalls[1].path).toBe(
      `/v1/assistants/${ASSISTANT_ID}/email-addresses/${ADDRESS_ID}/`,
    );
    expect(fetchCalls[1].init.method).toBe("DELETE");
    expect(process.exitCode).toBe(0);
  });

  test("--json outputs structured response", async () => {
    setFetchSequence(standardHandler());

    const output = await runEmailCommand("email", "--json", "unregister");

    const parsed = JSON.parse(output.trim());
    expect(parsed.unregistered).toBe(ADDRESS);
    expect(process.exitCode).toBe(0);
  });

  test("no registered address returns error", async () => {
    setFetchSequence((_path: string) => ({
      body: { results: [] },
      status: 200,
    }));

    const output = await runEmailCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("No email address registered");
  });

  test("list endpoint failure returns error", async () => {
    setFetchSequence((_path: string) => ({
      body: { detail: "Internal server error" },
      status: 500,
    }));

    const output = await runEmailCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Failed to list email addresses");
  });

  test("delete endpoint failure returns error", async () => {
    setFetchSequence(standardHandler(500, { detail: "Cannot delete address" }));

    const output = await runEmailCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Cannot delete address");
  });

  test("missing platform credentials returns error", async () => {
    mockPlatformClient = null;

    const output = await runEmailCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Platform credentials not configured");
  });

  test("missing assistant ID returns error", async () => {
    mockPlatformClient = {
      ...mockPlatformClient!,
      platformAssistantId: "",
    };

    const output = await runEmailCommand("email", "--json", "unregister");

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain("Assistant ID");
  });
});
