import { describe, expect, test } from "bun:test";

import {
  GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
  isGemini3Model,
  unsignedThoughtSignatureFallback,
} from "./gemini-thought-signature.js";

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

describe("unsignedThoughtSignatureFallback", () => {
  test("stamps the dummy on the first unsigned Gemini 3 call", () => {
    expect(
      unsignedThoughtSignatureFallback([undefined, undefined], {
        model: "gemini-3.7-flash",
      }),
    ).toEqual({
      index: 0,
      signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
    });
  });

  test("does not stamp when any call already has a signature", () => {
    expect(
      unsignedThoughtSignatureFallback(["signed-thought-1", undefined], {
        model: "gemini-3.7-flash",
      }),
    ).toBeUndefined();
  });

  test("does not stamp for non-Gemini-3 models when a model id is provided", () => {
    expect(
      unsignedThoughtSignatureFallback([undefined], { model: "gpt-5.2" }),
    ).toBeUndefined();
  });

  test("stamps unsigned calls when no model gate is supplied", () => {
    expect(unsignedThoughtSignatureFallback([undefined])).toEqual({
      index: 0,
      signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
    });
  });

  test("does not stamp an empty function-call list", () => {
    expect(
      unsignedThoughtSignatureFallback([], { model: "gemini-3.7-flash" }),
    ).toBeUndefined();
  });
});
