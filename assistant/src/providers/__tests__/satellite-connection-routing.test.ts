/**
 * Cycle-3 satellite-path gate test.
 *
 * The dispatcher gate (`dispatch-connection-routing.test.ts`) proves that
 * the canonical `getConfiguredProvider()` path honors `provider_connection`.
 * That path is used by `provider-send-message.ts` directly. The satellite
 * sites — daemon conversation/approval/guardian generators, subagent
 * manager, rollup producer — instead build a `CallSiteRoutingProvider` once
 * at construction time and reuse it across many `sendMessage` calls,
 * routing per-call via `options.config.callSite`.
 *
 * If `CallSiteRoutingProvider` falls back to `getProvider(name)` when an
 * alternate-callSite profile names a `provider_connection`, the satellites
 * silently lose connection-awareness for any callSite distinct from the
 * default profile. This test proves the wrapper now consults the
 * connection-resolution hook before the legacy registry.
 *
 * Hard gates:
 *   1. A call with `callSite: <site>` whose profile names a connection
 *      invokes the connection-resolution hook with that name.
 *   2. The actual sendMessage transport that runs is the connection-bound
 *      Provider stub, not the default and not the legacy `getProvider(name)`
 *      result.
 *   3. A call with `callSite: <site>` whose profile has NO connection still
 *      falls through to legacy `getProvider(name)`.
 *   4. A call with no callSite goes straight to the default provider — no
 *      hook invocation, no registry lookup.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Provider, ProviderResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks (must be declared before the import-under-test).
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
  loadConfig: () => ({
    llm: mockLlmConfig,
    services: { inference: { mode: "your-own" } },
  }),
}));

const mockDbSentinel = { __mock: "db" };
mock.module("../../memory/db-connection.js", () => ({
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

mock.module("../registry.js", () => ({
  getProvider: (name: string) => {
    const p = fakeProviders.get(`legacy:${name}`);
    if (!p) throw new Error(`legacy getProvider unknown: ${name}`);
    return p;
  },
  initializeProviders: async () => {},
  listProviders: () => Array.from(fakeProviders.values()),
  resolveProviderFromConnection: async (connection: Connection) => {
    resolveProviderCalls.push(connection);
    return fakeProviders.get(`conn:${connection.name}`) ?? null;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks).
// ---------------------------------------------------------------------------

import { wrapWithCallSiteRouting } from "../call-site-routing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setLlmConfig(c: Record<string, unknown>): void {
  mockLlmConfig = c;
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
  mockLlmConfig = {};
}

// ProvidersConfig stub used by the wrapper helper. The connection-resolution
// helper passes it straight to `resolveProviderFromConnection`, which is
// fully mocked above — so a minimal shape is fine.
const providersConfigStub = {
  llm: { default: { provider: "anthropic", model: "claude-opus-4-7" } },
  services: {
    inference: { mode: "your-own" as const },
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

  test("alternate-profile callSite with provider_connection routes through that connection's auth", async () => {
    // Default = anthropic, but the rollup callSite is configured to use a
    // different profile that names a `provider_connection`.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");
    fakeProviders.set("legacy:anthropic", defaultProvider);

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
      [],
      undefined,
      { config: { callSite: "replySuggestion" } },
    );

    // Hard gate #1: connection-resolution hook fired with the right name.
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("anthropic-managed");
    expect(resolveProviderCalls[0].auth.type).toBe("platform");

    // Hard gate #2: the actual transport that ran was the connection-bound
    // stub, NOT the default and NOT the (mocked) legacy registry result.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("connection-managed");
    expect((response as unknown as { tag: string }).tag).toBe("connection-managed");
  });

  test("alternate-profile callSite WITHOUT provider_connection falls through to legacy registry", async () => {
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");
    fakeProviders.set("legacy:anthropic", defaultProvider);
    fakeProviders.set("legacy:openai", makeFakeProvider("legacy-openai", "openai"));

    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "openai-profile": {
          provider: "openai",
          // no provider_connection — must use getProvider("openai") fallback
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

    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [],
      undefined,
      { config: { callSite: "memoryRetrieval" } },
    );

    // Connection-resolution hook MUST NOT have fired.
    expect(resolveProviderCalls.length).toBe(0);
    // Legacy registry path produced the openai stub.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("legacy-openai");
  });

  test("alternate-profile callSite with unknown provider_connection falls through to legacy", async () => {
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");
    fakeProviders.set("legacy:anthropic", defaultProvider);

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

    const response = await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [],
      undefined,
      { config: { callSite: "conversationTitle" } },
    );

    // Connection lookup attempted (hook called) but returned null.
    expect(resolveProviderCalls.length).toBe(0);
    // Profile's resolved provider matches default → reused default
    // instance (no legacy lookup needed). System stays operational.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("default-anthropic");
    expect((response as unknown as { tag: string }).tag).toBe("default-anthropic");
  });

  test("provider/connection mismatch falls through to legacy — no silent misroute", async () => {
    // Misconfiguration: profile says provider=openai but provider_connection
    // points at an anthropic-flavored row. Without the validation we'd dispatch
    // OpenAI traffic to an Anthropic backend (or vice versa). With validation
    // we fall through to the legacy `getProvider("openai")` path so the
    // request goes where the profile's `provider` field said.
    const defaultProvider = makeFakeProvider("default-anthropic", "anthropic");
    fakeProviders.set("legacy:anthropic", defaultProvider);
    fakeProviders.set(
      "legacy:openai",
      makeFakeProvider("legacy-openai", "openai"),
    );

    registerConnection(
      {
        name: "anthropic-managed",
        provider: "anthropic",
        auth: { type: "platform" },
      },
      // Note: even though the connection has a stub bound, it should NEVER
      // be reached because the connection's provider doesn't match the
      // profile's provider.
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

    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      [],
      undefined,
      { config: { callSite: "replySuggestion" } },
    );

    // The hook MUST NOT have produced a Provider — the validation check
    // returned null without reaching `resolveProviderFromConnection`.
    expect(resolveProviderCalls.length).toBe(0);
    // Legacy registry path produced the openai stub (matching profile.provider,
    // NOT the connection's anthropic).
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("legacy-openai");
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
      [],
      undefined,
      {},
    );

    expect(resolveProviderCalls.length).toBe(0);
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0].tag).toBe("default-anthropic");
  });
});
