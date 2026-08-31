import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  OpenCodeProvider,
} from "../../opencode/client.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

describe("opencode adapter factory", () => {
  test("buildProviderAdapter returns an OpenCodeProvider", () => {
    const adapter = buildProviderAdapter("opencode", {
      apiKey: "sk-opencode-test",
      model: "mimo-v2.5-free",
      streamTimeoutMs: 60_000,
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OpenCodeProvider);
    expect(adapter).toBeInstanceOf(OpenAIChatCompletionsProvider);
    expect(adapter?.name).toBe("opencode");
  });

  test("defaults to OpenCode Zen when no baseURL is set", () => {
    const adapter = buildProviderAdapter("opencode", {
      apiKey: "sk-opencode-test",
      model: "mimo-v2.5-free",
      streamTimeoutMs: 60_000,
      useNativeWebSearch: false,
    }) as OpenCodeProvider;
    const client = (
      adapter as unknown as { client: { baseURL?: string } }
    ).client;
    expect(client.baseURL).toBe(OPENCODE_ZEN_BASE_URL);
  });

  test("createAdapterFromConnection wires a custom OpenCode Go base URL", () => {
    const connection: ProviderConnection = {
      name: "opencode-go",
      provider: "opencode",
      auth: { type: "api_key", credential: "cred-opencode" },
      label: "OpenCode Go",
      baseUrl: OPENCODE_GO_BASE_URL,
      models: [{ id: "mimo-v2.5-free" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = {
      kind: "header",
      headers: { Authorization: "Bearer sk-opencode-key" },
      baseUrl: OPENCODE_GO_BASE_URL,
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "mimo-v2.5-free",
      streamTimeoutMs: 60_000,
    });

    expect(adapter).not.toBeNull();
  });

  test("createAdapterFromConnection rejects none auth for opencode", () => {
    const connection: ProviderConnection = {
      name: "opencode-keyless",
      provider: "opencode",
      auth: { type: "none" },
      label: null,
      baseUrl: OPENCODE_ZEN_BASE_URL,
      models: [{ id: "mimo-v2.5-free" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      { kind: "none" },
      {
        model: "mimo-v2.5-free",
        streamTimeoutMs: 60_000,
      },
    );

    expect(adapter).toBeNull();
  });
});
