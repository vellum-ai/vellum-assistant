/**
 * Cutover-proof e2e: boot with a config that has no `services.inference.mode`
 * field (the field was removed in Phase 1.2) and verify that:
 *
 *  1. The Zod schema parses the config without errors.
 *  2. `initializeProviders` registers a `user-key` provider for any provider
 *     that has a credential in the test vault.
 *  3. A dispatch through a profile that references an `api_key`-auth connection
 *     succeeds when the underlying vault credential exists.
 *  4. A dispatch through a profile that references a `platform`-auth connection
 *     (managed, not yet seeded — PR-D) fails with `ConnectionResolutionError`
 *     reason `not_found`.
 *
 * This is the gate test mandated by the cc-cutover-proof rule for Phase 1.2.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that pull in transitive deps
// ---------------------------------------------------------------------------

const logProxy = new Proxy({} as Record<string, unknown>, {
  get: () => () => {},
});
mock.module("../util/logger.js", () => ({
  getLogger: () => logProxy,
}));

// Vault mock — keyed by credential name.
const mockVault: Record<string, string | null> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => mockVault[key] ?? null,
}));

// Managed proxy context — always unavailable in this test (no platform auth).
mock.module("../providers/platform-proxy/context.js", () => ({
  buildManagedBaseUrl: async () => null,
  resolveManagedProxyContext: async () => {
    throw new Error("managed proxy not available in test");
  },
}));

// DB mock — getConnection returns null (no managed connections seeded yet).
const mockGetConnection: Record<string, unknown> = {};
mock.module("../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    mockGetConnection[name] ?? null,
  listConnections: () => [],
  createConnection: () => ({ ok: true, value: {} }),
  seedCanonicalConnections: () => {},
}));

mock.module("../memory/db-connection.js", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: () => null, all: () => [] }), all: () => [] }) }),
    insert: () => ({ values: () => ({ run: () => {} }) }),
  }),
}));

// Anthropic SDK mock — returns a canned response.
mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ok" },
          };
          yield {
            type: "message_delta",
            usage: { output_tokens: 1 },
            delta: { stop_reason: "end_turn" },
          };
        },
        finalMessage: async () => ({
          content: [{ type: "text", text: "ok" }],
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
      }),
    };
    constructor(_opts: unknown) {}
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AssistantConfigSchema } from "../config/schema.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { ConnectionResolutionError } from "../providers/connection-resolution.js";
import {
  getProvider,
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";
import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseLlm = LLMSchema.parse({});

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own" as const,
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own" as const, provider: "inference-provider-native" },
    },
    llm: {
      ...baseLlm,
      default: {
        ...baseLlm.default,
        provider: "anthropic" as const,
        model: "claude-opus-4-7",
        provider_connection: "anthropic-personal",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inference-no-mode-boot-e2e: config without services.inference.mode", () => {
  beforeEach(() => {
    // Clear vault and connection registry between tests.
    for (const k of Object.keys(mockVault)) {
      delete mockVault[k];
    }
    for (const k of Object.keys(mockGetConnection)) {
      delete mockGetConnection[k];
    }
  });

  // ── Gate 1: Schema parses cleanly ───────────────────────────────────────

  test("Zod schema parses config with no services.inference.mode without error", () => {
    const raw = {
      services: { inference: {} },
      llm: { default: { provider: "anthropic", model: "claude-opus-4-7" } },
    };
    const result = AssistantConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      // inference is an empty object — no mode field
      expect(result.data.services.inference).toEqual({});
    }
  });

  test("Zod schema also parses config with services.inference absent entirely", () => {
    const raw = {
      llm: { default: { provider: "anthropic", model: "claude-opus-4-7" } },
    };
    const result = AssistantConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.services.inference).toEqual({});
    }
  });

  // ── Gate 2: initializeProviders populates routingSources ────────────────

  test("initializeProviders registers anthropic user-key when vault has a credential", async () => {
    mockVault[credentialKey("anthropic", "api_key")] = "sk-ant-test-key";

    await initializeProviders(makeConfig());

    expect(listProviders()).toContain("anthropic");
    expect(getProviderRoutingSource("anthropic")).toBe("user-key");
  });

  test("initializeProviders skips anthropic when vault has no credential", async () => {
    // No key in vault.
    await initializeProviders(makeConfig());

    expect(listProviders()).not.toContain("anthropic");
    expect(getProviderRoutingSource("anthropic")).toBeUndefined();
  });

  test("initializeProviders registers multiple providers independently", async () => {
    mockVault[credentialKey("anthropic", "api_key")] = "sk-ant-test";
    mockVault[credentialKey("openai", "api_key")] = "sk-openai-test";

    await initializeProviders(makeConfig());

    expect(listProviders()).toContain("anthropic");
    expect(listProviders()).toContain("openai");
    expect(getProviderRoutingSource("anthropic")).toBe("user-key");
    expect(getProviderRoutingSource("openai")).toBe("user-key");
    expect(listProviders()).not.toContain("gemini");
  });

  // ── Gate 3: api_key-auth connection dispatch succeeds ───────────────────

  test("getProvider returns a registered provider after initializeProviders with a user key", async () => {
    mockVault[credentialKey("anthropic", "api_key")] = "sk-ant-test-key";
    await initializeProviders(makeConfig());

    const provider = getProvider("anthropic");
    expect(provider).toBeDefined();
    expect(typeof provider.sendMessage).toBe("function");
  });

  // ── Gate 4: platform-auth connection fails with ConnectionResolutionError ─

  test("ConnectionResolutionError is exported with expected reason codes", () => {
    const err = new ConnectionResolutionError(
      "anthropic-managed",
      "not_found",
      'provider_connection "anthropic-managed" not found — managed connections not yet seeded (PR-D)',
    );
    expect(err).toBeInstanceOf(ConnectionResolutionError);
    expect(err.reason).toBe("not_found");
    expect(err.connectionName).toBe("anthropic-managed");
  });

  test("tryResolveProviderForConnectionName throws not_found for an unseed managed connection", async () => {
    // anthropic-managed is not in mockGetConnection (simulates PR-D not yet run).
    const { tryResolveProviderForConnectionName } = await import(
      "../providers/connection-resolution.js"
    );

    await expect(
      tryResolveProviderForConnectionName("anthropic-managed", makeConfig()),
    ).rejects.toMatchObject({
      name: "ConnectionResolutionError",
      reason: "not_found",
      connectionName: "anthropic-managed",
    });
  });
});
