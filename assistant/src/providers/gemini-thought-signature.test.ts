import { describe, expect, test } from "bun:test";

import { isGemini3Model } from "./gemini-thought-signature.js";

describe("isGemini3Model", () => {
  test("matches native Gemini 3 ids", () => {
    expect(isGemini3Model("gemini-3.7-flash")).toBe(true);
    expect(isGemini3Model("models/gemini-3.1-pro-preview")).toBe(true);
  });

  test("matches OpenAI-compatible catalog prefixes", () => {
    expect(isGemini3Model("google/gemini-3.7-flash")).toBe(true);
  });

  test("does not match Gemini 2.5 or unrelated ids", () => {
    expect(isGemini3Model("gemini-2.5-flash")).toBe(false);
    expect(isGemini3Model("gpt-5.2")).toBe(false);
  });
});
