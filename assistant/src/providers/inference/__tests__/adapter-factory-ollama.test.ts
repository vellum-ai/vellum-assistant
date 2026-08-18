import { describe, expect, test } from "bun:test";

import { OllamaProvider } from "../../ollama/client.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

function innermostAdapter(adapter: unknown): unknown {
  let node = adapter;
  for (let depth = 0; node && depth < 8; depth++) {
    const inner = (node as { inner?: unknown }).inner;
    if (!inner) {
      return node;
    }
    node = inner;
  }
  throw new Error("wrapper chain too deep");
}

function sdkBaseUrl(adapter: unknown): string {
  const inner = innermostAdapter(adapter) as {
    client?: { baseURL?: string };
  };
  const baseURL = inner.client?.baseURL;
  if (typeof baseURL !== "string") {
    throw new Error("expected an OpenAI SDK client with baseURL");
  }
  return baseURL;
}

describe("adapter factory ollama", () => {
  test("buildProviderAdapter forwards an explicit Ollama baseURL", () => {
    const adapter = buildProviderAdapter("ollama", {
      apiKey: "",
      model: "llama3.2",
      streamTimeoutMs: 60_000,
      baseURL: "http://192.168.1.50:11434/v1",
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OllamaProvider);
    expect(sdkBaseUrl(adapter)).toBe("http://192.168.1.50:11434/v1");
  });

  test("createAdapterFromConnection wires none-auth baseUrl onto the Ollama SDK client", () => {
    const connection: ProviderConnection = {
      name: "ollama",
      provider: "ollama",
      auth: { type: "none" },
      label: null,
      baseUrl: "http://192.168.1.50:11434/v1",
      models: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isManaged: false,
    };

    const resolvedAuth: ResolvedAuth = {
      kind: "none",
      baseUrl: "http://192.168.1.50:11434/v1",
    };

    const adapter = createAdapterFromConnection(connection, resolvedAuth, {
      model: "llama3.2",
    });

    expect(adapter).not.toBeNull();
    expect(innermostAdapter(adapter)).toBeInstanceOf(OllamaProvider);
    expect(sdkBaseUrl(adapter)).toBe("http://192.168.1.50:11434/v1");
  });
});
