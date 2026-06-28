/**
 * Tests for the Codex-subscription model-compatibility gate on auto-resolved
 * provider connections.
 *
 * When a profile uses "Any active OpenAI connection" (no `provider_connection`
 * pinned), the daemon auto-picks an active OpenAI connection. An
 * `oauth_subscription` (ChatGPT Codex) connection hard-routes to the Codex
 * endpoint, which rejects non-Codex models with HTTP 400. The gate skips such
 * a connection during auto-resolution unless the model is Codex-compatible.
 *
 * Two layers are covered:
 *   1. `isConnectionCompatibleWithModel` — the pure predicate.
 *   2. `getConfiguredProvider` — the auto-resolution path that uses the
 *      predicate as an additional `.find()` filter, plus the pinned-connection
 *      path which bypasses the gate entirely.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { isConnectionCompatibleWithModel } from "../connection-model-compat.js";
import type { Auth } from "../inference/auth.js";

// ---------------------------------------------------------------------------
// Pure predicate tests — no mocking required.
// ---------------------------------------------------------------------------

const apiKeyAuth: Auth = { type: "api_key", credential: "credential/x" };
const platformAuth: Auth = { type: "platform" };
const oauthAuth: Auth = {
  type: "oauth_subscription",
  credential: "credential/x",
};

describe("isConnectionCompatibleWithModel", () => {
  test("api_key connection is compatible with any model", () => {
    const conn = { auth: apiKeyAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4")).toBe(true);
  });

  test("platform connection is compatible with any model", () => {
    const conn = { auth: platformAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-nano")).toBe(true);
  });

  test("oauth_subscription connection is incompatible with a non-Codex model", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5")).toBe(false);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-nano")).toBe(false);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.5-pro")).toBe(false);
  });

  test("oauth_subscription connection is compatible with a Codex model", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.5")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-mini")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.3-codex")).toBe(true);
  });

  test("undefined model applies no gating (compatible)", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests through `getConfiguredProvider` — module mocks below must
// be declared before the import-under-test.
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

let mockLlmConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    services: { inference: { mode: "your-own" } },
  }),
}));

const mockDbSentinel = { __mock: "db" };
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => mockDbSentinel,
}));

type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

// Ordered list the mocked `listConnections` returns. `.find()` walks it in
// order, so insertion order is meaningful for these tests.
let fakeConnectionList: Connection[] = [];
const fakeConnectionsByName = new Map<string, Connection>();

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnectionsByName.get(name) ?? null,
  listConnections: (_db: unknown, filter?: { provider?: string }) =>
    filter?.provider
      ? fakeConnectionList.filter((c) => c.provider === filter.provider)
      : fakeConnectionList,
}));

// Records the connection name handed to the resolver so tests can assert
// which connection auto-resolution selected.
const resolveProviderCalls: Connection[] = [];

mock.module("../registry.js", () => ({
  getProvider: (name: string) => {
    throw new Error(`legacy getProvider should not be called: ${name}`);
  },
  initializeProviders: async () => {},
  listProviders: () => [{ name: "stub" }],
  resolveProviderFromConnection: async (connection: Connection) => {
    resolveProviderCalls.push(connection);
    return { name: connection.provider, tag: connection.name };
  },
}));

import { getConfiguredProvider } from "../provider-send-message.js";

function registerConnections(connections: Connection[]): void {
  fakeConnectionList = connections;
  for (const c of connections) fakeConnectionsByName.set(c.name, c);
}

function reset(): void {
  resolveProviderCalls.length = 0;
  fakeConnectionList = [];
  fakeConnectionsByName.clear();
  mockLlmConfig = {};
}

const OPENAI_KEY: Connection = {
  name: "openai-key",
  provider: "openai",
  auth: { type: "api_key", credential: "credential/openai" },
};
const OPENAI_CODEX: Connection = {
  name: "openai-codex",
  provider: "openai",
  auth: {
    type: "oauth_subscription",
    credential: "credential/openai-codex/access_token",
  },
};

describe("auto-resolution skips oauth_subscription connections for non-Codex models", () => {
  beforeEach(reset);

  test("non-Codex model picks the api_key connection over a (first-listed) oauth_subscription one", async () => {
    // oauth_subscription listed FIRST — without the gate, insertion order
    // would have selected it and misrouted gpt-5 to the Codex endpoint.
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    setOpenAiProfile("gpt-5");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-key");
  });

  test("Codex model can select the oauth_subscription connection", async () => {
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    setOpenAiProfile("gpt-5.4");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-codex");
  });

  test("non-Codex model with only an oauth_subscription connection resolves to null (no misroute)", async () => {
    // Pure-predicate gate: the lone oauth_subscription connection is filtered
    // out, so auto-resolution finds nothing and the call site falls back
    // gracefully rather than dispatching gpt-5 to the Codex endpoint.
    registerConnections([OPENAI_CODEX]);
    setOpenAiProfile("gpt-5");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).toBeNull();
    expect(resolveProviderCalls.length).toBe(0);
  });

  test("explicitly pinned oauth_subscription connection is used regardless of model", async () => {
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    mockLlmConfig = {
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "openai-pinned": {
          provider: "openai",
          model: "gpt-5",
          provider_connection: "openai-codex",
        },
      },
    };

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-pinned",
    });

    // The pinned connection bypasses the auto-resolution gate entirely.
    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-codex");
  });
});

function setOpenAiProfile(model: string): void {
  mockLlmConfig = {
    default: { provider: "anthropic", model: "claude-opus-4-7" },
    profiles: {
      // "Any active OpenAI connection" — provider set, no provider_connection.
      "openai-any": { provider: "openai", model },
    },
  };
}
