/**
 * Tests for ``domains/account/handle.ts`` — the discriminator mapping and
 * the rate-limit-throws contract. Mirrors the user-handle surface in
 * ``domains/account/profile.ts``; the surfaces share an error-code
 * vocabulary by design, so any divergence between these two files is a
 * smell worth investigating.
 *
 * The actual HTTP path is exercised end-to-end by the Django integration
 * tests on the platform side. Here we just verify the client wrappers map
 * server responses to the right discriminator variant.
 */

import { describe, expect, test } from "bun:test";

import {
  HANDLE_ERROR_COPY,
  checkAssistantHandleAvailable,
  updateAssistantHandle,
} from "@/domains/account/handle";

// ---------------------------------------------------------------------------
// HANDLE_ERROR_COPY parity with backend codes
// ---------------------------------------------------------------------------

describe("HANDLE_ERROR_COPY", () => {
  test("covers every backend error code", () => {
    // Mirror of constants in django/app/assistant/handle_validation.py.
    // Keep in sync — adding a new code on the backend requires a copy
    // string here. The set is identical to the user-handle surface by
    // design (same vocabulary, same copy strings).
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
      expect(HANDLE_ERROR_COPY).toHaveProperty(code);
      expect(typeof (HANDLE_ERROR_COPY as Record<string, string>)[code]).toBe(
        "string",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// updateAssistantHandle — response mapping
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  const impl = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return impl as unknown as typeof globalThis.fetch;
}

const ASSISTANT_ID = "01952ab4-1c43-7c20-9c5e-5b9c3a8a4421";

describe("updateAssistantHandle", () => {
  test("returns ok on 200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      id: ASSISTANT_ID,
      name: "My Assistant",
      handle: "my-bot",
    });
    try {
      const result = await updateAssistantHandle(ASSISTANT_ID, "my-bot");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.data.handle).toBe("my-bot");
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
      const result = await updateAssistantHandle(ASSISTANT_ID, "claimed");
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
      handle: [
        { code: "too_short", string: "Must be at least 3 characters." },
      ],
    });
    try {
      const result = await updateAssistantHandle(ASSISTANT_ID, "ab");
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
    // The user surface has this same fallback; the assistant validator
    // raises with ``code=`` so this is mostly defensive — but if a future
    // change in the serializer falls back to a plain ValidationError, we
    // want the wrapper to keep mapping it to ``invalid`` (not ``error``).
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(400, {
      handle: ["Some message"],
    });
    try {
      const result = await updateAssistantHandle(ASSISTANT_ID, "ab");
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
      const result = await updateAssistantHandle(ASSISTANT_ID, "anything");
      expect(result.kind).toBe("error");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// checkAssistantHandleAvailable — probe-failure modes
//
// The save gate in AssistantHandleSection treats a thrown probe as
// "unknown, allow save" rather than "blocked". A regression to
// ``return { available: false }`` on 429/5xx would silently lock users out
// during a rate-limit window or transient outage — these tests pin that
// behavior.
// ---------------------------------------------------------------------------

describe("checkAssistantHandleAvailable", () => {
  test("returns availability data on 200", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      available: true,
      code: null,
      message: null,
    });
    try {
      const result = await checkAssistantHandleAvailable(ASSISTANT_ID, "fresh");
      expect(result.available).toBe(true);
      expect(result.code).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns taken result on 200 with taken code", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      available: false,
      code: "taken",
      message: "This handle is already taken.",
    });
    try {
      const result = await checkAssistantHandleAvailable(ASSISTANT_ID, "x");
      expect(result.available).toBe(false);
      expect(result.code).toBe("taken");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on 429 so the save gate isn't locked", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(429, { detail: "rate limited" });
    try {
      await expect(
        checkAssistantHandleAvailable(ASSISTANT_ID, "noaflaherty"),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("throws on 5xx so the save gate isn't locked", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(503, { detail: "boom" });
    try {
      await expect(
        checkAssistantHandleAvailable(ASSISTANT_ID, "noaflaherty"),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
