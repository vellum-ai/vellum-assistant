import { describe, expect, mock, test } from "bun:test";

// Mock secure-keys so tests don't depend on the developer's local secure storage.
const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKey: () => undefined,
}));

import {
  getProvider,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

describe("provider registry (ollama)", () => {
  test("registers ollama when selected provider has no API key", () => {
    initializeProviders({
      provider: "ollama",
      model: "claude-opus-4-6",
    });

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    expect(listProviders()).toEqual(["ollama"]);
  });
});
