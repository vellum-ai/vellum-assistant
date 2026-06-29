/**
 * Tests for per-connection managed credential option resolution.
 *
 * Exercises the production `resolveManagedOptions` from
 * `managed-lazy-getters.ts` directly, ensuring regressions in key precedence,
 * per-connection resolution, and fail-closed graceful degradation are caught.
 */

import { describe, expect, test } from "bun:test";

import { resolveManagedOptions } from "../managed-lazy-getters.js";
import type { SessionContext } from "../server.js";

const PLATFORM = "https://api.vellum.ai";

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "test-session",
    assistantApiKey: "",
    assistantId: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fail-closed: missing required fields → undefined
// ---------------------------------------------------------------------------

describe("resolveManagedOptions — fail closed", () => {
  test("missing platformBaseUrl returns undefined even with key and id", () => {
    expect(
      resolveManagedOptions({
        platformBaseUrl: "",
        ctx: ctx({ assistantApiKey: "vak_key", assistantId: "ast_1" }),
      }),
    ).toBeUndefined();
  });

  test("missing API key (no ctx key, no env) returns undefined", () => {
    expect(
      resolveManagedOptions({
        platformBaseUrl: PLATFORM,
        ctx: ctx({ assistantId: "ast_1" }),
      }),
    ).toBeUndefined();
  });

  test("missing assistant ID returns undefined even with key", () => {
    expect(
      resolveManagedOptions({
        platformBaseUrl: PLATFORM,
        ctx: ctx({ assistantApiKey: "vak_key" }),
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resolution from the connection's context
// ---------------------------------------------------------------------------

describe("resolveManagedOptions — from context", () => {
  test("ctx key + id produces both subject and materializer options", () => {
    const result = resolveManagedOptions({
      platformBaseUrl: PLATFORM,
      ctx: ctx({ assistantApiKey: "vak_key", assistantId: "ast_abc" }),
    });

    expect(result).toBeDefined();
    expect(result!.subjectOptions).toEqual({
      platformBaseUrl: PLATFORM,
      assistantApiKey: "vak_key",
      assistantId: "ast_abc",
    });
    // Both options carry the same identity.
    expect(result!.materializerOptions).toEqual(result!.subjectOptions);
  });

  test("env API key is used when the connection forwarded none", () => {
    const result = resolveManagedOptions({
      platformBaseUrl: PLATFORM,
      envApiKey: "vak_env_fallback",
      ctx: ctx({ assistantId: "ast_abc" }),
    });

    expect(result).toBeDefined();
    expect(result!.materializerOptions.assistantApiKey).toBe("vak_env_fallback");
  });

  test("connection-forwarded key takes precedence over the env key", () => {
    const result = resolveManagedOptions({
      platformBaseUrl: PLATFORM,
      envApiKey: "vak_env_key",
      ctx: ctx({ assistantApiKey: "vak_handshake_key", assistantId: "ast_abc" }),
    });

    expect(result!.subjectOptions.assistantApiKey).toBe("vak_handshake_key");
  });
});

// ---------------------------------------------------------------------------
// Per-connection isolation
// ---------------------------------------------------------------------------

describe("resolveManagedOptions — per-connection isolation", () => {
  test("two contexts resolve independently (no shared mutable state)", () => {
    const a = resolveManagedOptions({
      platformBaseUrl: PLATFORM,
      ctx: ctx({ assistantApiKey: "key_a", assistantId: "ast_a" }),
    });
    const b = resolveManagedOptions({
      platformBaseUrl: PLATFORM,
      ctx: ctx({ assistantApiKey: "key_b", assistantId: "ast_b" }),
    });

    expect(a!.materializerOptions.assistantApiKey).toBe("key_a");
    expect(a!.materializerOptions.assistantId).toBe("ast_a");
    expect(b!.materializerOptions.assistantApiKey).toBe("key_b");
    expect(b!.materializerOptions.assistantId).toBe("ast_b");
  });

  test("a context that carries a key but no assistant ID fails closed", () => {
    // Mirrors a connection that forwarded a key without an assistant ID — it
    // must not materialize using any other connection's ID.
    expect(
      resolveManagedOptions({
        platformBaseUrl: PLATFORM,
        envApiKey: "vak_env",
        ctx: ctx({ assistantApiKey: "key_only" }),
      }),
    ).toBeUndefined();
  });
});
