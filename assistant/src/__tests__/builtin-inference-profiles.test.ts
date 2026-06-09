import { describe, expect, test } from "bun:test";

import {
  AUTO_PROFILE_KEY,
  type BuiltinProfileDefinition,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  resolveBuiltinProfiles,
} from "../config/builtin-inference-profiles.js";
import { resolveModelIntent } from "../providers/model-intents.js";

const flagAlwaysEnabled = () => true;

describe("resolveBuiltinProfiles", () => {
  test("resolves all built-ins with no overrides", () => {
    const { profiles, order } = resolveBuiltinProfiles({
      isPlatform: true,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {},
    });

    const managedNames = Object.keys(MANAGED_PROFILE_TEMPLATES);
    expect(new Set(Object.keys(profiles))).toEqual(MANAGED_PROFILE_NAMES);
    expect(order).toEqual([AUTO_PROFILE_KEY, ...managedNames]);

    for (const name of managedNames) {
      const definition = MANAGED_PROFILE_TEMPLATES[name];
      const entry = profiles[name];
      expect(entry.provider).toBe(definition.provider);
      expect(entry.provider_connection).toBe(definition.connectionName);
      expect(entry.model).toBe(
        resolveModelIntent(definition.provider, definition.intent),
      );
      expect(entry.source).toBe("managed");
      expect(entry.maxTokens).toBe(definition.maxTokens);
      // Template-internal fields must not leak onto the materialized entry.
      expect(entry).not.toContainKeys([
        "intent",
        "connectionName",
        "featureFlag",
      ]);
    }
  });

  test("auto entry is metadata-only (no provider/model)", () => {
    const { profiles } = resolveBuiltinProfiles({
      isPlatform: true,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {},
    });

    const auto = profiles[AUTO_PROFILE_KEY];
    expect(auto.label).toBe("Auto");
    expect(auto.source).toBe("managed");
    expect(auto.description).toBeString();
    expect(auto).not.toContainKeys([
      "provider",
      "model",
      "provider_connection",
    ]);
  });

  test("BYOK label suffix applied off-platform but not on-platform", () => {
    const offPlatform = resolveBuiltinProfiles({
      isPlatform: false,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {},
    });
    const onPlatform = resolveBuiltinProfiles({
      isPlatform: true,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {},
    });

    expect(offPlatform.profiles.balanced.label).toBe("Balanced (Managed)");
    expect(onPlatform.profiles.balanced.label).toBe("Balanced");
    // The auto entry never gets the BYOK suffix.
    expect(offPlatform.profiles[AUTO_PROFILE_KEY].label).toBe("Auto");
  });

  test("applies label and status overrides by key presence", () => {
    const { profiles } = resolveBuiltinProfiles({
      isPlatform: false,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {
        balanced: { label: "My Daily Driver" },
        "cost-optimized": { status: "disabled" },
        [AUTO_PROFILE_KEY]: { status: "disabled" },
      },
    });

    expect(profiles.balanced.label).toBe("My Daily Driver");
    expect(profiles.balanced.status).toBeUndefined();
    // Label key absent in the override → BYOK default label retained.
    expect(profiles["cost-optimized"].label).toBe("Speed (Managed)");
    expect(profiles["cost-optimized"].status).toBe("disabled");
    expect(profiles[AUTO_PROFILE_KEY].status).toBe("disabled");
  });

  test("explicit null override values are applied as-is", () => {
    const { profiles } = resolveBuiltinProfiles({
      isPlatform: false,
      isFlagEnabled: flagAlwaysEnabled,
      overrides: {
        balanced: { label: null, status: null },
      },
    });

    expect(profiles.balanced.label).toBeNull();
    expect(profiles.balanced.status).toBeNull();
  });

  test("flag-gated definition is omitted when the flag resolves disabled", () => {
    const flaggedName = "test-flagged-profile";
    const flaggedDefinition: BuiltinProfileDefinition = {
      ...MANAGED_PROFILE_TEMPLATES.balanced,
      label: "Flagged",
      featureFlag: "test-only-flag",
    };
    MANAGED_PROFILE_TEMPLATES[flaggedName] = flaggedDefinition;
    try {
      const disabled = resolveBuiltinProfiles({
        isPlatform: true,
        isFlagEnabled: (key) => key !== "test-only-flag",
        overrides: {},
      });
      expect(disabled.profiles).not.toContainKey(flaggedName);
      expect(disabled.order).not.toContain(flaggedName);
      // The other (flagless) built-ins are unaffected by the gate.
      expect(disabled.profiles).toContainKey("balanced");

      const enabled = resolveBuiltinProfiles({
        isPlatform: true,
        isFlagEnabled: flagAlwaysEnabled,
        overrides: {},
      });
      expect(enabled.profiles).toContainKey(flaggedName);
      expect(enabled.order).toContain(flaggedName);
    } finally {
      delete MANAGED_PROFILE_TEMPLATES[flaggedName];
    }
  });
});
