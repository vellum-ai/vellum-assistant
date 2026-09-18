import { describe, expect, test } from "bun:test";

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_OPENROUTER_IMAGE_MODEL,
  describeImageModels,
  IMAGE_MODELS,
  qualifyImageModelForOpenRouter,
  resolveImageModel,
  resolveRequestedImageModel,
} from "../image-models.js";
import { providerForModel } from "../image-service.js";

describe("image model registry", () => {
  test("aliases resolve to concrete model IDs", () => {
    expect(resolveImageModel("fast")?.id).toBe(
      "gemini-3.1-flash-image-preview",
    );
    expect(resolveImageModel("quality")?.id).toBe("gemini-3-pro-image-preview");
    expect(resolveImageModel("openai")?.id).toBe("gpt-image-2");
  });

  test("concrete IDs resolve to themselves", () => {
    for (const entry of IMAGE_MODELS) {
      expect(resolveImageModel(entry.id)?.id).toBe(entry.id);
    }
  });

  test("unknown values return undefined", () => {
    expect(resolveImageModel("gpt-image-3")).toBeUndefined();
    expect(resolveImageModel("")).toBeUndefined();
  });

  test("aliases are unique and never collide with model IDs", () => {
    const aliases = IMAGE_MODELS.map((m) => m.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    const ids = new Set(IMAGE_MODELS.map((m) => m.id));
    for (const alias of aliases) {
      expect(ids.has(alias)).toBe(false);
    }
  });

  test("default model is the first registry entry", () => {
    expect(DEFAULT_IMAGE_MODEL).toBe(IMAGE_MODELS[0].id);
  });

  test("every registry entry routes to its own provider via prefix dispatch", () => {
    for (const entry of IMAGE_MODELS) {
      expect(providerForModel(entry.id, "gemini")).toBe(entry.provider);
    }
  });

  test("describeImageModels lists every alias and ID", () => {
    const text = describeImageModels();
    for (const entry of IMAGE_MODELS) {
      expect(text).toContain(entry.alias);
      expect(text).toContain(entry.id);
    }
  });
});

describe("resolveRequestedImageModel", () => {
  test("qualifies built-in aliases for OpenRouter", () => {
    expect(resolveRequestedImageModel("fast", "openrouter")).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
    });
    expect(resolveRequestedImageModel("openai", "openrouter")).toEqual({
      model: "openai/gpt-image-2",
    });
    expect(qualifyImageModelForOpenRouter("quality")).toBe(
      "google/gemini-3-pro-image-preview",
    );
  });

  test("qualifies bare built-in IDs for OpenRouter", () => {
    expect(
      resolveRequestedImageModel("gemini-3.1-flash-image-preview", "openrouter"),
    ).toEqual({ model: DEFAULT_OPENROUTER_IMAGE_MODEL });
    expect(resolveRequestedImageModel("gpt-image-2", "openrouter")).toEqual({
      model: "openai/gpt-image-2",
    });
  });

  test("accepts arbitrary trimmed OpenRouter slugs", () => {
    expect(
      resolveRequestedImageModel("  google/gemini-3.5-flash  ", "openrouter"),
    ).toEqual({ model: "google/gemini-3.5-flash" });
    expect(
      resolveRequestedImageModel("openai/gpt-image-2", "openrouter"),
    ).toEqual({ model: "openai/gpt-image-2" });
  });

  test("rejects unknown models for built-in providers", () => {
    const gemini = resolveRequestedImageModel(
      "google/gemini-3.5-flash",
      "gemini",
    );
    expect(gemini.model).toBeUndefined();
    expect(gemini.error).toContain("Unknown model");

    const openai = resolveRequestedImageModel("black-forest-labs/flux", "openai");
    expect(openai.model).toBeUndefined();
    expect(openai.error).toContain("Unknown model");

    expect(resolveRequestedImageModel("fast", "vellum")).toEqual({
      model: "gemini-3.1-flash-image-preview",
    });
  });

  test("ignores empty or non-string input", () => {
    expect(resolveRequestedImageModel("", "openrouter")).toEqual({});
    expect(resolveRequestedImageModel("   ", "openrouter")).toEqual({});
    expect(resolveRequestedImageModel(undefined, "gemini")).toEqual({});
  });
});
