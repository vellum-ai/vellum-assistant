import { describe, expect, test } from "bun:test";

import {
  formatVellumModel,
  MANAGED_ROUTABLE_PROVIDERS,
  parseVellumModel,
} from "./vellum-model-routing.js";

describe("vellum-model-routing", () => {
  test("round-trips a slashy native Fireworks id losslessly", () => {
    const native = "accounts/fireworks/models/minimax-m3";
    const encoded = formatVellumModel("fireworks", native);
    expect(encoded).toBe("fireworks/accounts/fireworks/models/minimax-m3");
    expect(parseVellumModel(encoded)).toEqual({
      provider: "fireworks",
      model: native,
    });
  });

  test("round-trips a bare Anthropic id", () => {
    const encoded = formatVellumModel("anthropic", "claude-fable-5");
    expect(parseVellumModel(encoded)).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
    });
  });

  test("format rejects a non-managed provider", () => {
    expect(() => formatVellumModel("openrouter", "x")).toThrow();
    expect(() => formatVellumModel("fireworks", "")).toThrow();
  });

  test("parse returns null for non-routed strings", () => {
    expect(parseVellumModel("claude-opus-4-8")).toBeNull(); // no slash
    expect(parseVellumModel("openrouter/whatever")).toBeNull(); // not managed
    expect(parseVellumModel("minimax/minimax-m3")).toBeNull(); // not managed
    expect(parseVellumModel("fireworks/")).toBeNull(); // empty model
    expect(parseVellumModel("/foo")).toBeNull(); // empty provider
  });

  test("managed set matches the platform proxy table", () => {
    // Guards against drift if PLATFORM_PROVIDER_META changes.
    expect([...MANAGED_ROUTABLE_PROVIDERS].sort()).toEqual([
      "anthropic",
      "fireworks",
      "gemini",
      "openai",
      "together",
    ]);
  });
});
