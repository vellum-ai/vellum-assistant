/**
 * Tests for the small bits of logic in `profile.ts` — server-error parsing
 * and the static error-copy map. The fetch wrappers are exercised
 * end-to-end via the Django integration tests; we don't duplicate that
 * surface here.
 */

import { describe, expect, test } from "bun:test";

import {
  checkUsernameAvailable,
  updateMe,
  USERNAME_ERROR_COPY,
} from "@/lib/account/profile.js";

// ---------------------------------------------------------------------------
// USERNAME_ERROR_COPY parity with backend codes
// ---------------------------------------------------------------------------

describe("USERNAME_ERROR_COPY", () => {
  test("covers every backend error code", () => {
    // Mirror of constants in django/app/users/username_validation.py.
    // Keep in sync — adding a new code on the backend requires a copy
    // string here.
    const backendCodes = [
      "too_short",
      "too_long",
      "invalid_chars",
      "leading_underscore",
      "trailing_underscore",
      "leading_hyphen",
      "trailing_hyphen",
      "all_digits",
      "reserved",
      "taken",
    ];
    for (const code of backendCodes) {
      expect(USERNAME_ERROR_COPY).toHaveProperty(code);
      expect(typeof (USERNAME_ERROR_COPY as Record<string, string>)[code]).toBe(
        "string",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// updateMe — response mapping
//
// These exercise the discriminator logic without depending on the real
// HeyAPI client; we patch `globalThis.fetch` per test.
// ---------------------------------------------------------------------------

function mockFetch(
  status: number,
  body: unknown,
): typeof globalThis.fetch {
  const impl = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return impl as unknown as typeof globalThis.fetch;
}

describe("updateMe", () => {
  test("returns ok on 200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      id: "u1",
      username: "noaflaherty",
      email: "noa@example.com",
      first_name: "Noa",
      last_name: "Flaherty",
    });
    try {
      const result = await updateMe({ username: "noaflaherty" });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.data.username).toBe("noaflaherty");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns taken on 409", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(409, {
      detail: "This handle is already taken.",
      code: "taken",
    });
    try {
      const result = await updateMe({ username: "noaflaherty" });
      expect(result.kind).toBe("taken");
      if (result.kind === "taken") {
        expect(result.message).toContain("taken");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns invalid with code on 400 DRF error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(400, {
      username: [
        { code: "too_short", string: "Must be at least 3 characters." },
      ],
    });
    try {
      const result = await updateMe({ username: "ab" });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.code).toBe("too_short");
        expect(result.message).toContain("3 characters");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns invalid with null code when DRF gives plain string", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(400, {
      username: ["Some message"],
    });
    try {
      const result = await updateMe({ username: "ab" });
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.code).toBeNull();
        expect(result.message).toBe("Some message");
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns error on 500", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(500, { detail: "boom" });
    try {
      const result = await updateMe({ username: "noaflaherty" });
      expect(result.kind).toBe("error");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// checkUsernameAvailable — probe-failure modes
//
// The save gate in UsernameCard treats a thrown probe as "unknown, allow
// save" rather than "blocked". Verify the wrapper actually throws on 429
// and other non-2xx — a regression to "return { available: false }" would
// silently lock users out during a rate-limit window.
// ---------------------------------------------------------------------------

describe("checkUsernameAvailable", () => {
  test("returns availability data on 200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      available: true,
      code: null,
      message: null,
    });
    try {
      const result = await checkUsernameAvailable("noaflaherty");
      expect(result.available).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on 429 so the save gate isn't locked", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(429, { detail: "rate limited" });
    try {
      await expect(checkUsernameAvailable("noaflaherty")).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on 5xx so the save gate isn't locked", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(503, { detail: "boom" });
    try {
      await expect(checkUsernameAvailable("noaflaherty")).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
