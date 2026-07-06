/**
 * Daemon-side tests for the `config_set` and `config_allowlist_validate`
 * IPC routes. Exercises input validation + error handling on the route
 * handlers directly (Codex review feedback on PR #30262).
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ---------------------------------------------------------------------------
// Mocks for handleSetConfig's transitive deps
// ---------------------------------------------------------------------------

let savedRaw: Record<string, unknown> | null = null;
let rawConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRaw = raw;
  },
  deepMergeOverwrite: () => {},
  getConfig: () => rawConfig,
  invalidateConfigCache: () => {},
  withSuppressedConfigDiskWrites: async (fn: () => unknown) => fn(),
  withSuppressedConfigDiskWritesSync: (fn: () => unknown) => fn(),
  // setNestedValue is also exported by loader; handleSetConfig imports the
  // real one from this module, so we re-export a thin implementation that
  // mutates in place (matches loader's behavior).
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => {
    const keys = path.split(".");
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (current[key] == null || typeof current[key] !== "object") {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;
  },
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

// ---------------------------------------------------------------------------
// Mock the allowlist module so we can drive throw / return paths
// ---------------------------------------------------------------------------

let mockAllowlistResult:
  | {
      kind: "ok";
      value: Array<{ index: number; pattern: string; message: string }> | null;
    }
  | { kind: "throw"; error: Error } = { kind: "ok", value: null };

mock.module("../security/secret-allowlist.js", () => ({
  validateAllowlistFile: () => {
    if (mockAllowlistResult.kind === "throw") {
      throw mockAllowlistResult.error;
    }
    return mockAllowlistResult.value;
  },
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

const configSetRoute = ROUTES.find((r) => r.operationId === "config_set")!;
const allowlistRoute = ROUTES.find(
  (r) => r.operationId === "config_allowlist_validate",
)!;

// ---------------------------------------------------------------------------
// config_set request validation
// ---------------------------------------------------------------------------

describe("config_set route - request validation", () => {
  test("rejects body with missing value field (P2 - Codex)", async () => {
    // Body has a path but no value key — would otherwise pass `undefined`
    // through setNestedValue and silently drop the key on save.
    await expect(
      configSetRoute.handler({ body: { path: "foo.bar" } }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      configSetRoute.handler({ body: { path: "foo.bar" } }),
    ).rejects.toThrow("`value` is required");
  });

  test("accepts explicit null on a nullable scalar field (persists null)", async () => {
    // `llmRequestLogRetentionMs` is schema-nullable (null = "no limit"), so an
    // explicit-null set is a valid whole-config write and must persist as null.
    rawConfig = { memory: { cleanup: { llmRequestLogRetentionMs: 86400000 } } };
    savedRaw = null;
    const result = await configSetRoute.handler({
      body: { path: "memory.cleanup.llmRequestLogRetentionMs", value: null },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
    const cleanup = (
      (savedRaw as unknown as Record<string, unknown>).memory as Record<
        string,
        unknown
      >
    ).cleanup as Record<string, unknown>;
    expect(cleanup.llmRequestLogRetentionMs).toBeNull();
  });

  test("rejects a write whose merged config fails the schema (invalid enum)", async () => {
    // `source` accepts only "managed" | "user"; "custom" is rejected. Using a
    // non-managed profile so the generic schema gate fires (managed profiles
    // hit the read-only guard first). The error must name the offending path
    // and state nothing was written.
    rawConfig = {
      llm: {
        profiles: {
          "my-custom": {
            source: "user",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    savedRaw = null;
    await expect(
      configSetRoute.handler({
        body: { path: "llm.profiles.my-custom.source", value: "custom" },
      }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      configSetRoute.handler({
        body: { path: "llm.profiles.my-custom.source", value: "custom" },
      }),
    ).rejects.toThrow(/llm\.profiles\.my-custom\.source: .*managed.*user/);
    await expect(
      configSetRoute.handler({
        body: { path: "llm.profiles.my-custom.source", value: "custom" },
      }),
    ).rejects.toThrow(/nothing was written/);
    // No write reached disk.
    expect(savedRaw).toBeNull();
  });

  test("rejects a write introducing an unknown llm.callSites key", async () => {
    rawConfig = {};
    savedRaw = null;
    await expect(
      configSetRoute.handler({
        body: {
          path: "llm.callSites.doesNotExist.profile",
          value: "balanced",
        },
      }),
    ).rejects.toThrow(/llm\.callSites\.doesNotExist/);
    expect(savedRaw).toBeNull();
  });

  test("clearing an object profile entry with null deletes it and validates as absent", async () => {
    // `set llm.profiles.gemini-probe null` removes the entry. The merged config
    // validates with the key absent (an explicit null would fail ProfileEntry).
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
          "gemini-probe": {
            source: "user",
            provider: "google",
            model: "gemini-2.0-flash",
          },
        },
      },
    };
    savedRaw = null;
    const result = await configSetRoute.handler({
      body: { path: "llm.profiles.gemini-probe", value: null },
    });
    expect(result).toEqual({ ok: true });
    const profiles = (
      (savedRaw as unknown as Record<string, unknown>).llm as Record<
        string,
        unknown
      >
    ).profiles as Record<string, unknown>;
    expect("gemini-probe" in profiles).toBe(false);
    expect(profiles.balanced).toBeDefined();
  });

  test("partial-path write validates the merged whole config, not just the fragment", async () => {
    // `activeProfile` alone parses fine, but the merged config still carries an
    // invalid on-disk profile-source, so the write is rejected on the merge.
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            source: "bogus",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    savedRaw = null;
    await expect(
      configSetRoute.handler({
        body: { path: "llm.activeProfile", value: "balanced" },
      }),
    ).rejects.toThrow(/llm\.profiles\.balanced\.source/);
    expect(savedRaw).toBeNull();
  });

  test("rejects body missing path field", async () => {
    await expect(
      configSetRoute.handler({ body: { value: "foo" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects body that is not a plain object", async () => {
    // Pass null/array via the unknown cast because RouteHandlerArgs.body
    // narrows to Record<string, unknown> | undefined - we explicitly want
    // to test the runtime guard against malformed inputs.
    await expect(
      configSetRoute.handler({
        body: null as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      configSetRoute.handler({
        body: [] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("accepts a normal scalar set and writes to raw config", async () => {
    rawConfig = {};
    savedRaw = null;
    const result = await configSetRoute.handler({
      body: { path: "calls.enabled", value: true },
    });
    expect(result).toEqual({ ok: true });
    const calls = (savedRaw as unknown as Record<string, unknown>)
      .calls as Record<string, unknown>;
    expect(calls.enabled).toBe(true);
  });

  test("preserves user profiles and custom settings when setting unrelated key", async () => {
    rawConfig = {
      llm: {
        activeProfile: "my-custom-profile",
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
          "my-custom-profile": {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-6",
            maxTokens: 32000,
          },
        },
      },
      memory: {
        embeddings: { provider: "openai" },
      },
    };
    savedRaw = null;
    const result = await configSetRoute.handler({
      body: {
        path: "memory.cleanup.llmRequestLogRetentionMs",
        value: 86400000,
      },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();

    const saved = savedRaw as unknown as Record<string, unknown>;
    const llm = saved.llm as Record<string, unknown>;
    expect(llm.activeProfile).toBe("my-custom-profile");

    const profiles = llm.profiles as Record<string, Record<string, unknown>>;
    expect(profiles["my-custom-profile"]).toEqual({
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-6",
      maxTokens: 32000,
    });
    expect(profiles.balanced).toEqual({
      source: "managed",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const memory = saved.memory as Record<string, unknown>;
    expect((memory.embeddings as Record<string, unknown>).provider).toBe(
      "openai",
    );
    expect(
      (memory.cleanup as Record<string, unknown>).llmRequestLogRetentionMs,
    ).toBe(86400000);
  });

  test("preserves all top-level keys when setting a nested path", async () => {
    rawConfig = {
      llm: { default: { provider: "anthropic" } },
      calls: { enabled: true },
      heartbeat: { activeHoursStart: 9, activeHoursEnd: 22 },
    };
    savedRaw = null;
    await configSetRoute.handler({
      body: { path: "memory.cleanup.conversationRetentionDays", value: 30 },
    });
    expect(savedRaw).not.toBeNull();
    const saved = savedRaw as unknown as Record<string, unknown>;
    expect(saved.llm).toEqual({ default: { provider: "anthropic" } });
    expect(saved.calls).toEqual({ enabled: true });
    expect(saved.heartbeat).toEqual({
      activeHoursStart: 9,
      activeHoursEnd: 22,
    });
  });
});

// ---------------------------------------------------------------------------
// config_allowlist_validate error handling
// ---------------------------------------------------------------------------

describe("config_allowlist_validate route - error handling", () => {
  test("returns parseError when validateAllowlistFile throws (P3 - Codex)", () => {
    mockAllowlistResult = {
      kind: "throw",
      error: new SyntaxError("Unexpected token } in JSON at position 42"),
    };

    const result = allowlistRoute.handler({}) as {
      exists: boolean;
      parseError?: string;
      errors: unknown[];
    };
    expect(result.exists).toBe(true);
    expect(result.parseError).toContain("Unexpected token");
    expect(result.errors).toEqual([]);
  });

  test("returns { exists: false } when file is absent", () => {
    mockAllowlistResult = { kind: "ok", value: null };
    const result = allowlistRoute.handler({}) as { exists: boolean };
    expect(result.exists).toBe(false);
  });

  test("returns { exists: true, errors } when file is valid", () => {
    mockAllowlistResult = { kind: "ok", value: [] };
    const result = allowlistRoute.handler({}) as {
      exists: boolean;
      errors: unknown[];
    };
    expect(result.exists).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("returns { exists: true, errors } with details when patterns are invalid", () => {
    mockAllowlistResult = {
      kind: "ok",
      value: [{ index: 0, pattern: "(", message: "Unterminated group" }],
    };
    const result = allowlistRoute.handler({}) as {
      exists: boolean;
      errors: Array<{ index: number; pattern: string; message: string }>;
    };
    expect(result.exists).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Unterminated group");
  });
});
