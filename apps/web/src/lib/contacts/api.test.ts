/**
 * Tests for `connectToAssistant` in `@/lib/contacts/api`.
 *
 * Mocks the HeyAPI client's `post` method to isolate the function under test
 * from the network layer. Each test verifies a specific branch in the
 * response-handling logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { ApiError } from "@/lib/api/errors.js";

// Stub the HeyAPI client before importing the module under test.
const mockPost = mock<() => Promise<unknown>>(() =>
  Promise.resolve({ data: undefined, error: undefined, response: undefined }),
);

// The module imports `client` from `@/clients/platform/client.gen` —
// override it so `connectToAssistant` calls our mock instead.
mock.module("@/clients/platform/client.gen", () => ({
  client: {
    post: mockPost,
    get: mock(() => Promise.resolve({})),
    delete: mock(() => Promise.resolve({})),
    patch: mock(() => Promise.resolve({})),
    interceptors: { request: { use: () => {} }, response: { use: () => {} } },
  },
}));

// Prevent the side-effect import from crashing (it registers interceptors).
mock.module("@/lib/vellum-api/client.js", () => ({}));

// Importing after the mock is registered so the module picks it up.
const { connectToAssistant } = await import("@/lib/contacts/api.js");

afterEach(() => {
  mockPost.mockReset();
});

describe("connectToAssistant", () => {
  test("successful 200 with contactId returns the response", async () => {
    const body = { success: true, contactId: "c-123" };
    mockPost.mockResolvedValueOnce({
      data: body,
      error: undefined,
      response: new Response(JSON.stringify(body), { status: 200 }),
    });

    const result = await connectToAssistant("asst-1", {
      guardianHandle: "alice",
      gatewayUrl: "https://alice.vellum.app",
    });

    expect(result).toEqual(body);
  });

  test("200 with missing contactId throws ApiError(500)", async () => {
    const body = { success: true };
    mockPost.mockResolvedValueOnce({
      data: body,
      error: undefined,
      response: new Response(JSON.stringify(body), { status: 200 }),
    });

    await expect(
      connectToAssistant("asst-1", {
        guardianHandle: "alice",
        gatewayUrl: "https://alice.vellum.app",
      }),
    ).rejects.toThrow("Connect succeeded but no contactId returned");

    try {
      mockPost.mockResolvedValueOnce({
        data: body,
        error: undefined,
        response: new Response(JSON.stringify(body), { status: 200 }),
      });
      await connectToAssistant("asst-1", {
        guardianHandle: "alice",
        gatewayUrl: "https://alice.vellum.app",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
    }
  });

  test("non-200 response throws ApiError with extracted message", async () => {
    const errorBody = { detail: "Rate limit exceeded" };
    mockPost.mockResolvedValueOnce({
      data: undefined,
      error: errorBody,
      response: new Response(JSON.stringify(errorBody), { status: 429 }),
    });

    try {
      await connectToAssistant("asst-1", {
        guardianHandle: "alice",
        gatewayUrl: "https://alice.vellum.app",
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).message).toBe("Rate limit exceeded");
    }
  });

  test("alreadyConnected response with contactId returns normally", async () => {
    const body = { success: true, contactId: "c-existing", alreadyConnected: true };
    mockPost.mockResolvedValueOnce({
      data: body,
      error: undefined,
      response: new Response(JSON.stringify(body), { status: 200 }),
    });

    const result = await connectToAssistant("asst-1", {
      guardianHandle: "alice",
      gatewayUrl: "https://alice.vellum.app",
    });

    expect(result).toEqual(body);
    expect(result.alreadyConnected).toBe(true);
    expect(result.contactId).toBe("c-existing");
  });
});
