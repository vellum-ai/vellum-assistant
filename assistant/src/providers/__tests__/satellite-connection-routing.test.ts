/**
 * Satellite-path gate test for `CallSiteRoutingProvider`.
 *
 * The dispatcher gate (`dispatch-connection-routing.test.ts`) proves that
 * the canonical `getConfiguredProvider()` path honors `provider_connection`.
 * That path is used by `provider-send-message.ts` directly. The satellite
 * sites — daemon conversation/approval/guardian generators, subagent
 * manager, rollup producer — instead build a `CallSiteRoutingProvider` once
 * at construction time and reuse it across many `sendMessage` calls,
 * routing per-call via `options.config.callSite`.
 *
 * `CallSiteRoutingProvider` does not use a legacy registry fallback.
 * The contract is:
 *   - Connection set, resolves cleanly → route through that connection.
 *   - Connection set, resolves to null (soft credential failure) →
 *     fall back to default Provider for graceful per-call degradation.
 *   - Connection set, hard config error (not_found / mismatch) → throw
 *     `ConnectionResolutionError`.
 *   - Connection unset, profile.provider matches default → reuse default.
 *   - Connection unset, profile.provider differs from default → throw
 *     (alternate-provider routing requires a connection).
 *   - No callSite → straight to default (no resolution work).
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { setConfig } from "../../__tests__/helpers/set-config.js";

// Connection-routing plumbing over legacy-shaped fixtures (llm.default /
// activeProfile-centric, no defaultProvider): pinned to the flag-off
// cascade. Flag-on dispatch behavior is covered by
// inference-no-mode-boot-e2e.test.ts and the override-or-default resolver
// suite.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

import type { Provider, ProviderResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks (must be declared before the import-under-test).
// ---------------------------------------------------------------------------

const mockDbSentinel = { __mock: "db" };
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => mockDbSentinel,
}));

// ---------------------------------------------------------------------------
// Fake provider/connection registries — keep these inspectable from tests.
// ---------------------------------------------------------------------------

type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

// Provider-conforming stub. The `tag` field on the returned response lets
// the test assert which transport actually ran (the connection-bound stub
// vs the legacy registry stub vs the bare default), without leaning on
// reference equality.
interface TaggedResponse extends ProviderResponse {
  tag: string;
}
type FakeProviderStub = Provider & {
  tag: string;
  sendMessage: (
    ...args: Parameters<Provider["sendMessage"]>
  ) => Promise<TaggedResponse>;
};

const fakeConnections = new Map<string, Connection>();
const fakeProviders = new Map<string, FakeProviderStub>();
const resolveProviderCalls: Connection[] = [];
const sendMessageCalls: { tag: string }[] = [];

function makeFakeProvider(tag: string, providerName: string): FakeProviderStub {
  return {
    name: providerName,
    tag,
    sendMessage: async () => {
      sendMessageCalls.push({ tag });
      return {
        content: [{ type: "text", text: tag }],
        model: "test-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
        tag,
      };
    },
  };
}

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnections.get(name) ?? null,
}));

// Connection names that should make `resolveProviderFromConnection` throw —
// simulates a transient failure inside auth resolution (credential read,
// managed-proxy context lookup) bubbling up from the inner registry call.
const connectionsThatThrowOnResolve = new Set<string>();

mock.module("../registry.js", () => ({
  // The wrapper does not import getProvider. Kept here only so test files
  // that share this mock module shape compile.
  getProvider: (name: string) => {
    throw new Error(`legacy getProvider should not be called: ${name}`);
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(fakeProviders.values()),
  resolveProviderFromConnection: async (connection: Connection) => {
    resolveProviderCalls.push(connection);
    if (connectionsThatThrowOnResolve.has(connection.name)) {
      throw new Error(`simulated auth-resolution failure: ${connection.name}`);
    }
    return fakeProviders.get(`conn:${connection.name}`) ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { LLMSchema } from "../../config/schemas/llm.js";
import { wrapWithCallSiteRouting } from "../call-site-routing.js";
import { ConnectionResolutionError } from "../connection-resolution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLlmConfig(c: Record<string, unknown>): void {
  setConfig("llm", c);
}

function registerConnection(
  c: Connection,
  providerStub: FakeProviderStub,
): void {
  fakeConnections.set(c.name, c);
  fakeProviders.set(`conn:${c.name}`, providerStub);
}

function reset(): void {
  resolveProviderCalls.length = 0;
  sendMessageCalls.length = 0;
  fakeConnections.clear();
  fakeProviders.clear();
  connectionsThatThrowOnResolve.clear();
  setConfig("llm", {});
}

// ProvidersConfig stub used by the wrapper helper. The connection-resolution
// helper passes it straight to `resolveProviderFromConnection`, which is
// fully mocked above — so a minimal shape is fine.
const providersConfigStub = {
  llm: LLMSchema.parse({}),
  services: {
    inference: {},
    "image-generation": {
      mode: "managed" as const,
      provider: "openai",
      model: "gpt-image-1",
    },
    "web-search": { mode: "managed" as const, provider: "brave" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallSiteRoutingProvider honors provider_connection (satellite gate)", () => {
  beforeEach(reset);

  test("provider_connection set + resolves cleanly → routes through that connection's auth", async () => {
    // Default = anthropic, but the rollup callSite is configured to use a
    // different profile that names a `provider_connection`.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    registerConnection(
      {
        name: "anthropic-managed",
        provider: "anthropic",
        auth: { type: "platform" },
      },
      makeFakeProvider("connection-managed", "anthropic"),
    );

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "managed-profile": {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
      },
      callSites: {
        replySuggestion: { profile: "managed-profile" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    const response = await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { tools: [], config: { callSite: "replySuggestion" } },
    );

    // Hard gate #1: connection-resolution hook fired with the right name.
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("anthropic-managed");
    expect(resolveProviderCalls[0].auth.type).toBe("platform");

    // Hard gate #2: the actual transport that ran was the connection-bound
    // stub, NOT the default.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("connection-managed");
    expect((response as unknown as { tag: string }).tag).toBe(
      "connection-managed",
    );
  });

  test("connection unset + profile.provider matches default → reuses default (no resolution work)", async () => {
    // The lenient path. A profile whose provider matches the default's name
    // but doesn't (yet) carry a provider_connection should NOT throw — the
    // default IS the connection-aware route in that case.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "anthropic-bare": {
          provider: "anthropic",
          // no provider_connection — but provider matches default's name
        },
      },
      callSites: {
        memoryRetrieval: { profile: "anthropic-bare" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { tools: [], config: { callSite: "memoryRetrieval" } },
    );

    // No connection lookup attempted at all.
    expect(resolveProviderCalls.length).toBe(0);
    // Default ran the call.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("default-anthropic");
  });

  test("connection unset + profile.provider differs from default → throws ConnectionResolutionError(missing_connection)", async () => {
    // Alternate-provider routing requires a connection. Without one,
    // misconfigurations throw rather than silently dispatching to a
    // mismatched backend.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "openai-profile": {
          provider: "openai",
          // No provider_connection — alternate-provider routing demands
          // one; this profile is expected to throw
          // `ConnectionResolutionError(missing_connection)`.
        },
      },
      callSites: {
        memoryRetrieval: { profile: "openai-profile" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    let caught: unknown;
    try {
      await wrapped.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools: [], config: { callSite: "memoryRetrieval" } },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectionResolutionError);
    expect((caught as ConnectionResolutionError).reason).toBe(
      "missing_connection",
    );
    // Connection-resolution hook MUST NOT have fired — threw before.
    expect(resolveProviderCalls.length).toBe(0);
    // Default's transport was never invoked either.
    expect(sendMessageCalls.length).toBe(0);
  });

  test("provider_connection set but unknown → throws ConnectionResolutionError(not_found)", async () => {
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        broken: {
          provider: "anthropic",
          provider_connection: "does-not-exist",
        },
      },
      callSites: {
        conversationTitle: { profile: "broken" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    let caught: unknown;
    try {
      await wrapped.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools: [], config: { callSite: "conversationTitle" } },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectionResolutionError);
    expect((caught as ConnectionResolutionError).reason).toBe("not_found");
    expect((caught as ConnectionResolutionError).connectionName).toBe(
      "does-not-exist",
    );
    // Resolver was never reached (connection lookup returned null).
    expect(resolveProviderCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(0);
  });

  test("provider/connection mismatch → throws ConnectionResolutionError(provider_mismatch)", async () => {
    // Misconfiguration: profile says provider=openai but provider_connection
    // points at an anthropic row. Connection validation throws
    // `ConnectionResolutionError(provider_mismatch)` so OpenAI traffic
    // never dispatches to an Anthropic backend.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    registerConnection(
      {
        name: "anthropic-managed",
        provider: "anthropic",
        auth: { type: "platform" },
      },
      // Stub registered but should NEVER run — the mismatch check throws
      // before `resolveProviderFromConnection` is called.
      makeFakeProvider("WRONG-connection-anthropic", "anthropic"),
    );

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        mismatched: {
          provider: "openai",
          // ↑ profile says openai
          provider_connection: "anthropic-managed",
          // ↑ but connection is anthropic — mismatch
        },
      },
      callSites: {
        replySuggestion: { profile: "mismatched" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    let caught: unknown;
    try {
      await wrapped.sendMessage(
        [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        { tools: [], config: { callSite: "replySuggestion" } },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConnectionResolutionError);
    expect((caught as ConnectionResolutionError).reason).toBe(
      "provider_mismatch",
    );
    expect((caught as ConnectionResolutionError).connectionName).toBe(
      "anthropic-managed",
    );
    // Resolver was never reached (mismatch check fires first).
    expect(resolveProviderCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(0);
  });

  test("transient auth-resolution failure → falls back to default (graceful per-call degradation)", async () => {
    // Simulates a transient error inside `resolveProviderFromConnection`
    // (e.g. a credential read fails, or managed-proxy context lookup
    // throws). The connection-resolution helper catches transient throws
    // and returns null. The wrapper then falls back to the default
    // Provider so a credential blip does not take inference offline.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    registerConnection(
      {
        name: "flaky-managed",
        provider: "anthropic",
        auth: { type: "platform" },
      },
      // Provider stub IS registered, but the resolve will throw before
      // reaching it. The test asserts the throw is caught.
      makeFakeProvider("WOULD-BE-connection", "anthropic"),
    );
    connectionsThatThrowOnResolve.add("flaky-managed");

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        flaky: {
          provider: "anthropic",
          provider_connection: "flaky-managed",
        },
      },
      callSites: {
        replySuggestion: { profile: "flaky" },
      },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    // This MUST NOT throw — the resolve failure is contained.
    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { tools: [], config: { callSite: "replySuggestion" } },
    );

    // The resolver DID fire (we got past the connection lookup + validation).
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("flaky-managed");
    // Helper caught the throw and returned null → wrapper fell back to
    // default for graceful per-call degradation.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("default-anthropic");
  });

  test("call without a callSite goes straight to the default provider — no hook, no registry lookup", async () => {
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");

    // Note: legacy registry has nothing — if the wrapper tries to consult
    // it, the test will throw. Bare-default path proves the short-circuit.

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    const wrapped = wrapWithCallSiteRouting(
      defaultProvider,
      providersConfigStub,
    );

    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      { tools: [] },
    );

    expect(resolveProviderCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("default-anthropic");
  });
});
