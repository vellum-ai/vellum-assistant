/**
 * Tests for the ACP feature gate.
 *
 * `isAcpEnabled` is an OR of the `acp` feature flag and the legacy
 * `config.acp.enabled` field: either switch enables the subsystem, and
 * neither implicitly flips the other.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setOverridesForTesting } from "../__tests__/feature-flag-test-helpers.js";
import type { AssistantConfig } from "../config/schema.js";
import { ACP_FLAG_KEY, isAcpEnabled } from "./feature-gate.js";

beforeEach(() => {
  setOverridesForTesting({});
});

afterEach(() => {
  setOverridesForTesting({});
});

/** Minimal AssistantConfig carrying only the `acp` section the gate reads. */
function makeConfig(acpEnabled: boolean): AssistantConfig {
  return {
    acp: { enabled: acpEnabled, maxConcurrentSessions: 4, agents: {} },
  } as AssistantConfig;
}

describe("isAcpEnabled", () => {
  test("returns false when both the flag and config.acp.enabled are off", () => {
    expect(isAcpEnabled(makeConfig(false))).toBe(false);
  });

  test("returns true when config.acp.enabled is true and the flag is off", () => {
    expect(isAcpEnabled(makeConfig(true))).toBe(true);
  });

  test("returns true when the flag is on and config.acp.enabled is false", () => {
    setOverridesForTesting({ [ACP_FLAG_KEY]: true });
    expect(isAcpEnabled(makeConfig(false))).toBe(true);
  });

  test("explicit flag-off override does not defeat config.acp.enabled", () => {
    setOverridesForTesting({ [ACP_FLAG_KEY]: false });
    expect(isAcpEnabled(makeConfig(true))).toBe(true);
  });
});

describe("ACP flag key format", () => {
  test(`${ACP_FLAG_KEY} uses simple kebab-case format`, () => {
    expect(ACP_FLAG_KEY).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});
