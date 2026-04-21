import { describe, expect, test } from "bun:test";

import { getLlmProviderEnvVar } from "../provider-env-vars.js";

describe("getLlmProviderEnvVar", () => {
  test("returns ANTHROPIC_API_KEY for anthropic", () => {
    expect(getLlmProviderEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  });

  test("returns OPENAI_API_KEY for openai", () => {
    expect(getLlmProviderEnvVar("openai")).toBe("OPENAI_API_KEY");
  });

  test("returns GEMINI_API_KEY for gemini", () => {
    expect(getLlmProviderEnvVar("gemini")).toBe("GEMINI_API_KEY");
  });

  test("returns FIREWORKS_API_KEY for fireworks", () => {
    expect(getLlmProviderEnvVar("fireworks")).toBe("FIREWORKS_API_KEY");
  });

  test("returns OPENROUTER_API_KEY for openrouter", () => {
    expect(getLlmProviderEnvVar("openrouter")).toBe("OPENROUTER_API_KEY");
  });

  test("returns undefined for ollama (keyless provider)", () => {
    expect(getLlmProviderEnvVar("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(getLlmProviderEnvVar("unknown-provider")).toBeUndefined();
  });
});
