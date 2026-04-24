/**
 * Unit tests for the `host.providers.*` skill IPC routes.
 *
 * Every daemon delegate is mocked with `mock.module` so the test exercises
 * only the route layer — param parsing, delegate call shape, return shape.
 * Deep behavioral coverage lives in each delegate's own module tests.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level stubs — installed before importing the module under test
// ---------------------------------------------------------------------------

const sendMessageSpy = mock(async () => ({
  content: [{ type: "text", text: "hello" }],
  model: "stub-model",
  usage: { inputTokens: 1, outputTokens: 2 },
  stopReason: "end_turn",
}));
const stubProvider: unknown = {
  name: "stub-provider",
  sendMessage: sendMessageSpy,
};
const getConfiguredProviderSpy = mock(async () => stubProvider);
mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: getConfiguredProviderSpy,
}));

const sttListProviderIdsSpy = mock(() => ["openai-whisper", "deepgram"]);
const sttSupportsBoundarySpy = mock(() => true);
mock.module("../../../providers/speech-to-text/provider-catalog.js", () => ({
  listProviderIds: sttListProviderIdsSpy,
  supportsBoundary: sttSupportsBoundarySpy,
}));

const getTtsProviderSpy = mock((id: string) => ({
  id,
  capabilities: {},
  synthesize: async () => ({}),
}));
mock.module("../../../tts/provider-registry.js", () => ({
  getTtsProvider: getTtsProviderSpy,
}));

const resolveTtsConfigSpy = mock(() => ({
  provider: "elevenlabs",
  providerConfig: { voiceId: "stub-voice" },
}));
mock.module("../../../tts/tts-config-resolver.js", () => ({
  resolveTtsConfig: resolveTtsConfigSpy,
}));

const getConfigSpy = mock(() => ({ services: { tts: {} } }));
mock.module("../../../config/loader.js", () => ({
  getConfig: getConfigSpy,
}));

const getProviderKeyAsyncSpy = mock(async (id: string) =>
  id === "present" ? "secret-key" : undefined,
);
mock.module("../../../security/secure-keys.js", () => ({
  getProviderKeyAsync: getProviderKeyAsyncSpy,
}));

// ---------------------------------------------------------------------------
// Module under test — imported after every stub is in place
// ---------------------------------------------------------------------------

import {
  providerSkillRoutes,
  providersLlmCompleteRoute,
  providersSecureKeysGetProviderKeyRoute,
  providersSttListProviderIdsRoute,
  providersSttSupportsBoundaryRoute,
  providersTtsGetRoute,
  providersTtsResolveConfigRoute,
} from "../providers.js";

beforeEach(() => {
  sendMessageSpy.mockClear();
  getConfiguredProviderSpy.mockClear();
  sttListProviderIdsSpy.mockClear();
  sttSupportsBoundarySpy.mockClear();
  getTtsProviderSpy.mockClear();
  resolveTtsConfigSpy.mockClear();
  getProviderKeyAsyncSpy.mockClear();
});

describe("providerSkillRoutes registry", () => {
  test("exposes every documented method name", () => {
    const methods = providerSkillRoutes.map((r) => r.method).sort();
    expect(methods).toEqual([
      "host.providers.llm.complete",
      "host.providers.secureKeys.getProviderKey",
      "host.providers.stt.listProviderIds",
      "host.providers.stt.supportsBoundary",
      "host.providers.tts.get",
      "host.providers.tts.resolveConfig",
    ]);
  });
});

describe("host.providers.llm.complete", () => {
  test("resolves the provider by callSite and forwards request args", async () => {
    const response = await providersLlmCompleteRoute.handler({
      callSite: "mainAgent",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      systemPrompt: "you are helpful",
    });

    expect(getConfiguredProviderSpy).toHaveBeenCalledWith("mainAgent");
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const call = sendMessageSpy.mock.calls[0] as unknown as [
      unknown[],
      unknown,
      string | undefined,
      unknown,
    ];
    expect(Array.isArray(call[0])).toBe(true);
    expect(call[2]).toBe("you are helpful");
    expect(response).toEqual({
      content: [{ type: "text", text: "hello" }],
      model: "stub-model",
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: "end_turn",
    });
  });

  test("passes tools + config through when provided", async () => {
    await providersLlmCompleteRoute.handler({
      callSite: "mainAgent",
      messages: [],
      tools: [{ name: "echo", description: "", input_schema: {} }],
      config: { model: "override-model" },
    });

    const call = sendMessageSpy.mock.calls[0] as unknown as [
      unknown[],
      unknown[],
      string | undefined,
      { config?: Record<string, unknown> } | undefined,
    ];
    expect(Array.isArray(call[1])).toBe(true);
    expect((call[1] as unknown[]).length).toBe(1);
    expect(call[3]?.config).toEqual({ model: "override-model" });
  });

  test("rejects an unknown callSite", async () => {
    await expect(
      providersLlmCompleteRoute.handler({
        callSite: "not-a-callsite",
        messages: [],
      }),
    ).rejects.toThrow();
  });

  test("throws when no provider is configured for the callSite", async () => {
    getConfiguredProviderSpy.mockImplementationOnce(async () => null);
    await expect(
      providersLlmCompleteRoute.handler({
        callSite: "mainAgent",
        messages: [],
      }),
    ).rejects.toThrow(/no provider configured/);
  });
});

describe("host.providers.stt.listProviderIds", () => {
  test("returns a fresh array of ids", () => {
    const result = providersSttListProviderIdsRoute.handler();
    expect(result).toEqual(["openai-whisper", "deepgram"]);
    expect(sttListProviderIdsSpy).toHaveBeenCalled();
  });
});

describe("host.providers.stt.supportsBoundary", () => {
  test("delegates with positional (id, boundary) and returns the bool", () => {
    sttSupportsBoundarySpy.mockImplementationOnce(() => true);
    const result = providersSttSupportsBoundaryRoute.handler({
      id: "openai-whisper",
      boundary: "daemon-streaming",
    });

    expect(result).toBe(true);
    const call = sttSupportsBoundarySpy.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(call[0]).toBe("openai-whisper");
    expect(call[1]).toBe("daemon-streaming");
  });

  test("rejects missing id", () => {
    expect(() =>
      providersSttSupportsBoundaryRoute.handler({ boundary: "x" }),
    ).toThrow();
  });

  test("rejects missing boundary", () => {
    expect(() =>
      providersSttSupportsBoundaryRoute.handler({ id: "y" }),
    ).toThrow();
  });
});

describe("host.providers.tts.resolveConfig", () => {
  test("returns a serializable config object from resolveTtsConfig(getConfig())", () => {
    const result = providersTtsResolveConfigRoute.handler();
    expect(result).toEqual({
      provider: "elevenlabs",
      providerConfig: { voiceId: "stub-voice" },
    });
    expect(getConfigSpy).toHaveBeenCalled();
    expect(resolveTtsConfigSpy).toHaveBeenCalled();
  });
});

describe("host.providers.tts.get", () => {
  test("returns a handle serialized as { id } after resolving the provider", () => {
    const result = providersTtsGetRoute.handler({ id: "elevenlabs" });
    expect(result).toEqual({ id: "elevenlabs" });
    expect(getTtsProviderSpy).toHaveBeenCalledWith("elevenlabs");
  });

  test("propagates unknown-id errors from the registry", () => {
    getTtsProviderSpy.mockImplementationOnce(() => {
      throw new Error('Unknown TTS provider "ghost".');
    });
    expect(() => providersTtsGetRoute.handler({ id: "ghost" })).toThrow(
      /Unknown TTS provider/,
    );
  });

  test("rejects empty id", () => {
    expect(() => providersTtsGetRoute.handler({ id: "" })).toThrow();
  });
});

describe("host.providers.secureKeys.getProviderKey", () => {
  test("returns the stored key for a known provider", async () => {
    const result = await providersSecureKeysGetProviderKeyRoute.handler({
      id: "present",
    });
    expect(result).toBe("secret-key");
    expect(getProviderKeyAsyncSpy).toHaveBeenCalledWith("present");
  });

  test("normalizes daemon's undefined to null for absent keys", async () => {
    const result = await providersSecureKeysGetProviderKeyRoute.handler({
      id: "absent",
    });
    expect(result).toBeNull();
  });

  test("rejects empty id", async () => {
    await expect(
      providersSecureKeysGetProviderKeyRoute.handler({ id: "" }),
    ).rejects.toThrow();
  });
});
