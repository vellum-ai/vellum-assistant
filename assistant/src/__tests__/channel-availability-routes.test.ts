/**
 * Tests for `assistant/src/runtime/routes/channel-availability-routes.ts`.
 *
 * The handler returns a fixed base list (`slack`, `telegram`, `phone`) and
 * appends `email` when the platform reports at least one registered email
 * address for this assistant. Platform failures fall back to base-only.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — flipped per-test
// ---------------------------------------------------------------------------

let mockPlatformAssistantId: string | null = "assistant-test-id";
let mockEmailAddressesResponse: {
  ok: boolean;
  status: number;
  body: unknown;
} = {
  ok: true,
  status: 200,
  body: { count: 0, results: [] },
};
let mockFetchThrows = false;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => ({
      platformAssistantId: mockPlatformAssistantId,
      fetch: async (_path: string) => {
        if (mockFetchThrows) {
          throw new Error("platform unreachable");
        }
        return {
          ok: mockEmailAddressesResponse.ok,
          status: mockEmailAddressesResponse.status,
          json: async () => mockEmailAddressesResponse.body,
        };
      },
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ROUTES } from "../runtime/routes/channel-availability-routes.js";

const handler = ROUTES[0]!.handler;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("channels/available", () => {
  beforeEach(() => {
    mockPlatformAssistantId = "assistant-test-id";
    mockEmailAddressesResponse = {
      ok: true,
      status: 200,
      body: { count: 0, results: [] },
    };
    mockFetchThrows = false;
  });

  test("base list only when no email address registered", async () => {
    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.success).toBe(true);
    expect(result.channels).toEqual(["slack", "telegram", "phone"]);
  });

  test("appends email when at least one address registered (count field)", async () => {
    mockEmailAddressesResponse = {
      ok: true,
      status: 200,
      body: { count: 1, results: [{ id: "addr-1", address: "hi@bot" }] },
    };

    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.channels).toEqual(["slack", "telegram", "phone", "email"]);
  });

  test("appends email when results non-empty even without count field", async () => {
    mockEmailAddressesResponse = {
      ok: true,
      status: 200,
      body: { results: [{ id: "addr-1", address: "hi@bot" }] },
    };

    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.channels).toContain("email");
  });

  test("base list only when platform returns non-ok", async () => {
    mockEmailAddressesResponse = {
      ok: false,
      status: 500,
      body: { detail: "boom" },
    };

    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.channels).toEqual(["slack", "telegram", "phone"]);
  });

  test("base list only when platform fetch throws (best-effort)", async () => {
    mockFetchThrows = true;

    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.channels).toEqual(["slack", "telegram", "phone"]);
  });

  test("base list only when no platformAssistantId on client", async () => {
    mockPlatformAssistantId = null;

    const result = (await handler({})) as {
      success: boolean;
      channels: string[];
    };

    expect(result.channels).toEqual(["slack", "telegram", "phone"]);
  });
});
