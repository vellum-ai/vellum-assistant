import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleV3Store } from "../db/trust-rule-v3-store.js";
import {
  initTrustRuleV3Cache,
  getTrustRuleV3Cache,
  invalidateTrustRuleV3Cache,
  resetTrustRuleV3Cache,
} from "../risk/trust-rule-v3-cache.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// findBaseRisk() — exact match
// ---------------------------------------------------------------------------

describe("findBaseRisk()", () => {
  test("exact match returns the matching rule", () => {
    store.create({
      tool: "bash",
      pattern: "rm -rf",
      risk: "high",
      description: "Dangerous remove",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findBaseRisk("bash", "rm -rf");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("rm -rf");
    expect(result!.risk).toBe("high");
  });

  test("path-stripped match: /usr/bin/rm matches rule for rm", () => {
    store.create({
      tool: "bash",
      pattern: "rm",
      risk: "high",
      description: "Remove command",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findBaseRisk("bash", "/usr/bin/rm");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("rm");
  });

  test("path-stripped match with arguments: /usr/bin/git push matches git push", () => {
    store.create({
      tool: "bash",
      pattern: "git push",
      risk: "medium",
      description: "Git push command",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findBaseRisk("bash", "/usr/bin/git push");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("git push");
  });

  test("subcommand match: 'git push --force' falls back to 'git push' then 'git'", () => {
    store.create({
      tool: "bash",
      pattern: "git",
      risk: "medium",
      description: "Git commands",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    // "git push --force" should match "git" via subcommand fallback
    const result = cache.findBaseRisk("bash", "git push --force");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("git");
  });

  test("subcommand match prefers longer prefix", () => {
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
      description: "Git push",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    // "git push --force" should match "git push" (longer prefix wins)
    const result = cache.findBaseRisk("bash", "git push --force");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("git push");
    expect(result!.risk).toBe("high");
  });

  test("returns null when no match found", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findBaseRisk("bash", "curl");
    expect(result).toBeNull();
  });

  test("returns null when tool not found", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findBaseRisk("nonexistent_tool", "echo");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findToolOverride()
// ---------------------------------------------------------------------------

describe("findToolOverride()", () => {
  test("exact match returns the matching rule", () => {
    store.create({
      tool: "file_read",
      pattern: "/etc/passwd",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findToolOverride("file_read", "/etc/passwd");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("/etc/passwd");
    expect(result!.risk).toBe("high");
  });

  test("returns null when pattern not found", () => {
    store.create({
      tool: "file_read",
      pattern: "/etc/passwd",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findToolOverride("file_read", "/tmp/safe");
    expect(result).toBeNull();
  });

  test("returns null when tool not found", () => {
    store.create({
      tool: "file_read",
      pattern: "/etc/passwd",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.findToolOverride("web_fetch", "/etc/passwd");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAllForTool()
// ---------------------------------------------------------------------------

describe("getAllForTool()", () => {
  test("returns all active rules for a given tool", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });
    store.create({
      tool: "bash",
      pattern: "rm",
      risk: "high",
      description: "Remove",
    });
    store.create({
      tool: "file_read",
      pattern: "/tmp/**",
      risk: "medium",
      description: "File read",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const bashRules = cache.getAllForTool("bash");
    expect(bashRules).toHaveLength(2);
    expect(bashRules.map((r) => r.pattern).sort()).toEqual(["echo", "rm"]);
  });

  test("returns empty array when tool not found", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    const result = cache.getAllForTool("nonexistent");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refresh() and invalidation
// ---------------------------------------------------------------------------

describe("refresh()", () => {
  test("cache reflects data after refresh", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    // Verify initial state
    expect(cache.findBaseRisk("bash", "echo")).not.toBeNull();
    expect(cache.findBaseRisk("bash", "curl")).toBeNull();

    // Add a new rule directly to the store (bypassing cache)
    store.create({
      tool: "bash",
      pattern: "curl",
      risk: "medium",
      description: "Curl",
    });

    // Cache should still not have it
    expect(cache.findBaseRisk("bash", "curl")).toBeNull();

    // After refresh, cache should pick it up
    invalidateTrustRuleV3Cache();
    expect(cache.findBaseRisk("bash", "curl")).not.toBeNull();
    expect(cache.findBaseRisk("bash", "curl")!.risk).toBe("medium");
  });

  test("refresh picks up removed rules", () => {
    const rule = store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();

    expect(cache.findBaseRisk("bash", "echo")).not.toBeNull();

    // Remove the rule from the store
    store.remove(rule.id);

    // Cache still has old data
    expect(cache.findBaseRisk("bash", "echo")).not.toBeNull();

    // After refresh, the rule should be gone
    invalidateTrustRuleV3Cache();
    expect(cache.findBaseRisk("bash", "echo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Singleton functions
// ---------------------------------------------------------------------------

describe("singleton functions", () => {
  test("getTrustRuleV3Cache() throws if not initialized", () => {
    expect(() => getTrustRuleV3Cache()).toThrow(
      "Risk rule cache not initialized",
    );
  });

  test("initTrustRuleV3Cache() initializes the cache", () => {
    store.create({
      tool: "bash",
      pattern: "echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleV3Cache(store);
    const cache = getTrustRuleV3Cache();
    expect(cache.findBaseRisk("bash", "echo")).not.toBeNull();
  });

  test("resetTrustRuleV3Cache() clears the singleton", () => {
    initTrustRuleV3Cache(store);
    // Should work
    getTrustRuleV3Cache();

    resetTrustRuleV3Cache();
    // Should throw again
    expect(() => getTrustRuleV3Cache()).toThrow(
      "Risk rule cache not initialized",
    );
  });

  test("invalidateTrustRuleV3Cache() is safe to call when cache is null", () => {
    // Should not throw
    invalidateTrustRuleV3Cache();
  });
});
