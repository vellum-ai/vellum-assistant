import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import { classifySegment } from "../risk/bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry/index.js";
import type { CommandSegment } from "../risk/shell-parser.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CommandSegment for testing. */
function segment(command: string): CommandSegment {
  const parts = command.split(/\s+/);
  return {
    command,
    program: parts[0],
    args: parts.slice(1),
    operator: "",
  };
}

// ---------------------------------------------------------------------------
// Risk rule cache integration
// ---------------------------------------------------------------------------

describe("risk rule cache integration", () => {
  let store: TrustRuleStore;

  // initGatewayDb() seeds the trust_rules table from DEFAULT_COMMAND_REGISTRY
  // via seedTrustRulesFromRegistry(). Tests that modify existing patterns
  // (like "git push") must update the seeded rows rather than creating new ones.
  // Seeded IDs follow the pattern: default:bash:<command-with-hyphens>
  // e.g., "git push" -> "default:bash:git-push"

  beforeEach(async () => {
    resetGatewayDb();
    await initGatewayDb();
    store = new TrustRuleStore();
  });

  afterEach(() => {
    resetTrustRuleCache();
    resetGatewayDb();
  });

  test("user-modified risk override changes baseRisk", () => {
    // Modify the seeded "git push" rule's risk to "low"
    store.update("default:bash:git-push", { risk: "low" });

    initTrustRuleCache(store);

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("low");
  });

  test("matchType is user_rule when a user-modified rule determines risk", () => {
    // Modify the seeded "git push" rule — userModified becomes true
    store.update("default:bash:git-push", { risk: "low" });

    initTrustRuleCache(store);

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.matchType).toBe("user_rule");
  });

  test("matchType is user_rule when a user-defined rule determines risk", () => {
    // Modify the seeded "ls" rule — sets userModified and origin stays "default"
    // but userModified=true triggers user_rule matchType
    store.update("default:bash:ls", { risk: "low" });

    initTrustRuleCache(store);

    const result = classifySegment(segment("ls"), [], DEFAULT_COMMAND_REGISTRY);

    expect(result.matchType).toBe("user_rule");
  });

  test("arg rules still escalate on top of cached baseRisk", () => {
    // Set git push base risk to "low" via cache update
    store.update("default:bash:git-push", { risk: "low" });

    initTrustRuleCache(store);

    // git push --force should still escalate via arg rules (--force → high)
    const result = classifySegment(
      segment("git push --force"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("high");
  });

  test("fallback when cache is not initialized — classifier uses registry", () => {
    // Don't initialize the cache — resetTrustRuleCache() was called in afterEach
    // and we haven't called initTrustRuleCache() here
    resetTrustRuleCache();

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    // Should still work using registry baseRisk
    expect(result.risk).toBe("medium");
    expect(result.matchType).toBe("registry");
  });

  test("subcommand resolution — git push looks up 'git push' in cache, not just 'git'", () => {
    // Modify the seeded "git" to low, keep "git push" at its seeded risk.
    // Then modify "git push" to high. The classifier should find "git push"
    // (the more specific pattern), not "git".
    store.update("default:bash:git", { risk: "low" });
    store.update("default:bash:git-push", { risk: "high" });

    initTrustRuleCache(store);

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    // The cache should match "git push" (the more specific subcommand pattern),
    // not just "git"
    expect(result.risk).toBe("high");
  });

  test("cache override does not affect matchType when rule is not user-modified", () => {
    // The seeded "git" rule has NOT been user-modified — it's a default rule.
    // Don't call store.update() so userModified stays false.

    initTrustRuleCache(store);

    const result = classifySegment(
      segment("git status"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    // Default rule, not user-modified — matchType should remain "registry"
    expect(result.matchType).toBe("registry");
  });

  test("multi-level subcommand — git stash drop looks up 'git stash drop' in cache", () => {
    // Modify the seeded "git stash drop" rule (ID: default:bash:git-stash-drop)
    // to "low". The classifier should build the full subcommand path
    // "git stash drop" and find this specific rule in the cache.
    store.update("default:bash:git-stash-drop", { risk: "low" });

    initTrustRuleCache(store);

    const result = classifySegment(
      segment("git stash drop"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    // The cache should match the full path "git stash drop", overriding
    // the registry's high baseRisk for git stash drop.
    expect(result.risk).toBe("low");
    expect(result.matchType).toBe("user_rule");
  });

  test("multi-level subcommand — falls back to parent when specific sub not cached", () => {
    // Modify the seeded "git stash" rule to "low", but leave "git stash drop"
    // at its seeded value. Then soft-delete "git stash drop" so the cache
    // falls back to the parent "git stash" pattern.
    store.update("default:bash:git-stash", { risk: "low" });
    store.remove("default:bash:git-stash-drop");

    initTrustRuleCache(store);

    // "git stash drop" should look up "git stash drop" first, not find it
    // (soft-deleted), then the cache's findBaseRisk falls back to "git stash"
    const result = classifySegment(
      segment("git stash drop"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("low");
    expect(result.matchType).toBe("user_rule");
  });

  test("matchType resets to registry when arg rules escalate above cached base risk", () => {
    // Set git push base risk to "low" via a user-modified cache rule
    store.update("default:bash:git-push", { risk: "low" });

    initTrustRuleCache(store);

    // git push --force: cache sets base to "low" (user_rule matchType),
    // but --force arg rule escalates to "high". Since the registry's arg
    // rules determined the final risk, matchType should be "registry".
    const result = classifySegment(
      segment("git push --force"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("high");
    expect(result.matchType).toBe("registry");
  });
});
