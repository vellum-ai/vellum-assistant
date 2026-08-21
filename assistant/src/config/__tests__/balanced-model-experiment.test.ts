import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { z } from "zod";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import {
  catalogMaxOutputTokens,
  isModelInCatalog,
} from "../../providers/model-catalog.js";
import { getManagedUpstream } from "../../providers/vellum-model-routing.js";
import { BALANCED_MODEL_EXPERIMENT_FLAG_KEY } from "../balanced-model-experiment.js";
import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfilesForProvider,
  resolveDefaultProfileForProvider,
} from "../default-profile-catalog.js";
import { clearCachedOverrides } from "../feature-flag-cache.js";
import { resolveCallSiteConfig } from "../llm-resolver.js";
import {
  type DefaultProviderConfig,
  LLMSchema,
  type ProfileEntry,
} from "../schemas/llm.js";

// The `experiment-balanced-model-2026-08-06` arm repoints the model the managed
// Balanced profile resolves to. Both the runtime resolver and the client-facing
// profile listing go through `defaultProfileBodyForProvider`, so both are
// exercised here: a disagreement between them shows the user one model beside a
// profile that runs another.

const FLAG = BALANCED_MODEL_EXPERIMENT_FLAG_KEY;
const SHIPPED_MODEL = "accounts/fireworks/models/glm-5p2";
const GLM_MODEL = SHIPPED_MODEL;

function setArm(value: boolean | string): void {
  setOverridesForTesting({ [FLAG]: value });
}

const managed: DefaultProviderConfig = { provider: "vellum" };

function llmWithActiveBalanced(
  overrides: Record<string, unknown> = {},
): z.infer<typeof LLMSchema> {
  return LLMSchema.parse({
    profiles: {},
    profileOrder: [],
    activeProfile: "balanced",
    defaultProvider: managed,
    ...overrides,
  });
}

afterEach(() => {
  clearCachedOverrides();
});

describe("balanced-model experiment arms", () => {
  test("terra repoints mainAgent at gpt-5.6-terra on the managed connection", () => {
    setArm("terra");
    const resolved = resolveCallSiteConfig(
      "mainAgent",
      llmWithActiveBalanced(),
    );
    expect(resolved.model).toBe("gpt-5.6-terra");
    expect(resolved.provider).toBe("vellum");
    expect(getManagedUpstream("gpt-5.6-terra")).toBe("openai");

    const entry = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      managed,
    );
    expect(entry?.model).toBe("gpt-5.6-terra");
    expect(entry?.provider).toBe("vellum");
    // Routing-identity providers derive their connection per request.
    expect(entry?.provider_connection).toBeUndefined();
    expect(entry?.source).toBe("managed");
  });

  test("glm-5p2 resolves mainAgent to GLM 5.2 within the model's output cap", () => {
    setArm("glm-5p2");
    const resolved = resolveCallSiteConfig(
      "mainAgent",
      llmWithActiveBalanced(),
    );
    expect(resolved.model).toBe(GLM_MODEL);
    expect(resolved.provider).toBe("vellum");

    const upstream = getManagedUpstream(GLM_MODEL);
    expect(upstream).toBe("fireworks");
    const cap = catalogMaxOutputTokens(upstream as string, GLM_MODEL);
    expect(cap).toBeDefined();
    expect(resolved.maxTokens).toBeLessThanOrEqual(cap as number);
    // The shipped token budget stands.
    expect(resolved.maxTokens).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.maxTokens as number,
    );
  });

  test("an arm changes only the model of the managed balanced body", () => {
    setArm("terra");
    const entry = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      managed,
    );
    const shipped = CODE_DEFAULT_PROFILE_ENTRIES.balanced;
    expect(entry).toEqual({ ...shipped, model: "gpt-5.6-terra" });
  });

  test("the other default profiles are untouched by an arm", () => {
    setArm("terra");
    for (const key of [
      "quality-optimized",
      "cost-optimized",
      "latency-optimized",
    ]) {
      expect(
        resolveDefaultProfileForProvider(undefined, key, managed)?.model,
      ).toBe(CODE_DEFAULT_PROFILE_ENTRIES[key].model);
    }
  });

  test("every pinned arm model is managed-routable and in its upstream catalog", () => {
    for (const model of ["gpt-5.6-terra", GLM_MODEL]) {
      const upstream = getManagedUpstream(model);
      expect(upstream).not.toBeNull();
      expect(isModelInCatalog(upstream as string, model)).toBe(true);
    }
  });
});

describe("balanced-model experiment fallbacks", () => {
  const shippedCases: [string, () => void][] = [
    ["the flag is unset", () => clearCachedOverrides()],
    ["no override is present", () => setOverridesForTesting({})],
    ["the arm is control", () => setArm("control")],
    ["the arm is an unknown string", () => setArm("gpt-9-does-not-exist")],
    ["the arm is the empty string", () => setArm("")],
    ["the value is boolean true", () => setArm(true)],
    ["the value is boolean false", () => setArm(false)],
    // The arm is remote input, so it can name an Object.prototype member. The
    // pin table is a Map, which has no such members to inherit.
    ["the arm is constructor", () => setArm("constructor")],
    ["the arm is toString", () => setArm("toString")],
    ["the arm is valueOf", () => setArm("valueOf")],
    ["the arm is __proto__", () => setArm("__proto__")],
    ["the arm is hasOwnProperty", () => setArm("hasOwnProperty")],
  ];

  for (const [label, seed] of shippedCases) {
    test(`balanced stays on the shipped model when ${label}`, () => {
      seed();
      expect(
        resolveDefaultProfileForProvider(undefined, "balanced", managed)?.model,
      ).toBe(SHIPPED_MODEL);
      expect(
        resolveCallSiteConfig("mainAgent", llmWithActiveBalanced()).model,
      ).toBe(SHIPPED_MODEL);
    });
  }

  test("the shipped catalog body is the control arm", () => {
    expect(CODE_DEFAULT_PROFILE_ENTRIES.balanced.model).toBe(SHIPPED_MODEL);
  });

  test("the registry default is control, which the override-only flag read assumes", () => {
    const registryPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "meta",
      "feature-flags",
      "feature-flag-registry.json",
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      flags: {
        key: string;
        scope: string;
        defaultEnabled: boolean | string;
        values?: string[];
      }[];
    };
    const flag = registry.flags.find((entry) => entry.key === FLAG);
    expect(flag).toBeDefined();
    expect(flag?.scope).toBe("assistant");
    expect(flag?.defaultEnabled).toBe("control");
    expect(flag?.values).toEqual(["control", "terra", "glm-5p2"]);
  });
});

describe("balanced-model experiment boundaries", () => {
  test("a user-owned balanced shadow wins over the arm", () => {
    setArm("terra");
    const profiles: Record<string, ProfileEntry> = {
      balanced: { source: "user", provider: "openai", model: "gpt-5.5" },
    };
    expect(
      resolveDefaultProfileForProvider(profiles, "balanced", managed),
    ).toEqual(profiles.balanced);
    expect(
      resolveCallSiteConfig("mainAgent", llmWithActiveBalanced({ profiles }))
        .model,
    ).toBe("gpt-5.5");
  });

  test("a managed-source stub still resolves to the arm's body", () => {
    setArm("terra");
    const profiles: Record<string, ProfileEntry> = {
      balanced: { source: "managed", label: "My Balanced" },
    };
    const entry = resolveDefaultProfileForProvider(
      profiles,
      "balanced",
      managed,
    );
    expect(entry?.model).toBe("gpt-5.6-terra");
    expect(entry?.label).toBe("My Balanced");
  });

  test("the chatgpt and BYOK columns stay out of the experiment", () => {
    setArm("terra");
    for (const provider of ["anthropic", "openai", "chatgpt"] as const) {
      const armed = resolveDefaultProfileForProvider(undefined, "balanced", {
        provider,
      });
      clearCachedOverrides();
      const shipped = resolveDefaultProfileForProvider(undefined, "balanced", {
        provider,
      });
      expect(armed).toEqual(shipped as ProfileEntry);
      expect(armed?.provider).toBe(provider);
      setArm("terra");
    }
  });

  test("an install with no defaultProvider still picks up the arm", () => {
    setArm("terra");
    expect(
      resolveDefaultProfileForProvider(undefined, "balanced", null)?.model,
    ).toBe("gpt-5.6-terra");
  });
});

describe("client-facing profile listing", () => {
  test("reports the arm's model so the UI matches what runs", () => {
    setArm("terra");
    const profiles = getEffectiveProfilesForProvider(undefined, managed);
    expect(profiles.balanced?.model).toBe("gpt-5.6-terra");
    expect(profiles["quality-optimized"]?.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES["quality-optimized"].model,
    );
  });

  test("reports the shipped model on the control arm", () => {
    setArm("control");
    expect(
      getEffectiveProfilesForProvider(undefined, managed).balanced?.model,
    ).toBe(SHIPPED_MODEL);
  });

  test("agrees with the runtime resolver on every arm", () => {
    for (const arm of ["control", "terra", "glm-5p2", "nonsense"]) {
      setArm(arm);
      const listed = getEffectiveProfilesForProvider(undefined, managed)
        .balanced?.model;
      const resolved = resolveCallSiteConfig(
        "mainAgent",
        llmWithActiveBalanced(),
      ).model;
      expect(listed).toBe(resolved as string);
    }
  });
});
