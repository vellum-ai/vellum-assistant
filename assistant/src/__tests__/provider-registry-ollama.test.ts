import { beforeAll, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

// Mock secure-keys so tests don't depend on the developer's local secure storage.
const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async () => undefined,
  getProviderKeyAsync: async () => undefined,
}));

import { LLMSchema } from "../config/schemas/llm.js";
import {
  getProvider,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

const baseLlm = LLMSchema.parse({});

function ollamaConfig(webSearch: {
  mode: "managed" | "your-own";
  provider: "inference-provider-native";
}) {
  return {
    services: {
      inference: {},
      "image-generation": {
        mode: "your-own" as const,
        provider: "gemini" as const,
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": webSearch,
    },
    llm: {
      ...baseLlm,
      default: {
        ...baseLlm.default,
        provider: "ollama" as const,
        model: "claude-opus-4-6",
      },
      profiles: {
        // Disable the catalog default so resolution lands on llm.default.
        balanced: { source: "managed" as const, status: "disabled" as const },
      },
    },
  };
}

describe("provider registry (ollama)", () => {
  test("registers ollama when selected provider has no API key", async () => {
    await initializeProviders(
      ollamaConfig({
        mode: "your-own",
        provider: "inference-provider-native",
      }),
    );

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    expect(listProviders()).toEqual(["ollama"]);
  });

  test("managed native web search preference does not make ollama a managed web-search provider", async () => {
    await initializeProviders(
      ollamaConfig({
        mode: "managed",
        provider: "inference-provider-native",
      }),
    );

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    expect(listProviders()).toEqual(["ollama"]);
  });
});
