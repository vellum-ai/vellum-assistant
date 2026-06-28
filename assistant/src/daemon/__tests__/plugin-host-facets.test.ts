/**
 * Verifies the external-plugin `InitContext.host` bundle:
 *
 * 1. A plugin's `init(ctx)` receives a `host` whose `config` / `logger` /
 *    `memory` / `providers` facets are wired and callable.
 * 2. The skill host (`createDaemonSkillHost`) and the plugin host build their
 *    shared facets from the SAME module (`skill-host-facets.ts`) — a single
 *    source of truth, so the two surfaces cannot drift.
 *
 * Like the daemon-skill-host smoke test, every daemon delegate is stubbed
 * with `mock.module` so the test touches no real singletons. Deep behavioral
 * coverage for each delegate lives in that delegate's own test.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the modules under test
// ---------------------------------------------------------------------------

const loggerSpy = {
  debug: mock(() => {}),
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
};
const getLoggerSpy = mock((_name: string) => loggerSpy);
mock.module("../../util/logger.js", () => ({
  getLogger: getLoggerSpy,
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    services: { tts: { provider: "elevenlabs" }, nested: { value: 42 } },
  }),
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    const keys = path.split(".");
    let cur: unknown = obj;
    for (const k of keys) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  },
}));

mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => key === "enabled-flag",
}));

mock.module("../identity-helpers.js", () => ({
  getAssistantName: () => "Test Assistant",
}));

mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/workspace",
  vellumRoot: () => "/tmp/vellum",
}));

mock.module("../../runtime/runtime-mode.js", () => ({
  getDaemonRuntimeMode: () => "bare-metal",
}));

const getConfiguredProviderSpy = mock(async () => ({ id: "stub-provider" }));
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: getConfiguredProviderSpy,
  userMessage: (text: string) => ({ role: "user", content: text }),
  extractToolUse: () => undefined,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
}));

mock.module("../../providers/speech-to-text/provider-catalog.js", () => ({
  listProviderIds: () => ["whisper"],
  supportsBoundary: () => true,
}));

mock.module("../../providers/speech-to-text/resolve.js", () => ({
  resolveStreamingTranscriber: async () => ({ kind: "stream" }),
}));

mock.module("../../tts/provider-registry.js", () => ({
  getTtsProvider: (id: string) => ({ id }),
}));

mock.module("../../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: () => ({ provider: "elevenlabs" }),
}));

mock.module("../../security/secure-keys.js", () => ({
  getProviderKeyAsync: async () => undefined,
}));

const addMessageSpy = mock(async () => ({ id: "msg-123" }));
mock.module("../../persistence/conversation-crud.js", () => ({
  addMessage: addMessageSpy,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async () => ({ invoked: true }),
}));

const publishSpy = mock(async () => {});
const subscribeSpy = mock(() => ({ dispose: () => {}, active: true }));
mock.module("../../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: publishSpy,
    subscribe: subscribeSpy,
  },
  broadcastMessage: async () => {},
}));

mock.module("../../runtime/assistant-event.js", () => ({
  buildAssistantEvent: (message: unknown, conversationId?: string) => ({
    id: "evt-1",
    conversationId,
    emittedAt: "2024-01-01T00:00:00.000Z",
    message,
  }),
}));

mock.module("../../runtime/assistant-scope.js", () => ({
  DAEMON_INTERNAL_ASSISTANT_ID: "self",
}));

const registerExternalToolsSpy = mock(() => {});
mock.module("../../tools/registry.js", () => ({
  registerExternalTools: registerExternalToolsSpy,
}));

const registerSkillRouteSpy = mock(() => Object.freeze({}));
mock.module("../../runtime/skill-route-registry.js", () => ({
  registerSkillRoute: registerSkillRouteSpy,
}));

const registerShutdownHookSpy = mock(() => {});
mock.module("../shutdown-registry.js", () => ({
  registerShutdownHook: registerShutdownHookSpy,
}));

class StubSpeakerTracker {}
mock.module("../../calls/speaker-identification.js", () => ({
  SpeakerIdentityTracker: StubSpeakerTracker,
}));

// ---------------------------------------------------------------------------
// Modules under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import type {
  HookFunction,
  InitContext,
  PluginHost,
} from "../../plugin-api/types.js";
import { createDaemonSkillHost } from "../daemon-skill-host.js";
import {
  buildConfigFacet,
  buildEmbeddingsFacet,
  buildEventsFacet,
  buildIdentityFacet,
  buildLoggerFacet,
  buildMemoryFacet,
  buildPlatformFacet,
  buildProvidersFacet,
  buildRegistriesFacet,
  buildVectorStoreFacet,
} from "../skill-host-facets.js";

/**
 * Mirror of the host bundle `external-plugins-bootstrap.ts` injects on
 * `InitContext.host`. Composed from the same shared `skill-host-facets`
 * builders the bootstrap uses, scoped to the plugin name.
 */
function buildPluginHost(pluginName: string): PluginHost {
  return {
    providers: buildProvidersFacet(),
    memory: buildMemoryFacet(),
    events: buildEventsFacet(),
    config: buildConfigFacet(),
    identity: buildIdentityFacet(),
    platform: buildPlatformFacet(),
    logger: buildLoggerFacet(pluginName),
    registries: buildRegistriesFacet(pluginName),
    embeddings: buildEmbeddingsFacet(),
    vectorStore: buildVectorStoreFacet(pluginName),
  };
}

describe("external-plugin host bundle", () => {
  test("a plugin's init() receives a host with working facets", async () => {
    let observed: PluginHost | undefined;

    const init: HookFunction<InitContext> = async (ctx) => {
      observed = ctx.host;
    };

    const ctx: InitContext = {
      config: {},
      logger: loggerSpy,
      pluginStorageDir: "/tmp/plugins-data/example",
      assistantVersion: "1.2.3",
      host: buildPluginHost("example-plugin"),
    };

    await init(ctx);

    expect(observed).toBeDefined();
    const host = observed!;

    // config — feature flags + dotted config sections.
    expect(host.config.isFeatureFlagEnabled("enabled-flag")).toBe(true);
    expect(host.config.isFeatureFlagEnabled("other-flag")).toBe(false);
    expect(
      host.config.getSection<{ provider: string }>("services.tts"),
    ).toEqual({ provider: "elevenlabs" });

    // logger — scoped to the plugin name.
    host.logger.get("init").info("hello");
    expect(getLoggerSpy).toHaveBeenCalledWith("example-plugin:init");
    expect(loggerSpy.info).toHaveBeenCalled();

    // memory — addMessage delegates to the daemon CRUD.
    await expect(host.memory.addMessage("c1", "user", "hi")).resolves.toEqual({
      id: "msg-123",
    });
    expect(addMessageSpy).toHaveBeenCalled();

    // providers — resolves the configured provider.
    await expect(
      host.providers.llm.getConfigured("inference"),
    ).resolves.toEqual({ id: "stub-provider" });
    expect(getConfiguredProviderSpy).toHaveBeenCalled();
  });

  test("host bundle exposes the facets that exist today", () => {
    const host = buildPluginHost("example-plugin");
    for (const key of [
      "providers",
      "memory",
      "events",
      "config",
      "identity",
      "platform",
      "logger",
      "registries",
      "embeddings",
      "vectorStore",
    ] as const) {
      expect(host[key]).toBeDefined();
    }
  });

  test("skill host and plugin host build equivalent facets from the shared module", () => {
    const skillHost = createDaemonSkillHost("shared-id");
    const pluginHost = buildPluginHost("shared-id");

    // Same builder source ⇒ structurally identical facet shapes. Compare the
    // method surface of each shared facet rather than referential identity
    // (each builder returns a fresh object per call).
    const facets = [
      "providers",
      "memory",
      "events",
      "config",
      "identity",
      "platform",
      "logger",
      "registries",
      "embeddings",
      "vectorStore",
    ] as const;

    for (const facet of facets) {
      expect(Object.keys(pluginHost[facet]).sort()).toEqual(
        Object.keys(skillHost[facet]).sort(),
      );
    }

    // The shared logger builder scopes by the id it is handed — both hosts
    // therefore produce the identical scope for the same id.
    getLoggerSpy.mockClear();
    skillHost.logger.get("scope");
    pluginHost.logger.get("scope");
    const calls = getLoggerSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["shared-id:scope", "shared-id:scope"]);
  });
});
