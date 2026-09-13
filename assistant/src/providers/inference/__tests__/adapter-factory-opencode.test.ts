import { describe, expect, test } from "bun:test";

import { OpenAIChatCompletionsProvider } from "../../openai/chat-completions-provider.js";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  OpenCodeProvider,
} from "../../opencode/client.js";
import type { Provider } from "../../types.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";
import { collectModelTransports } from "../auth.js";

/** Peel the retry/usage wrappers off a connection adapter. */
function unwrapAdapter(provider: Provider): Provider {
  let current = provider;
  for (;;) {
    const inner = (current as unknown as { inner?: Provider }).inner;
    if (!inner) {
      return current;
    }
    current = inner;
  }
}

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
    const client = (adapter as unknown as { client: { baseURL?: string } })
      .client;
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

  test("buildProviderAdapter resolves the transport per model", () => {
    const adapter = buildProviderAdapter("opencode", {
      apiKey: "sk-opencode-test",
      model: "mimo-v2.5-free",
      streamTimeoutMs: 60_000,
      useNativeWebSearch: false,
    }) as OpenCodeProvider;
    expect(adapter.resolveTransport("mimo-v2.5-free")).toBe("chat_completions");
    expect(adapter.resolveTransport("muse-spark-1.2-contributor-free")).toBe(
      "responses",
    );
  });

  test("buildProviderAdapter honors explicit per-model transports", () => {
    const adapter = buildProviderAdapter("opencode", {
      apiKey: "sk-opencode-test",
      model: "mimo-v2.5-free",
      streamTimeoutMs: 60_000,
      useNativeWebSearch: false,
      modelTransports: {
        "mimo-v2.5-free": "responses",
        "muse-spark-1.2-contributor-free": "chat_completions",
      },
    }) as OpenCodeProvider;
    expect(adapter.resolveTransport("mimo-v2.5-free")).toBe("responses");
    expect(adapter.resolveTransport("muse-spark-1.2-contributor-free")).toBe(
      "chat_completions",
    );
  });

  test("collectModelTransports keeps only the entries that declare a transport", () => {
    expect(
      collectModelTransports([
        { id: "mimo-v2.5-free" },
        { id: "muse-spark-1.2-contributor-free", transport: "responses" },
        { id: "gpt-5.4", transport: "chat_completions" },
      ]),
    ).toEqual({
      "muse-spark-1.2-contributor-free": "responses",
      "gpt-5.4": "chat_completions",
    });
    expect(collectModelTransports([{ id: "mimo-v2.5-free" }])).toBeUndefined();
    expect(collectModelTransports(null)).toBeUndefined();
  });

  test("createAdapterFromConnection reads the transport from the connection's model entries", () => {
    const connection: ProviderConnection = {
      name: "opencode-zen",
      provider: "opencode",
      auth: { type: "api_key", credential: "cred-opencode" },
      label: "OpenCode Zen",
      baseUrl: null,
      models: [{ id: "mimo-v2.5-free", transport: "responses" }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const adapter = createAdapterFromConnection(
      connection,
      {
        kind: "header",
        headers: { Authorization: "Bearer sk-opencode-key" },
      },
      { model: "mimo-v2.5-free", streamTimeoutMs: 60_000 },
    );

    expect(adapter).not.toBeNull();
    const raw = unwrapAdapter(adapter!) as OpenCodeProvider;
    expect(raw).toBeInstanceOf(OpenCodeProvider);
    expect(raw.resolveTransport("mimo-v2.5-free")).toBe("responses");
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
