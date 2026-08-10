/**
 * Dispatcher gate test — proves that `resolveConfiguredProvider` routes
 * through `resolveProviderFromConnection` for every dispatch when a profile
 * names a `provider_connection`, AND that misconfigurations now fail loudly
 * rather than silently rerouting to a legacy registry.
 *
 * Hard config errors (missing connection name, unknown connection,
 * provider mismatch) throw `ConnectionResolutionError`. Soft credential
 * failures (resolver returns null) still return null so callers can
 * degrade gracefully.
 *
 * Hard gates:
 *   1. Two profiles, same provider, different `provider_connection` →
 *      resolver called twice with the right connection each time, with
 *      auth bundles distinguishable per profile (mix-and-match goal #2
 *      of the design).
 *   2. Profile WITHOUT `provider_connection` → throws
 *      `ConnectionResolutionError` (configuration bug; backfill should
 *      have populated it).
 *   3. `provider_connection` set but unknown → throws (loud config error).
 *   4. `provider_connection` set, found, but resolver returns null →
 *      returns null (soft credential failure; satellite caller decides
 *      what to do).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

// Connection-routing plumbing over legacy-shaped fixtures (llm.default /
// activeProfile-centric, no defaultProvider): pinned to the flag-off
// cascade. Flag-on dispatch behavior is covered by
// inference-no-mode-boot-e2e.test.ts and the override-or-default resolver
// suite.

// ---------------------------------------------------------------------------
// Module mocks (must be declared before the import-under-test).
// ---------------------------------------------------------------------------

// Mock the DB getter — we never actually hit SQLite since `getConnection` is
// also mocked. Returning a sentinel keeps the call signature satisfied.
const mockDbSentinel = { __mock: "db" };
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => mockDbSentinel,
}));

// Spy storage for the resolver — each test inspects what was passed in.
type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

const resolveProviderCalls: Connection[] = [];
const resolveProviderOpts: { providerOverride?: string }[] = [];

// Each connection name maps to a distinct fake Provider instance. Returning
// distinguishable instances lets the test assert that two profiles with
// different connections route to different providers.
const fakeProviders = new Map<string, { name: string; tag: string }>();

// Connection registry the mocked `getConnection` reads from.
const fakeConnections = new Map<string, Connection>();

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnections.get(name) ?? null,
  listConnections: (_db: unknown, filter?: { provider?: string }) =>
    Array.from(fakeConnections.values()).filter(
      (c) => !filter?.provider || c.provider === filter.provider,
    ),
}));

mock.module("../registry.js", () => ({
  // The dispatch path does not import getProvider.
  // Kept here only because other test files share this mock module shape.
  getProvider: (name: string) => {
    throw new Error(`legacy getProvider should not be called: ${name}`);
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(fakeProviders.values()),
  // The function under test — wraps the dispatcher's connection-aware path.
  resolveProviderFromConnection: async (
    connection: Connection,
    _config: unknown,
    opts?: { providerOverride?: string },
  ) => {
    resolveProviderCalls.push(connection);
    resolveProviderOpts.push(opts ?? {});
    return fakeProviders.get(`conn:${connection.name}`) ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import {
  ConnectionResolutionError,
  resolveRoutingIdentity,
  tryResolveProviderForConnectionName,
} from "../connection-resolution.js";
import { getConfiguredProvider } from "../provider-send-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLlmConfig(c: Record<string, unknown>): void {
  setConfig("llm", c);
}

function registerConnection(
  c: Connection,
  providerStub: { name: string; tag: string },
): void {
  fakeConnections.set(c.name, c);
  fakeProviders.set(`conn:${c.name}`, providerStub);
}

function reset(): void {
  resolveProviderCalls.length = 0;
  fakeConnections.clear();
  fakeProviders.clear();
  setConfig("llm", {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch routes through provider_connection (Phase 1: connection-only)", () => {
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
      profiles: {
        "anthropic-managed-profile": {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
          model: "claude-opus-4-7",
        },
        "anthropic-personal-profile": {
          provider: "anthropic",
          provider_connection: "anthropic-personal",
          model: "claude-opus-4-7",
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

  test("profile WITHOUT provider_connection returns null (graceful fallback)", async () => {
    setLlmConfig({
      profiles: {
        "legacy-profile": {
          provider: "anthropic",
          model: "claude-opus-4-7",
          // no provider_connection — boot-time backfill is expected to
          // populate this in production. When unset, the per-callsite
          // resolver returns null so callsites with deterministic
          // fallbacks (invite instructions, telegram resolution, etc.)
          // keep working. Hard config errors (lookup failed, mismatch)
          // still throw via tryResolveProviderForConnectionName.
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "legacy-profile",
    });

    expect(result).toBeNull();
    // Resolver must NOT have been called — short-circuited before reaching it.
    expect(resolveProviderCalls.length).toBe(0);
  });

  test("provider_connection set but unknown → throws ConnectionResolutionError(not_found)", async () => {
    // No connection registered — the dispatcher should throw with reason
    // 'not_found' rather than falling through to a legacy lookup.
    setLlmConfig({
      profiles: {
        broken: {
          provider: "anthropic",
          provider_connection: "does-not-exist",
          model: "claude-opus-4-7",
        },
      },
    });

    let caught: unknown;
    try {
      await getConfiguredProvider("mainAgent", { overrideProfile: "broken" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectionResolutionError);
    expect((caught as ConnectionResolutionError).reason).toBe("not_found");
    expect((caught as ConnectionResolutionError).connectionName).toBe(
      "does-not-exist",
    );
    // Resolver was NOT called (lookup failed before reaching it).
    expect(resolveProviderCalls.length).toBe(0);
  });

  test("provider_connection set, connection found, but resolver returns null → returns null (soft credential failure)", async () => {
    // Connection exists but resolver returns null (e.g., missing credential).
    fakeConnections.set("anthropic-broken-personal", {
      name: "anthropic-broken-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/missing" },
    });
    // Intentionally do NOT register a fakeProviders entry for
    // `conn:anthropic-broken-personal` — resolver returns null.

    setLlmConfig({
      profiles: {
        "broken-creds": {
          provider: "anthropic",
          provider_connection: "anthropic-broken-personal",
          model: "claude-opus-4-7",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "broken-creds",
    });

    // Resolver WAS called — but returned null. No legacy fallback.
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("anthropic-broken-personal");
    // Soft credential failure → null result. Satellite callers handle null
    // however they want (rollup producer skips, others throw a domain-
    // specific error).
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routing identities ("vellum"/"chatgpt") — resolution-unit coverage plus
// config-driven dispatch through the real loader.
// ---------------------------------------------------------------------------

describe("routing identities", () => {
  beforeEach(() => {
    resolveProviderCalls.length = 0;
    resolveProviderOpts.length = 0;
    fakeConnections.clear();
    fakeProviders.clear();
    setConfig("llm", {});
  });

  test("a stored vellum profile dispatches end-to-end through the real config loader", async () => {
    registerConnection(
      { name: "vellum", provider: "vellum", auth: { type: "platform" } },
      { name: "anthropic", tag: "managed-stub" },
    );
    setLlmConfig({
      profiles: {
        managed: { provider: "vellum", model: "claude-opus-4-8" },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "managed",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0]?.name).toBe("vellum");
    expect(resolveProviderOpts[0]?.providerOverride).toBe("anthropic");
  });

  test("a stored chatgpt profile dispatches end-to-end through the real config loader", async () => {
    registerConnection(
      {
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
      },
      { name: "openai", tag: "subscription-stub" },
    );
    setLlmConfig({
      profiles: {
        subscription: { provider: "chatgpt", model: "gpt-5.5" },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "subscription",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0]?.name).toBe("chatgpt-subscription");
  });

  test("resolveRoutingIdentity derives the vellum upstream from the model", () => {
    expect(resolveRoutingIdentity("vellum", "claude-opus-4-8")).toEqual({
      connectionName: "vellum",
      expectedProvider: "anthropic",
    });
    expect(
      resolveRoutingIdentity("vellum", "accounts/fireworks/models/glm-5p2"),
    ).toEqual({ connectionName: "vellum", expectedProvider: "fireworks" });
  });

  test("resolveRoutingIdentity throws loudly for an unroutable vellum model", () => {
    expect(() => resolveRoutingIdentity("vellum", "not-a-real-model")).toThrow(
      ConnectionResolutionError,
    );
    try {
      resolveRoutingIdentity("vellum", "not-a-real-model");
    } catch (err) {
      expect((err as ConnectionResolutionError).reason).toBe(
        "unroutable_managed_model",
      );
    }
  });

  test("resolveRoutingIdentity maps chatgpt to the subscription row with an openai upstream", () => {
    expect(resolveRoutingIdentity("chatgpt", "gpt-5.5")).toEqual({
      connectionName: "chatgpt-subscription",
      expectedProvider: "openai",
    });
  });

  test("resolveRoutingIdentity rejects non-Codex models on the chatgpt route", () => {
    expect(() => resolveRoutingIdentity("chatgpt", "gpt-5")).toThrow(
      ConnectionResolutionError,
    );
    try {
      resolveRoutingIdentity("chatgpt", "gpt-5");
    } catch (err) {
      expect((err as ConnectionResolutionError).reason).toBe(
        "model_incompatible",
      );
    }
  });

  test("resolveRoutingIdentity passes real providers through untouched", () => {
    expect(resolveRoutingIdentity("anthropic", "claude-opus-4-8")).toBeNull();
    expect(resolveRoutingIdentity(undefined, "claude-opus-4-8")).toBeNull();
  });

  test("vellum identity resolves through the canonical row with the derived upstream override", async () => {
    fakeConnections.set("vellum", {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    fakeProviders.set("conn:vellum", { name: "anthropic", tag: "managed" });

    const provider = await tryResolveProviderForConnectionName(
      "ignored-stale-name",
      { llm: {} } as never,
      "vellum",
      "claude-opus-4-8",
    );

    expect(provider).toEqual({
      name: "anthropic",
      tag: "managed",
      routeAttribution: {
        connectionName: "vellum",
        isManagedRoute: true,
      },
    } as never);
    expect(resolveProviderCalls[0]?.name).toBe("vellum");
    expect(resolveProviderOpts[0]?.providerOverride).toBe("anthropic");
  });

  test("chatgpt identity resolves the subscription row by name with an openai override", async () => {
    fakeConnections.set("chatgpt-subscription", {
      name: "chatgpt-subscription",
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    });
    fakeProviders.set("conn:chatgpt-subscription", {
      name: "openai",
      tag: "subscription",
    });

    const provider = await tryResolveProviderForConnectionName(
      "ignored",
      { llm: {} } as never,
      "chatgpt",
      "gpt-5.5",
    );

    expect(provider).toEqual({
      name: "openai",
      tag: "subscription",
      routeAttribution: {
        connectionName: "chatgpt-subscription",
        isManagedRoute: false,
      },
    } as never);
    expect(resolveProviderCalls[0]?.name).toBe("chatgpt-subscription");
    // A pre-migration row carries provider "openai": no override needed, the
    // adapter resolves from the row.
    expect(resolveProviderCalls[0]?.provider).toBe("openai");
  });

  test("a chatgpt-identity subscription row dispatches with an openai override", async () => {
    // Migration 366 stamps the row with the "chatgpt" identity; the identity
    // must never reach adapter construction, so dispatch threads the openai
    // upstream as providerOverride, mirroring the vellum sentinel.
    fakeConnections.set("chatgpt-subscription", {
      name: "chatgpt-subscription",
      provider: "chatgpt",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    });
    fakeProviders.set("conn:chatgpt-subscription", {
      name: "openai",
      tag: "subscription",
    });

    const provider = await tryResolveProviderForConnectionName(
      "ignored",
      { llm: {} } as never,
      "chatgpt",
      "gpt-5.5",
    );

    expect(provider?.routeAttribution).toEqual({
      connectionName: "chatgpt-subscription",
      isManagedRoute: false,
    });
    expect(resolveProviderCalls[0]?.name).toBe("chatgpt-subscription");
    expect(resolveProviderOpts[0]?.providerOverride).toBe("openai");
  });

  // A second managed row is creatable under any non-reserved name: only the
  // canonical name is refused at the create route, and `provider: "vellum"`
  // derives platform auth. Managed-ness is the row, never its name.
  test("a managed row under a non-canonical name carries managed route attribution", async () => {
    fakeConnections.set("managed-openai", {
      name: "managed-openai",
      provider: "vellum",
      auth: { type: "platform" },
    });
    fakeProviders.set("conn:managed-openai", {
      name: "openai",
      tag: "managed",
    });

    const provider = await tryResolveProviderForConnectionName(
      "managed-openai",
      { llm: {} } as never,
      "openai",
      "gpt-5.5",
    );

    expect(provider?.routeAttribution).toEqual({
      connectionName: "managed-openai",
      isManagedRoute: true,
    });
  });

  test("chatgpt identity with no subscription row throws not_found (never a silent fallback)", async () => {
    await expect(
      tryResolveProviderForConnectionName(
        "ignored",
        { llm: {} } as never,
        "chatgpt",
        "gpt-5.5",
      ),
    ).rejects.toMatchObject({ reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// Entry-name providers — a profile provider naming a connection row directly.
// Write surfaces reject these until the entries model enables them; dispatch
// translates them so hand-edited configs (and the collapse migration later)
// route through the named row.
// ---------------------------------------------------------------------------

describe("entry-name providers", () => {
  beforeEach(() => {
    resolveProviderCalls.length = 0;
    resolveProviderOpts.length = 0;
    fakeConnections.clear();
    fakeProviders.clear();
    setConfig("llm", {});
  });

  test("a profile naming an entry dispatches through that row", async () => {
    registerConnection(
      {
        name: "anthropic-work",
        provider: "anthropic",
        auth: {
          type: "api_key",
          credential: "credential/anthropic-work/api_key",
        },
      },
      { name: "anthropic", tag: "work-key" },
    );
    setLlmConfig({
      profiles: {
        work: { provider: "anthropic-work", model: "claude-opus-4-8" },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "work",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0]?.name).toBe("anthropic-work");
    // The label is not a vendor: the row's own provider drives dispatch,
    // so no override is threaded.
    expect(resolveProviderOpts[0]?.providerOverride).toBeUndefined();
  });

  test("a vellum-kind entry derives its upstream from the model", async () => {
    registerConnection(
      { name: "work-managed", provider: "vellum", auth: { type: "platform" } },
      { name: "anthropic", tag: "managed-stub" },
    );
    setLlmConfig({
      profiles: {
        managed: { provider: "work-managed", model: "claude-opus-4-8" },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "managed",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls[0]?.name).toBe("work-managed");
    expect(resolveProviderOpts[0]?.providerOverride).toBe("anthropic");
  });

  test("an entry label alongside an explicit provider_connection still dispatches", async () => {
    // The step-3 collapse migration rewrites provider to an entry name; a
    // stale provider_connection left beside it must not fail the vendor
    // equality against a label that is not a vendor.
    registerConnection(
      {
        name: "anthropic-work",
        provider: "anthropic",
        auth: {
          type: "api_key",
          credential: "credential/anthropic-work/api_key",
        },
      },
      { name: "anthropic", tag: "work-key" },
    );
    setLlmConfig({
      profiles: {
        work: {
          provider: "anthropic-work",
          provider_connection: "anthropic-work",
          model: "claude-opus-4-8",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "work",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls[0]?.name).toBe("anthropic-work");
    expect(resolveProviderOpts[0]?.providerOverride).toBeUndefined();
  });

  test("a label with a conflicting provider_connection is held to the label's kind", async () => {
    // The label's row kind threads as the expected vendor, so a stale or
    // conflicting connection cannot silently dispatch a different vendor:
    // the equality mismatch auto-recovers to a row matching the kind.
    registerConnection(
      {
        name: "anthropic-work",
        provider: "anthropic",
        auth: {
          type: "api_key",
          credential: "credential/anthropic-work/api_key",
        },
      },
      { name: "anthropic", tag: "work-key" },
    );
    registerConnection(
      { name: "ollama-local", provider: "ollama", auth: { type: "none" } },
      { name: "ollama", tag: "local" },
    );
    setLlmConfig({
      profiles: {
        conflicted: {
          provider: "anthropic-work",
          provider_connection: "ollama-local",
          model: "claude-opus-4-8",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "conflicted",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls[0]?.name).toBe("anthropic-work");
  });

  test("a profile naming no row is healed away at selection", async () => {
    // Selection treats an unresolvable provider like an incomplete profile:
    // the broken winner loses and the next rung's model AND transport apply
    // together, restoring the pre-open-schema self-healing. The anchor is
    // the managed default, so the heal lands on the vellum route.
    registerConnection(
      { name: "vellum", provider: "vellum", auth: { type: "platform" } },
      { name: "anthropic", tag: "managed-anchor" },
    );
    setLlmConfig({
      profiles: {
        ghost: { provider: "no-such-entry", model: "claude-opus-4-8" },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "ghost",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls[0]?.name).toBe("vellum");
  });

  test("healing hands off to the anchor, whose own failures stay loud", async () => {
    // With the broken profile healed away, resolution rests on the managed
    // anchor; its canonical row missing is a boot-seeding violation and
    // throws explainably rather than masquerading as the ghost profile.
    setLlmConfig({
      profiles: {
        ghost: { provider: "no-such-entry", model: "claude-opus-4-8" },
      },
    });

    await expect(
      getConfiguredProvider("mainAgent", { overrideProfile: "ghost" }),
    ).rejects.toMatchObject({ reason: "not_found", connectionName: "vellum" });
  });
});
