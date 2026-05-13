import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkProviderApiKey } from "../lib/api-key-check.js";

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

beforeEach(() => {
  for (const key of PROVIDER_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROVIDER_KEYS) {
    delete process.env[key];
  }
});

describe("checkProviderApiKey", () => {
  test("returns hasKey:false when no provider keys are in process.env", () => {
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:false when ANTHROPIC_API_KEY is a placeholder", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-...";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:false when OPENAI_API_KEY is a placeholder", () => {
    process.env.OPENAI_API_KEY = "sk-...";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:false when key is empty", () => {
    process.env.ANTHROPIC_API_KEY = "";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(false);
  });

  test("returns hasKey:true when ANTHROPIC_API_KEY is a real key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-realkey123";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when OPENAI_API_KEY is a real key", () => {
    process.env.OPENAI_API_KEY = "sk-proj-realkey123";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when GEMINI_API_KEY is a real key", () => {
    process.env.GEMINI_API_KEY = "AIzaSyRealKey123";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when FIREWORKS_API_KEY is a real key", () => {
    process.env.FIREWORKS_API_KEY = "fw-realkey123";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(true);
  });

  test("returns hasKey:true when OPENROUTER_API_KEY is a real key", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-realkey123";
    const result = checkProviderApiKey();
    expect(result.hasKey).toBe(true);
  });
});
