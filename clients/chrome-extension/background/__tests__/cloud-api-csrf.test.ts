/**
 * Tests for getCsrfToken — verifies that the CSRF helper reads the
 * Django csrftoken cookie via chrome.cookies.get().
 */

import { describe, test, expect, beforeEach } from "bun:test";

// ── Chrome cookies mock ─────────────────────────────────────────────

let mockCookieValue: string | null = null;
let lastGetArgs: { name: string; url: string } | null = null;

const mockChrome = {
  cookies: {
    get: async (details: { name: string; url: string }) => {
      lastGetArgs = details;
      if (mockCookieValue === null) return null;
      return { value: mockCookieValue };
    },
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { id: "test-extension-id" },
};

(globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

// Import after mocking chrome globals
const { getCsrfToken } = await import("../cloud-api.js");

describe("getCsrfToken", () => {
  beforeEach(() => {
    mockCookieValue = null;
    lastGetArgs = null;
  });

  test("returns cookie value when present", async () => {
    mockCookieValue = "abc123csrf";
    const token = await getCsrfToken("https://api.vellum.ai");
    expect(token).toBe("abc123csrf");
    expect(lastGetArgs).toEqual({
      name: "csrftoken",
      url: "https://api.vellum.ai",
    });
  });

  test("returns null when cookie is missing", async () => {
    mockCookieValue = null;
    const token = await getCsrfToken("https://api.vellum.ai");
    expect(token).toBeNull();
  });

  test("returns null when chrome.cookies.get throws", async () => {
    mockChrome.cookies.get = async () => {
      throw new Error("permission denied");
    };
    const token = await getCsrfToken("https://api.vellum.ai");
    expect(token).toBeNull();
    // Restore
    mockChrome.cookies.get = async (d: { name: string; url: string }) => {
      lastGetArgs = d;
      if (mockCookieValue === null) return null;
      return { value: mockCookieValue };
    };
  });
});
