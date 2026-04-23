import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleV3Store } from "../db/trust-rule-v3-store.js";
import {
  initTrustRuleV3Cache,
  resetTrustRuleV3Cache,
} from "../risk/trust-rule-v3-cache.js";
import { classifySegment } from "../risk/bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry.js";
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
  let store: TrustRuleV3Store;

  beforeEach(async () => {
    resetGatewayDb();
    await initGatewayDb();
    store = new TrustRuleV3Store();
  });

  afterEach(() => {
    resetTrustRuleV3Cache();
    resetGatewayDb();
  });

  test("user-modified risk override changes baseRisk", () => {
    // Seed a default rule for "git push" and then modify its risk to "low"
    store.upsertDefault({
      id: "test-git-push",
      tool: "bash",
      pattern: "git push",
      risk: "medium",
      description: "Git push",
    });
    store.update("test-git-push", { risk: "low" });

    initTrustRuleV3Cache(store);

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("low");
  });

  test("matchType is user_rule when a user-modified rule determines risk", () => {
    // Create a default rule and modify it — userModified becomes true
    store.upsertDefault({
      id: "test-git-push-mt",
      tool: "bash",
      pattern: "git push",
      risk: "medium",
      description: "Git push",
    });
    store.update("test-git-push-mt", { risk: "low" });

    initTrustRuleV3Cache(store);

    const result = classifySegment(
      segment("git push"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.matchType).toBe("user_rule");
  });

  test("matchType is user_rule when a user-defined rule determines risk", () => {
    // Create a user-defined rule (origin = "user_defined")
    store.create({
      tool: "bash",
      pattern: "my-custom-cmd",
      risk: "low",
      description: "Custom command",
    });

    initTrustRuleV3Cache(store);

    // my-custom-cmd is not in the registry, so it would normally be "unknown".
    // But with the cache, the risk is overridden. However, the classifier
    // checks the registry first — if there's no registry entry, it returns
    // "unknown" before reaching the cache. So use a known command instead.
    store.create({
      tool: "bash",
      pattern: "ls",
      risk: "low",
      description: "List files — user override",
    });

    // Reinitialize cache with the new rule
    resetTrustRuleV3Cache();
    initTrustRuleV3Cache(store);

    const result = classifySegment(segment("ls"), [], DEFAULT_COMMAND_REGISTRY);

    expect(result.matchType).toBe("user_rule");
  });

  test("arg rules still escalate on top of cached baseRisk", () => {
    // Set git push base risk to "low" via cache
    store.upsertDefault({
      id: "test-git-push-esc",
      tool: "bash",
      pattern: "git push",
      risk: "medium",
      description: "Git push",
    });
    store.update("test-git-push-esc", { risk: "low" });

    initTrustRuleV3Cache(store);

    // git push --force should still escalate via arg rules (--force → high)
    const result = classifySegment(
      segment("git push --force"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    expect(result.risk).toBe("high");
  });

  test("fallback when cache is not initialized — classifier uses registry", () => {
    // Don't initialize the cache — resetTrustRuleV3Cache() was called in afterEach
    // and we haven't called initTrustRuleV3Cache() here
    resetTrustRuleV3Cache();

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
    // Create rules for both "git" and "git push" with different risks
    store.create({
      tool: "bash",
      pattern: "git",
      risk: "low",
      description: "Git base",
    });
    store.create({
      tool: "bash",
      pattern: "git push",
      risk: "high",
      description: "Git push — elevated",
    });

    initTrustRuleV3Cache(store);

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
    // A default rule that has NOT been user-modified
    store.upsertDefault({
      id: "test-git-default",
      tool: "bash",
      pattern: "git",
      risk: "low",
      description: "Git default",
    });

    initTrustRuleV3Cache(store);

    const result = classifySegment(
      segment("git status"),
      [],
      DEFAULT_COMMAND_REGISTRY,
    );

    // Default rule, not user-modified — matchType should remain "registry"
    expect(result.matchType).toBe("registry");
  });
});
