/**
 * Guard: the `memoryRetrospective` call-site default must resolve to a
 * vision-capable model on every provider that offers one.
 *
 * The retrospective forks the source conversation and preserves its image
 * blocks, so a text-only model rejects every image-bearing window. Because the
 * retrospective cursor advances only on usable output, such a window is never
 * consumed: it is retried on every cooldown and can never succeed, so the
 * conversation stops forming derived memory from its first image onward.
 *
 * The invariant is asserted rather than left to a source comment because two
 * ordinary changes silently reintroduce it: flipping the default back to a
 * cheaper profile, and a catalog edit that repoints the chosen profile's model.
 *
 * Resolution mirrors `materializeProfile`: a profile impl either pins a
 * concrete `model` (the Vellum-managed impls) or carries an `intent` resolved
 * per provider (the BYOK impls).
 *
 * Providers whose profile matrix has NO vision-capable model are exempt by
 * construction rather than by allowlist: on those, every profile resolves to
 * the same text-only model, so no default could satisfy the invariant. The
 * exempt set is derived, so a provider that later gains a vision-capable model
 * is covered automatically.
 */

import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "../config/call-site-defaults.js";
import { PROFILE_IMPLS } from "../config/default-profile-catalog.js";
import { DEFAULT_PROFILE_KEYS } from "../config/default-profile-names.js";
import { doesSupportVision } from "../plugin-api/vision-support.js";
import { resolveModelIntent } from "../providers/model-intents.js";

/** The profile key the retrospective call site ships with. */
function retrospectiveProfileKey(): string {
  const key = CALL_SITE_DEFAULTS.memoryRetrospective?.profile;
  expect(key).toBeDefined();
  return key!;
}

/**
 * The concrete model a profile impl resolves to on a provider, mirroring
 * `materializeProfile`: an explicit `model` wins, otherwise the impl's
 * `intent` is resolved against that provider.
 */
function resolvedModel(
  profileKey: string,
  provider: string,
): string | undefined {
  const impl = (
    PROFILE_IMPLS as Record<
      string,
      Record<string, { model?: string; intent?: string }>
    >
  )[profileKey]?.[provider];
  if (impl == null) {
    return undefined;
  }
  if (impl.model != null && impl.model !== "") {
    return impl.model;
  }
  return impl.intent != null
    ? resolveModelIntent(provider, impl.intent as never)
    : undefined;
}

/** Providers appearing in the profile matrix. */
function allProviders(): string[] {
  return Object.keys(
    (PROFILE_IMPLS as Record<string, Record<string, unknown>>)[
      DEFAULT_PROFILE_KEYS[0]
    ],
  );
}

/** True when SOME shipped profile gives this provider a vision-capable model. */
function providerHasAnyVisionModel(provider: string): boolean {
  return DEFAULT_PROFILE_KEYS.some((key) => {
    const model = resolvedModel(key, provider);
    return model != null && model !== "" && doesSupportVision(model);
  });
}

describe("memoryRetrospective default must be vision-capable", () => {
  test("resolves to a vision-capable model on every provider that has one", () => {
    const profileKey = retrospectiveProfileKey();
    const offenders: string[] = [];

    for (const provider of allProviders()) {
      if (!providerHasAnyVisionModel(provider)) {
        continue;
      }
      const model = resolvedModel(profileKey, provider);
      if (model == null || model === "" || !doesSupportVision(model)) {
        offenders.push(`${provider} -> ${model ?? "<unresolved>"}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the Vellum-managed path specifically is vision-capable", () => {
    // The managed catalog is where the original failure was observed: the
    // shipped default resolved to a model that rejects images outright.
    const model = resolvedModel(retrospectiveProfileKey(), "vellum");
    expect(model).toBeDefined();
    expect(doesSupportVision(model!)).toBe(true);
  });

  test("records why the cheapest profile cannot be the default", () => {
    // Pins the reason this call site is not on the cheap profile. If a catalog
    // change ever makes the cheap managed model vision-capable, this fails and
    // the cost/correctness tradeoff can be revisited deliberately.
    const cheap = resolvedModel("cost-optimized", "vellum");
    expect(cheap).toBeDefined();
    expect(doesSupportVision(cheap!)).toBe(false);
  });
});
