/**
 * Tests for CES (Credential Execution Service) feature gates.
 *
 * Verifies:
 * - Each CES flag defaults to its registry-declared value.
 * - Each flag can be toggled independently via config overrides.
 * - Enabling CES flags does not implicitly change unrelated approval
 *   behavior or existing feature flags.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _setOverridesForTesting,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";
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

beforeEach(() => {
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AssistantConfig (flag overrides are now set via _setOverridesForTesting). */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

/** All CES flag keys for iteration. */
const ALL_CES_FLAG_KEYS = [
  CES_TOOLS_FLAG_KEY,
  CES_SHELL_LOCKDOWN_FLAG_KEY,
  CES_SECURE_INSTALL_FLAG_KEY,
  CES_GRANT_AUDIT_FLAG_KEY,
  CES_MANAGED_SIDECAR_FLAG_KEY,
] as const;

/** All CES predicate functions paired with their flag keys and expected defaults. */
const ALL_CES_PREDICATES = [
  {
    name: "isCesToolsEnabled",
    fn: isCesToolsEnabled,
    key: CES_TOOLS_FLAG_KEY,
    defaultEnabled: false,
  },
  {
    name: "isCesShellLockdownEnabled",
    fn: isCesShellLockdownEnabled,
    key: CES_SHELL_LOCKDOWN_FLAG_KEY,
    defaultEnabled: false,
  },
  {
    name: "isCesSecureInstallEnabled",
    fn: isCesSecureInstallEnabled,
    key: CES_SECURE_INSTALL_FLAG_KEY,
    defaultEnabled: false,
  },
  {
    name: "isCesGrantAuditEnabled",
    fn: isCesGrantAuditEnabled,
    key: CES_GRANT_AUDIT_FLAG_KEY,
    defaultEnabled: false,
  },
  {
    name: "isCesManagedSidecarEnabled",
    fn: isCesManagedSidecarEnabled,
    key: CES_MANAGED_SIDECAR_FLAG_KEY,
    defaultEnabled: true,
  },
] as const;

// ---------------------------------------------------------------------------
// Key format validation
// ---------------------------------------------------------------------------

describe("CES flag key format", () => {
  for (const key of ALL_CES_FLAG_KEYS) {
    test(`${key} uses simple kebab-case format`, () => {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    });
  }
});

// ---------------------------------------------------------------------------
// Defaults: each CES flag matches its registry-declared default
// ---------------------------------------------------------------------------

describe("CES flags match registry defaults", () => {
  for (const { name, fn, defaultEnabled } of ALL_CES_PREDICATES) {
    test(`${name} returns ${defaultEnabled} with no config overrides`, () => {
      const config = makeConfig();
      expect(fn(config)).toBe(defaultEnabled);
    });
  }

  for (const pred of ALL_CES_PREDICATES) {
    test(`isAssistantFeatureFlagEnabled('${pred.key}') returns ${pred.defaultEnabled} with no overrides`, () => {
      const config = makeConfig();
      expect(isAssistantFeatureFlagEnabled(pred.key, config)).toBe(
        pred.defaultEnabled,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Independent enablement: each flag can be enabled without affecting others
// ---------------------------------------------------------------------------

describe("CES flags can be toggled independently", () => {
  for (const { name, fn, key } of ALL_CES_PREDICATES) {
    test(`enabling ${key} makes ${name} return true`, () => {
      _setOverridesForTesting({ [key]: true });
      const config = makeConfig();
      expect(fn(config)).toBe(true);
    });

    test(`enabling ${key} does not change other CES flags from their defaults`, () => {
      _setOverridesForTesting({ [key]: true });
      const config = makeConfig();
      for (const {
        fn: otherFn,
        key: otherKey,
        defaultEnabled,
      } of ALL_CES_PREDICATES) {
        if (otherKey === key) continue;
        expect(otherFn(config)).toBe(defaultEnabled);
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
      _setOverridesForTesting({ [key]: false });
      const config = makeConfig();
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
    _setOverridesForTesting(overrides);
    const config = makeConfig();

    // browser defaults to true in the registry and should stay true
    expect(isAssistantFeatureFlagEnabled("browser", config)).toBe(true);
  });

  test("enabling all CES flags does not change sounds flag (defaultEnabled: true)", () => {
    const overrides: Record<string, boolean> = {};
    for (const key of ALL_CES_FLAG_KEYS) {
      overrides[key] = true;
    }
    _setOverridesForTesting(overrides);
    const config = makeConfig();

    // sounds defaults to true in the registry and should stay true
    expect(isAssistantFeatureFlagEnabled("sounds", config)).toBe(true);
  });
});
