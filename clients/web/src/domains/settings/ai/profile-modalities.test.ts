import { afterEach, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";

import {
  catalogSupportedForFreeText,
  modalityEnabled,
  modalitySupported,
  parseInputModalities,
  profileUsesFreeTextModel,
  serializeInputModalities,
} from "@/domains/settings/ai/profile-modalities";

afterEach(() => {
  cleanup();
});

describe("profileUsesFreeTextModel", () => {
  test("is true for empty-catalog providers once a model is set", () => {
    expect(profileUsesFreeTextModel("openai-compatible", "qwen2.5-vl")).toBe(
      true,
    );
    expect(profileUsesFreeTextModel("litellm", "gpt-4o")).toBe(true);
    expect(profileUsesFreeTextModel("opencode", "opencode/glm-5")).toBe(true);
  });

  test("is false until both provider and model are chosen", () => {
    expect(profileUsesFreeTextModel("openai-compatible", "")).toBe(false);
    expect(profileUsesFreeTextModel("", "qwen2.5-vl")).toBe(false);
  });

  test("is false for a cataloged Anthropic model", () => {
    expect(profileUsesFreeTextModel("anthropic", "claude-opus-4-8")).toBe(
      false,
    );
  });

  test("is true for a custom id on a catalog provider", () => {
    expect(profileUsesFreeTextModel("openrouter", "tencent/hy3")).toBe(true);
  });

  test("is false for a Vellum routed catalog model", () => {
    expect(
      profileUsesFreeTextModel("vellum", "anthropic/claude-opus-4-8"),
    ).toBe(false);
  });
});

describe("serializeInputModalities", () => {
  test("omits the free-text defaults", () => {
    expect(serializeInputModalities({})).toBeNull();
  });

  test("persists an enabled image that declares support", () => {
    expect(
      serializeInputModalities({
        image: { enabled: true, supported: true },
      }),
    ).toEqual({
      image: { enabled: true, supported: true },
    });
  });
});

describe("display helpers", () => {
  test("image and audio start off and unsupported", () => {
    expect(catalogSupportedForFreeText("image")).toBe(false);
    expect(catalogSupportedForFreeText("audio")).toBe(false);
    expect(modalityEnabled("image", undefined)).toBe(false);
    expect(modalityEnabled("audio", undefined)).toBe(false);
    expect(modalitySupported("image", undefined, false)).toBe(false);
    expect(
      modalitySupported("image", { enabled: true, supported: true }, true),
    ).toBe(true);
  });
});

describe("parseInputModalities", () => {
  test("reads a stored override and ignores junk", () => {
    expect(
      parseInputModalities({
        image: { enabled: true, supported: true },
        extra: { enabled: true },
        audio: "yes",
      }),
    ).toEqual({
      image: { enabled: true, supported: true },
    });
  });
});
