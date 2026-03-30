import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set up a temp directory before importing trust-store
const TEST_ROOT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  ".test-starter-bundle-" + process.pid,
);
const TRUST_PATH = join(TEST_ROOT, "protected", "trust.json");

import { mock } from "bun:test";

// Point the file-based trust backend at the test temp dir.
process.env.GATEWAY_SECURITY_DIR = join(TEST_ROOT, "protected");

// Mock the skills config module used by defaults.ts
mock.module("../config/skills.js", () => ({
  getBundledSkillsDir: () => join(TEST_ROOT, "bundled-skills"),
}));

// Now import trust-store (which uses GATEWAY_SECURITY_DIR)
import {
  acceptStarterBundle,
  clearCache,
  getAllRules,
  getStarterBundleRules,
  isStarterBundleAccepted,
} from "../permissions/trust-store.js";

describe("Starter approval bundle", () => {
  beforeEach(() => {
    // Create the test directory structure
    const protectedDir = dirname(TRUST_PATH);
    if (!existsSync(protectedDir)) {
      mkdirSync(protectedDir, { recursive: true });
    }
    // Start with a clean state
    if (existsSync(TRUST_PATH)) {
      rmSync(TRUST_PATH);
    }
    clearCache();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
    clearCache();
  });

  test("getStarterBundleRules returns a non-empty array of allow rules", () => {
    const rules = getStarterBundleRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.decision).toBe("allow");
      expect(rule.id).toMatch(/^starter:/);
      expect(rule.tool).toBeTruthy();
      expect(rule.pattern).toBeTruthy();
      expect(rule.scope).toBe("everywhere");
    }
  });

  test("starter bundle is not accepted by default", () => {
    expect(isStarterBundleAccepted()).toBe(false);
  });

  test("acceptStarterBundle seeds rules and marks bundle as accepted", () => {
    const result = acceptStarterBundle();

    expect(result.accepted).toBe(true);
    expect(result.alreadyAccepted).toBe(false);
    expect(result.rulesAdded).toBe(getStarterBundleRules().length);

    // Verify the bundle flag is now set
    expect(isStarterBundleAccepted()).toBe(true);

    // Verify rules are present in the store
    const allRules = getAllRules();
    const starterRuleIds = new Set(getStarterBundleRules().map((r) => r.id));
    const foundStarterRules = allRules.filter((r) => starterRuleIds.has(r.id));
    expect(foundStarterRules.length).toBe(getStarterBundleRules().length);
  });

  test("acceptStarterBundle is idempotent — second call adds no rules", () => {
    const first = acceptStarterBundle();
    expect(first.rulesAdded).toBeGreaterThan(0);
    expect(first.alreadyAccepted).toBe(false);

    const second = acceptStarterBundle();
    expect(second.accepted).toBe(true);
    expect(second.alreadyAccepted).toBe(true);
    expect(second.rulesAdded).toBe(0);
  });

  test("starter bundle flag persists across cache clears", () => {
    acceptStarterBundle();
    expect(isStarterBundleAccepted()).toBe(true);

    // Clear the in-memory cache to force a re-read from disk
    clearCache();

    expect(isStarterBundleAccepted()).toBe(true);
  });

  test("starter bundle flag is persisted in the trust file", () => {
    acceptStarterBundle();

    // Read the raw file and verify the flag
    const raw = readFileSync(TRUST_PATH, "utf-8");
    const data = JSON.parse(raw);
    expect(data.starterBundleAccepted).toBe(true);
  });

  test("bundle is opt-in only — rules do not appear without explicit acceptance", () => {
    // Load rules normally (triggers backfill of default rules)
    const allRules = getAllRules();

    // No starter rules should be present
    const starterRuleIds = new Set(getStarterBundleRules().map((r) => r.id));
    const foundStarterRules = allRules.filter((r) => starterRuleIds.has(r.id));
    expect(foundStarterRules.length).toBe(0);
  });

  test("starter rules have unique IDs that do not collide with defaults", () => {
    // Load default rules first
    const defaultRules = getAllRules();
    const defaultIds = new Set(defaultRules.map((r) => r.id));

    // Verify no starter rule ID collides with any default rule ID
    for (const starterRule of getStarterBundleRules()) {
      expect(defaultIds.has(starterRule.id)).toBe(false);
    }
  });
});
