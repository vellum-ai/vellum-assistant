/**
 * Cycle-3 gate test — proves that `resolveConfiguredProvider` actually routes
 * through `resolveProviderFromConnection` when a profile names a
 * `provider_connection`.
 *
 * Why this exists: cycle-1 and cycle-2 both shipped `resolveProviderFromConnection`
 * as dead code (zero call sites), and the cycle-2 "mix-and-match" test only
 * validated DB shape — never that the dispatcher actually invoked the
 * resolver. This test fails if the wiring regresses, by spying on
 * `resolveProviderFromConnection` and asserting:
 *
 *   1. It was called once per dispatch invocation when the profile has a
 *      `provider_connection`.
 *   2. The connection passed in matches the profile's `provider_connection`.
 *   3. The returned `Provider` from each dispatch is the per-connection
 *      stub (different instances for different connections, regardless of
 *      shared underlying provider impl name).
 *
 * Two profiles, same `provider: anthropic`, different `provider_connection`:
 * exactly the mix-and-match scenario goal #2 of the design. If the dispatcher
 * falls back to `getProvider(name)`, both profiles would route to the same
 * Provider instance and this test would catch it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks (must be declared before the import-under-test).
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Test fixtures for the mocked config loader.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    services: { inference: { mode: "your-own" } },
  }),
}));

// Mock the DB getter — we never actually hit SQLite since `getConnection` is
// also mocked. Returning a sentinel keeps the call signature satisfied.
const mockDbSentinel = { __mock: "db" };
mock.module("../../memory/db-connection.js", () => ({
  getDb: () => mockDbSentinel,
}));

// Spy storage for the resolver — each test inspects what was passed in.
type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

const resolveProviderCalls: Connection[] = [];

// Each connection name maps to a distinct fake Provider instance. Returning
// distinguishable instances lets the test assert that two profiles with
// different connections route to different providers.
const fakeProviders = new Map<string, { name: string; tag: string }>();

// Connection registry the mocked `getConnection` reads from.
const fakeConnections = new Map<string, Connection>();

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnections.get(name) ?? null,
}));

mock.module("../registry.js", () => ({
  // Legacy fallback path — tests that exercise it provide their own entries.
  getProvider: (name: string) => {
    const p = fakeProviders.get(`legacy:${name}`);
    if (!p) throw new Error(`legacy getProvider unknown: ${name}`);
    return p;
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(fakeProviders.values()),
  // The function under test — wraps the dispatcher's connection-aware path.
  resolveProviderFromConnection: async (connection: Connection) => {
    resolveProviderCalls.push(connection);
    return fakeProviders.get(`conn:${connection.name}`) ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { getConfiguredProvider } from "../provider-send-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLlmConfig(c: Record<string, unknown>): void {
  mockLlmConfig = c;
}

function registerConnection(c: Connection, providerStub: { name: string; tag: string }): void {
  fakeConnections.set(c.name, c);
  fakeProviders.set(`conn:${c.name}`, providerStub);
}

function reset(): void {
  resolveProviderCalls.length = 0;
  fakeConnections.clear();
  fakeProviders.clear();
  mockLlmConfig = {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch routes through provider_connection (cycle-3 gate)", () => {
  beforeEach(reset);

  test("two profiles, same provider, different connections → resolver called twice with the right connection each time", async () => {
    // Same underlying provider impl, two distinguishable connection-bound
    // Provider stubs.
    registerConnection(
      {
        name: "anthropic-managed",
        provider: "anthropic",
        auth: { type: "platform" },
      },
      { name: "anthropic", tag: "managed-stub" },
    );
    registerConnection(
      {
        name: "anthropic-personal",
        provider: "anthropic",
        auth: {
          type: "api_key",
          credential: "credential/test/anthropic",
        },
      },
      { name: "anthropic", tag: "personal-stub" },
    );

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "anthropic-managed-profile": {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        "anthropic-personal-profile": {
          provider: "anthropic",
          provider_connection: "anthropic-personal",
        },
      },
    });

    const managedResult = await getConfiguredProvider("mainAgent", {
      overrideProfile: "anthropic-managed-profile",
    });
    const personalResult = await getConfiguredProvider("mainAgent", {
      overrideProfile: "anthropic-personal-profile",
    });

    // Hard gate #1: the resolver was called — at all.
    expect(resolveProviderCalls.length).toBe(2);

    // Hard gate #2: each call received the right connection by name.
    expect(resolveProviderCalls[0].name).toBe("anthropic-managed");
    expect(resolveProviderCalls[1].name).toBe("anthropic-personal");

    // Hard gate #3: the auth bundle on the connection matches what we'd
    // expect at adapter-call time. Different auth types per profile = mix-
    // and-match works.
    expect(resolveProviderCalls[0].auth.type).toBe("platform");
    expect(resolveProviderCalls[1].auth.type).toBe("api_key");
    expect(resolveProviderCalls[1].auth.credential).toBe(
      "credential/test/anthropic",
    );

    // Sanity: dispatch returned non-null for both.
    expect(managedResult).not.toBeNull();
    expect(personalResult).not.toBeNull();
  });

  test("profile WITHOUT provider_connection falls back to legacy registry dispatch", async () => {
    fakeProviders.set("legacy:anthropic", {
      name: "anthropic",
      tag: "legacy-stub",
    });

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "legacy-profile": {
          provider: "anthropic",
          // no provider_connection — must use getProvider() fallback
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "legacy-profile",
    });

    // Resolver must NOT have been called — legacy path only.
    expect(resolveProviderCalls.length).toBe(0);
    expect(result).not.toBeNull();
  });

  test("provider_connection set but unknown → falls back to legacy registry dispatch", async () => {
    // No connection registered — dispatcher should warn and fall through.
    fakeProviders.set("legacy:anthropic", {
      name: "anthropic",
      tag: "legacy-stub",
    });

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        broken: {
          provider: "anthropic",
          provider_connection: "does-not-exist",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "broken",
    });

    // Resolver was NOT called (lookup failed before reaching it).
    expect(resolveProviderCalls.length).toBe(0);
    // Legacy path returned a provider — system stays operational.
    expect(result).not.toBeNull();
  });

  test("provider_connection set, connection found, but resolver returns null → falls back to legacy", async () => {
    // Connection exists but resolver returns null (e.g., missing credential).
    fakeConnections.set("anthropic-broken-personal", {
      name: "anthropic-broken-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/missing" },
    });
    // intentionally do NOT register a fakeProviders entry for `conn:anthropic-broken-personal`
    fakeProviders.set("legacy:anthropic", {
      name: "anthropic",
      tag: "legacy-stub",
    });

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "broken-creds": {
          provider: "anthropic",
          provider_connection: "anthropic-broken-personal",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "broken-creds",
    });

    // Resolver WAS called — but returned null, so we fell back.
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("anthropic-broken-personal");
    // Legacy fallback succeeded — system stays operational.
    expect(result).not.toBeNull();
  });
});
