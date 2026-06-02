import { beforeEach, describe, expect, test } from "bun:test";

import {
  consumePendingProviderKey,
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@/domains/onboarding/provider-key";

beforeEach(() => {
  sessionStorage.clear();
});

describe("pending provider key", () => {
  test("round-trips provider + key through sessionStorage", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    expect(peekPendingProviderKey()).toEqual({
      provider: "anthropic",
      key: "sk-ant-test",
    });
  });

  test("peek is non-destructive, consume clears it (consume-once)", () => {
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    expect(peekPendingProviderKey()?.provider).toBe("openai");
    // Still present after peek.
    expect(peekPendingProviderKey()?.provider).toBe("openai");

    expect(consumePendingProviderKey()?.provider).toBe("openai");
    // Gone after consume.
    expect(peekPendingProviderKey()).toBeNull();
    expect(consumePendingProviderKey()).toBeNull();
  });

  test("setting null clears any pending key", () => {
    setPendingProviderKey({ provider: "gemini", key: "AIza-test" });
    setPendingProviderKey(null);
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("keyless providers store an empty key", () => {
    setPendingProviderKey({ provider: "ollama", key: "" });
    expect(consumePendingProviderKey()).toEqual({ provider: "ollama", key: "" });
  });

  test("round-trips openai-compatible baseUrl + models", () => {
    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a", "model-b"],
    });
    expect(peekPendingProviderKey()).toEqual({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a", "model-b"],
    });
  });

  test("providers without custom fields round-trip without baseUrl/models", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    const peeked = peekPendingProviderKey();
    expect(peeked).toEqual({ provider: "anthropic", key: "sk-ant-test" });
    expect(peeked?.baseUrl).toBeUndefined();
    expect(peeked?.models).toBeUndefined();
  });
});
