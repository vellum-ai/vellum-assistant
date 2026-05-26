/**
 * Tests for the BYOK onboarding template builder. Pure function tests —
 * no DB, no file IO. The builder produces a recipe; the route handler is a
 * thin wrapper that adds eligibility-gating + the API-key credential ref.
 */

import { describe, expect, test } from "bun:test";

import {
  buildByokOnboardingTemplate,
  isProviderEligibleForByokOnboarding,
} from "../config/byok-onboarding-templates.js";
import { MANAGED_CONNECTION_NAMES } from "../providers/inference/connections.js";

const CREDENTIAL = "anthropic.api_key";

describe("isProviderEligibleForByokOnboarding", () => {
  test("accepts anthropic / openai / gemini", () => {
    expect(isProviderEligibleForByokOnboarding("anthropic")).toBe(true);
    expect(isProviderEligibleForByokOnboarding("openai")).toBe(true);
    expect(isProviderEligibleForByokOnboarding("gemini")).toBe(true);
  });

  test("rejects ollama (keyless local — no API key to set up)", () => {
    expect(isProviderEligibleForByokOnboarding("ollama")).toBe(false);
  });

  test("rejects openai-compatible (needs base_url + models, interactive)", () => {
    expect(isProviderEligibleForByokOnboarding("openai-compatible")).toBe(false);
  });

  test("rejects unknown provider ids", () => {
    expect(isProviderEligibleForByokOnboarding("not-a-real-provider")).toBe(
      false,
    );
    expect(isProviderEligibleForByokOnboarding("")).toBe(false);
  });
});

describe("buildByokOnboardingTemplate", () => {
  test("returns the canonical recipe shape for anthropic", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    expect(recipe.provider).toBe("anthropic");
    expect(recipe.activeProfile).toBe("custom-balanced");
  });

  test("personal connection points at the CES credential ref, never the raw key", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    expect(recipe.personalConnection).toEqual({
      name: "anthropic-personal",
      provider: "anthropic",
      label: "Anthropic (Personal)",
      auth: { type: "api_key", credential: CREDENTIAL },
      status: "active",
    });
  });

  test("each managed connection comes back as a complete PATCH body", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    // The PATCH endpoint requires `auth` in the body even for status-only
    // edits, and managed connections are locked to `{type:"platform"}`. The
    // builder pre-shapes that so callers can PATCH each entry directly.
    for (const patch of recipe.managedConnectionsToDisable) {
      expect(patch.auth).toEqual({ type: "platform" });
      expect(patch.status).toBe("disabled");
      expect(typeof patch.name).toBe("string");
      expect(patch.name.length).toBeGreaterThan(0);
    }
    // Should cover every canonical managed connection, whatever the
    // catalog currently lists (anthropic/openai/gemini/fireworks/etc).
    const names = recipe.managedConnectionsToDisable.map((p) => p.name).sort();
    expect(names).toEqual(Array.from(MANAGED_CONNECTION_NAMES).sort());
  });

  test("managed profiles are disabled by name; the CLI never sees their shape", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    // The PUT route accepts {label?, status?} only for managed names, so the
    // CLI only needs the names. Mirrors MANAGED_PROFILE_NAMES.
    expect(recipe.managedProfilesToDisable.sort()).toEqual(
      ["balanced", "cost-optimized", "quality-optimized"].sort(),
    );
  });

  test("user profiles point at the personal connection and resolve to a model", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    expect(Object.keys(recipe.userProfiles).sort()).toEqual([
      "custom-balanced",
      "custom-cost-optimized",
      "custom-quality-optimized",
    ]);

    for (const profile of Object.values(recipe.userProfiles)) {
      expect(profile.provider).toBe("anthropic");
      expect(profile.provider_connection).toBe("anthropic-personal");
      // Model intent resolves to a concrete model id at template build time —
      // this is the catalog contract. Don't pin to a specific id (catalog
      // moves), just verify a non-empty string was substituted in.
      expect(typeof profile.model).toBe("string");
      expect(profile.model && profile.model.length).toBeGreaterThan(0);
      expect(profile.source).toBe("user");
    }
  });

  test("profileOrder lists managed first, then custom, in canonical order", () => {
    const recipe = buildByokOnboardingTemplate("anthropic", {
      apiKeyCredential: CREDENTIAL,
    });

    // The set of managed names + custom names is what matters — the seeder
    // never re-orders within each group either.
    const managedSet = new Set([
      "balanced",
      "quality-optimized",
      "cost-optimized",
    ]);
    const customSet = new Set([
      "custom-balanced",
      "custom-quality-optimized",
      "custom-cost-optimized",
    ]);
    const order = recipe.profileOrder;
    // 3 managed templates + 3 custom user profiles. (Note: number of *managed
    // profiles* is fixed at 3 — MANAGED_PROFILE_TEMPLATES — independent of how
    // many managed *connections* exist, since multiple connections currently
    // route to the same three profile templates.)
    expect(order.length).toBe(6);

    const firstCustomIdx = order.findIndex((n) => customSet.has(n));
    expect(firstCustomIdx).toBeGreaterThan(-1);
    for (let i = 0; i < firstCustomIdx; i++) {
      expect(managedSet.has(order[i]!)).toBe(true);
    }
    for (let i = firstCustomIdx; i < order.length; i++) {
      expect(customSet.has(order[i]!)).toBe(true);
    }
  });

  test("openai builds against openai-personal + openai catalog model", () => {
    const recipe = buildByokOnboardingTemplate("openai", {
      apiKeyCredential: "openai.api_key",
    });

    expect(recipe.personalConnection.name).toBe("openai-personal");
    expect(recipe.personalConnection.label).toBe("OpenAI (Personal)");
    for (const profile of Object.values(recipe.userProfiles)) {
      expect(profile.provider).toBe("openai");
      expect(profile.provider_connection).toBe("openai-personal");
    }
  });

  test("throws on ineligible provider as a defensive belt-and-suspenders", () => {
    expect(() =>
      buildByokOnboardingTemplate("ollama", { apiKeyCredential: "x" }),
    ).toThrow(/not eligible/);
    expect(() =>
      buildByokOnboardingTemplate("openai-compatible", {
        apiKeyCredential: "x",
      }),
    ).toThrow(/not eligible/);
  });
});
