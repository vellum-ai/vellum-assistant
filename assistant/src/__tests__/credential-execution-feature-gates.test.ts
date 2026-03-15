/**
 * Tests for CES (Credential Execution Service) feature gates.
 *
 * Verifies:
 * - All CES flags default to disabled (safe dark-launch).
 * - Each flag can be enabled independently via config overrides.
 * - Enabling CES flags does not implicitly change unrelated approval
 *   behavior or existing feature flags.
 */

import { describe, expect, test } from "bun:test";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import {
  CES_GRANT_AUDIT_FLAG_KEY,
  CES_MANAGED_SIDECAR_FLAG_KEY,
  CES_SECURE_INSTALL_FLAG_KEY,
  CES_SHELL_LOCKDOWN_FLAG_KEY,
  CES_TOOLS_FLAG_KEY,
  isCesGrantAuditEnabled,
  isCesManagedSidecarEnabled,
  isCesSecureInstallEnabled,
  isCesShellLockdownEnabled,
  isCesToolsEnabled,
} from "../credential-execution/feature-gates.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AssistantConfig with optional feature flag values. */
function makeConfig(flagOverrides?: Record<string, boolean>): AssistantConfig {
  return {
    ...(flagOverrides ? { assistantFeatureFlagValues: flagOverrides } : {}),
  } as AssistantConfig;
}

/** All CES flag keys for iteration. */
const ALL_CES_FLAG_KEYS = [
  CES_TOOLS_FLAG_KEY,
  CES_SHELL_LOCKDOWN_FLAG_KEY,
  CES_SECURE_INSTALL_FLAG_KEY,
  CES_GRANT_AUDIT_FLAG_KEY,
  CES_MANAGED_SIDECAR_FLAG_KEY,
] as const;

/** All CES predicate functions paired with their flag keys. */
const ALL_CES_PREDICATES = [
  { name: "isCesToolsEnabled", fn: isCesToolsEnabled, key: CES_TOOLS_FLAG_KEY },
  {
    name: "isCesShellLockdownEnabled",
    fn: isCesShellLockdownEnabled,
    key: CES_SHELL_LOCKDOWN_FLAG_KEY,
  },
  {
    name: "isCesSecureInstallEnabled",
    fn: isCesSecureInstallEnabled,
    key: CES_SECURE_INSTALL_FLAG_KEY,
  },
  {
    name: "isCesGrantAuditEnabled",
    fn: isCesGrantAuditEnabled,
    key: CES_GRANT_AUDIT_FLAG_KEY,
  },
  {
    name: "isCesManagedSidecarEnabled",
    fn: isCesManagedSidecarEnabled,
    key: CES_MANAGED_SIDECAR_FLAG_KEY,
  },
] as const;

// ---------------------------------------------------------------------------
// Key format validation
// ---------------------------------------------------------------------------

describe("CES flag key format", () => {
  for (const key of ALL_CES_FLAG_KEYS) {
    test(`${key} uses canonical feature_flags.<id>.enabled format`, () => {
      expect(key).toMatch(/^feature_flags\.[a-z0-9][a-z0-9_-]*\.enabled$/);
    });
  }
});

// ---------------------------------------------------------------------------
// Default-safe: all CES flags disabled by default
// ---------------------------------------------------------------------------

describe("CES flags default safely (all disabled)", () => {
  const config = makeConfig();

  for (const { name, fn } of ALL_CES_PREDICATES) {
    test(`${name} returns false with no config overrides`, () => {
      expect(fn(config)).toBe(false);
    });
  }

  for (const key of ALL_CES_FLAG_KEYS) {
    test(`isAssistantFeatureFlagEnabled('${key}') returns false with no overrides`, () => {
      expect(isAssistantFeatureFlagEnabled(key, config)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Independent enablement: each flag can be enabled without affecting others
// ---------------------------------------------------------------------------

describe("CES flags can be enabled independently", () => {
  for (const { name, fn, key } of ALL_CES_PREDICATES) {
    test(`enabling ${key} makes ${name} return true`, () => {
      const config = makeConfig({ [key]: true });
      expect(fn(config)).toBe(true);
    });

    test(`enabling ${key} does not enable other CES flags`, () => {
      const config = makeConfig({ [key]: true });
      for (const { fn: otherFn, key: otherKey } of ALL_CES_PREDICATES) {
        if (otherKey === key) continue;
        expect(otherFn(config)).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Config override: explicit false overrides registry
// ---------------------------------------------------------------------------

describe("CES flags respect explicit false overrides", () => {
  for (const { name, fn, key } of ALL_CES_PREDICATES) {
    test(`${name} returns false when explicitly set to false`, () => {
      const config = makeConfig({ [key]: false });
      expect(fn(config)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Non-interference: CES flags do not affect unrelated flags
// ---------------------------------------------------------------------------

describe("CES flags do not affect unrelated flags", () => {
  test("enabling all CES flags does not change browser flag (defaultEnabled: true)", () => {
    const overrides: Record<string, boolean> = {};
    for (const key of ALL_CES_FLAG_KEYS) {
      overrides[key] = true;
    }
    const config = makeConfig(overrides);

    // browser defaults to true in the registry and should stay true
    expect(
      isAssistantFeatureFlagEnabled("feature_flags.browser.enabled", config),
    ).toBe(true);
  });

  test("enabling all CES flags does not change hatch-new-assistant flag (defaultEnabled: false)", () => {
    const overrides: Record<string, boolean> = {};
    for (const key of ALL_CES_FLAG_KEYS) {
      overrides[key] = true;
    }
    const config = makeConfig(overrides);

    // hatch-new-assistant defaults to false in the registry and should stay false
    expect(
      isAssistantFeatureFlagEnabled(
        "feature_flags.hatch-new-assistant.enabled",
        config,
      ),
    ).toBe(false);
  });

  test("enabling all CES flags does not change collect-usage-data flag (defaultEnabled: true)", () => {
    const overrides: Record<string, boolean> = {};
    for (const key of ALL_CES_FLAG_KEYS) {
      overrides[key] = true;
    }
    const config = makeConfig(overrides);

    expect(
      isAssistantFeatureFlagEnabled(
        "feature_flags.collect-usage-data.enabled",
        config,
      ),
    ).toBe(true);
  });
});
