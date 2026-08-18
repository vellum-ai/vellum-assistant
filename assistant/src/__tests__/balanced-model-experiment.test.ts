import { afterEach, describe, expect, test } from "bun:test";

import {
  getEffectiveProfile,
  resolveDefaultProfileForProvider,
} from "../config/default-profile-catalog.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const FLAG = "experiment-balanced-model-2026-08";
const CONTROL_MODEL = "gpt-5.6-luna";
const CANDIDATE_MODEL = "accounts/fireworks/models/glm-5p2";

afterEach(() => {
  setOverridesForTesting({});
});

describe("balanced model experiment", () => {
  test("default flag value serves the control model", () => {
    setOverridesForTesting({});
    const profile = getEffectiveProfile(undefined, "balanced");
    expect(profile?.model).toBe(CONTROL_MODEL);
    expect(profile?.provider).toBe("vellum");
  });

  test("an unknown arm falls back to control", () => {
    setOverridesForTesting({ [FLAG]: "candidate-z" });
    expect(getEffectiveProfile(undefined, "balanced")?.model).toBe(
      CONTROL_MODEL,
    );
  });

  test("a boolean flag value falls back to control", () => {
    setOverridesForTesting({ [FLAG]: true });
    expect(getEffectiveProfile(undefined, "balanced")?.model).toBe(
      CONTROL_MODEL,
    );
  });

  test("candidate-a serves GLM 5.2 through vellum routing", () => {
    setOverridesForTesting({ [FLAG]: "candidate-a" });
    const profile = getEffectiveProfile(undefined, "balanced");
    expect(profile?.model).toBe(CANDIDATE_MODEL);
    expect(profile?.provider).toBe("vellum");
    expect(profile?.source).toBe("managed");
    expect(profile?.provider_connection).toBeUndefined();
  });

  test("candidate-a preserves workspace-owned overlay fields", () => {
    setOverridesForTesting({ [FLAG]: "candidate-a" });
    const profile = getEffectiveProfile(
      { balanced: { source: "managed", label: "Renamed", topP: 0.5 } },
      "balanced",
    );
    expect(profile?.model).toBe(CANDIDATE_MODEL);
    expect(profile?.label).toBe("Renamed");
    expect(profile?.topP).toBe(0.5);
  });

  test("candidate-a applies on the defaultProvider-aware vellum path", () => {
    setOverridesForTesting({ [FLAG]: "candidate-a" });
    const profile = resolveDefaultProfileForProvider(undefined, "balanced", {
      provider: "vellum",
    });
    expect(profile?.model).toBe(CANDIDATE_MODEL);
  });

  test("candidate-a leaves BYOK balanced and other managed profiles alone", () => {
    setOverridesForTesting({ [FLAG]: "candidate-a" });
    const byok = resolveDefaultProfileForProvider(undefined, "balanced", {
      provider: "anthropic",
    });
    expect(byok?.provider).toBe("anthropic");
    expect(byok?.model).not.toBe(CANDIDATE_MODEL);
    const quality = getEffectiveProfile(undefined, "quality-optimized");
    expect(quality?.model).toBe("gpt-5.6-sol");
  });

  test("a user-owned shadow of balanced wins over the experiment", () => {
    setOverridesForTesting({ [FLAG]: "candidate-a" });
    const shadow = {
      source: "user",
      provider: "anthropic",
      model: "my-model",
    } as const;
    const profile = getEffectiveProfile({ balanced: shadow }, "balanced");
    expect(profile?.model).toBe("my-model");
  });
});
