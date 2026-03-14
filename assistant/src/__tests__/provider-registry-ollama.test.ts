import { describe, expect, test } from "bun:test";

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
