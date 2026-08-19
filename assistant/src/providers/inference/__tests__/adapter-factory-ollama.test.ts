import { describe, expect, test } from "bun:test";

import { OllamaProvider } from "../../ollama/client.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "../adapter-factory.js";
import type { ProviderConnection, ResolvedAuth } from "../auth.js";

interface RetryOptions {
  credentialSource?: string;
  connectionName?: string;
}

function retryOptions(adapter: unknown): RetryOptions {
  let node = adapter;
  for (let depth = 0; node && depth < 8; depth++) {
    const { options, inner } = node as {
      options?: RetryOptions;
      inner?: unknown;
    };
    if (options) {
      return options;
    }
    node = inner;
  }
  throw new Error("no RetryProvider found in the adapter wrapper chain");
}

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

describe("adapter factory ollama", () => {
  test("buildProviderAdapter returns an OllamaProvider", () => {
    const adapter = buildProviderAdapter("ollama", {
      apiKey: "",
      model: "llama3.2",
      streamTimeoutMs: 60_000,
      baseURL: "http://192.168.1.50:11434/v1",
      useNativeWebSearch: false,
    });
    expect(adapter).toBeInstanceOf(OllamaProvider);
  });

  test("createAdapterFromConnection accepts keyless ollama with a stored baseUrl", () => {
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
    expect(retryOptions(adapter)).toMatchObject({
      credentialSource: "no-auth",
      connectionName: "ollama",
    });
  });
});
