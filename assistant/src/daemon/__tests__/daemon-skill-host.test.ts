/**
 * Smoke test for `createDaemonSkillHost`.
 *
 * The goal here is narrow: construct the host with a stub skillId and
 * shallow-assert that every facet and method lines up with the
 * `SkillHost` contract. We stub every delegate module with `mock.module`
 * so the test neither touches real singletons (config loader, event hub,
 * SQLite, provider registries) nor requires workspace initialization.
 *
 * Deep behavioral coverage for each delegate lives in that delegate's own
 * test — this file is just a wiring check.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the module under test
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
  // Default returns null so we can assert normalization to undefined.
  getAssistantName: () => null,
}));

mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => "/tmp/workspace",
  vellumRoot: () => "/tmp/vellum",
}));

mock.module("../../runtime/runtime-mode.js", () => ({
  getDaemonRuntimeMode: () => "bare-metal",
}));

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({ id: "stub-provider" }),
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
  // Default returns undefined so we can assert normalization to null.
  getProviderKeyAsync: async () => undefined,
}));

mock.module("../../memory/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "msg-123" }),
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
// Module under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import { createDaemonSkillHost } from "../daemon-skill-host.js";

describe("createDaemonSkillHost", () => {
  const host = createDaemonSkillHost("meet-join");

  test("exposes every facet", () => {
    expect(host.logger).toBeDefined();
    expect(host.config).toBeDefined();
    expect(host.identity).toBeDefined();
    expect(host.platform).toBeDefined();
    expect(host.providers).toBeDefined();
    expect(host.memory).toBeDefined();
    expect(host.events).toBeDefined();
    expect(host.registries).toBeDefined();
    expect(host.speakers).toBeDefined();
  });

  test("logger.get prefixes the scope with the skillId", () => {
    const log = host.logger.get("test-scope");
    log.debug("d", { k: "v" });
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(getLoggerSpy).toHaveBeenCalledWith("meet-join:test-scope");
    expect(loggerSpy.debug).toHaveBeenCalled();
    expect(loggerSpy.info).toHaveBeenCalled();
    expect(loggerSpy.warn).toHaveBeenCalled();
    expect(loggerSpy.error).toHaveBeenCalled();
  });

  test("config.isFeatureFlagEnabled delegates to the feature-flag helper", () => {
    expect(host.config.isFeatureFlagEnabled("enabled-flag")).toBe(true);
    expect(host.config.isFeatureFlagEnabled("other-flag")).toBe(false);
  });

  test("config.getSection walks dotted paths into the resolved config", () => {
    expect(
      host.config.getSection<{ provider: string }>("services.tts"),
    ).toEqual({ provider: "elevenlabs" });
    expect(host.config.getSection<number>("services.nested.value")).toBe(42);
    expect(host.config.getSection("services.missing.path")).toBeUndefined();
  });

  test("identity normalizes a null assistant name to undefined", () => {
    expect(host.identity.getAssistantName()).toBeUndefined();
  });

  test("platform methods return the stubbed values", () => {
    expect(host.platform.workspaceDir()).toBe("/tmp/workspace");
    expect(host.platform.vellumRoot()).toBe("/tmp/vellum");
    expect(host.platform.runtimeMode()).toBe("bare-metal");
  });

  test("providers.stt lists ids and answers boundary questions", () => {
    expect(host.providers.stt.listProviderIds()).toEqual(["whisper"]);
    expect(host.providers.stt.supportsBoundary("whisper")).toBe(true);
  });

  test("providers.tts exposes get + resolveConfig", () => {
    expect(host.providers.tts.get("elevenlabs")).toEqual({ id: "elevenlabs" });
    expect(host.providers.tts.resolveConfig()).toEqual({
      provider: "elevenlabs",
    });
  });

  test("providers.secureKeys normalizes undefined to null", async () => {
    await expect(
      host.providers.secureKeys.getProviderKey("x"),
    ).resolves.toBeNull();
  });

  test("providers.llm exposes the four message helpers", () => {
    expect(typeof host.providers.llm.getConfigured).toBe("function");
    expect(typeof host.providers.llm.userMessage).toBe("function");
    expect(typeof host.providers.llm.extractToolUse).toBe("function");
    const { signal, cleanup } = host.providers.llm.createTimeout(1000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  test("memory.addMessage and wakeAgentForOpportunity are callable", async () => {
    await expect(
      host.memory.addMessage("c1", "user", "hi"),
    ).resolves.toBeDefined();
    await expect(
      host.memory.wakeAgentForOpportunity({ conversationId: "c1" }),
    ).resolves.toBeUndefined();
  });

  test("events.publish, subscribe, and buildEvent plumb through the hub", async () => {
    const evt = host.events.buildEvent({ type: "ping" }, "c1");
    expect(evt.conversationId).toBe("c1");
    await host.events.publish(evt);
    expect(publishSpy).toHaveBeenCalled();
    const sub = host.events.subscribe({}, () => undefined);
    expect(sub.active).toBe(true);
    expect(subscribeSpy).toHaveBeenCalled();
  });

  test("registries expose the three registration methods", () => {
    host.registries.registerTools(() => []);
    expect(registerExternalToolsSpy).toHaveBeenCalled();
    const handle = host.registries.registerSkillRoute({
      pattern: /^\/foo/,
      methods: ["GET"],
      handler: async () => new Response("ok"),
    });
    expect(handle).toBeDefined();
    expect(registerSkillRouteSpy).toHaveBeenCalled();
    const hook = async () => {};
    host.registries.registerShutdownHook("test-hook", hook);
    expect(registerShutdownHookSpy).toHaveBeenCalledWith(
      "meet-join:test-hook",
      hook,
    );
  });

  test("speakers.createTracker yields a concrete tracker instance", () => {
    expect(host.speakers.createTracker()).toBeInstanceOf(StubSpeakerTracker);
  });
});
