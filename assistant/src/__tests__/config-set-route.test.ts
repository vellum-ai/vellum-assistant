/**
 * Daemon-side tests for the `config_set` and `config_allowlist_validate`
 * IPC routes. Exercises input validation + error handling on the route
 * handlers directly (Codex review feedback on PR #30262).
 */

import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks for handleSetConfig's transitive deps
// ---------------------------------------------------------------------------

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

import { loadRawConfig } from "../config/loader.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

/**
 * Replace the workspace config.json with exactly `config`. The route under
 * test edits the raw file wholesale, so each test starts from a complete
 * known file state rather than composing per-key seeds. Bumps the mtime
 * monotonically so the loader's file-signature cache re-reads (same trick as
 * helpers/set-config.ts).
 */
let mtimeSeq = 0;
function seedRawConfig(config: Record<string, unknown>): void {
  const path = join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");
  writeFileSync(path, JSON.stringify(config));
  mtimeSeq += 1;
  const stamp = new Date(Date.now() + mtimeSeq);
  utimesSync(path, stamp, stamp);
}

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

  test("accepts body with explicit null value", async () => {
    seedRawConfig({ heartbeat: { activeHoursStart: 9 } });
    const result = await configSetRoute.handler({
      body: { path: "heartbeat.activeHoursStart", value: null },
    });
    expect(result).toEqual({ ok: true });
    const heartbeat = loadRawConfig().heartbeat as Record<string, unknown>;
    expect(heartbeat.activeHoursStart).toBeNull();
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
    seedRawConfig({});
    const result = await configSetRoute.handler({
      body: { path: "calls.enabled", value: true },
    });
    expect(result).toEqual({ ok: true });
    const calls = loadRawConfig().calls as Record<string, unknown>;
    expect(calls.enabled).toBe(true);
  });

  test("preserves user profiles and custom settings when setting unrelated key", async () => {
    seedRawConfig({
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
    });
    const result = await configSetRoute.handler({
      body: {
        path: "memory.cleanup.llmRequestLogRetentionMs",
        value: 86400000,
      },
    });
    expect(result).toEqual({ ok: true });

    const saved = loadRawConfig();
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
    seedRawConfig({
      llm: { default: { provider: "anthropic" } },
      calls: { enabled: true },
      heartbeat: { activeHoursStart: 9, activeHoursEnd: 22 },
    });
    await configSetRoute.handler({
      body: { path: "memory.cleanup.conversationRetentionDays", value: 30 },
    });
    const saved = loadRawConfig();
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
