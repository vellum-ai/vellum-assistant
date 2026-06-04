import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import {
  initTrustRuleCache,
  getTrustRuleCache,
  invalidateTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: TrustRuleStore;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleStore();
});

afterEach(() => {
  resetTrustRuleCache();
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// findBaseRisk() — exact match
//
// Every test uses a unique tool + pattern pair to avoid UNIQUE constraint
// collisions. The DB file persists across beforeEach resets within a single
// test file, so patterns must never repeat.
// ---------------------------------------------------------------------------

describe("findBaseRisk()", () => {
  test("exact match returns the matching rule", () => {
    store.create({
      tool: "cache_t1",
      pattern: "exact-match-cmd",
      risk: "high",
      description: "Dangerous remove",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk("cache_t1", "exact-match-cmd");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("exact-match-cmd");
    expect(result!.risk).toBe("high");
  });

  test("path-stripped match: /usr/bin/prog matches rule for prog", () => {
    store.create({
      tool: "cache_t2",
      pattern: "path-strip-prog",
      risk: "high",
      description: "Remove command",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk("cache_t2", "/usr/bin/path-strip-prog");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("path-strip-prog");
  });

  test("path-stripped match with arguments: /usr/bin/prog sub matches prog sub", () => {
    store.create({
      tool: "cache_t3",
      pattern: "path-strip-args push",
      risk: "medium",
      description: "Git push command",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk(
      "cache_t3",
      "/usr/bin/path-strip-args push",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("path-strip-args push");
  });

  test("subcommand match: 'prog sub --flag' falls back to 'prog'", () => {
    store.create({
      tool: "cache_t4",
      pattern: "subcmd-fallback",
      risk: "medium",
      description: "Base command",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    // "subcmd-fallback push --force" should match "subcmd-fallback" via subcommand fallback
    const result = cache.findBaseRisk(
      "cache_t4",
      "subcmd-fallback push --force",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("subcmd-fallback");
  });

  test("subcommand match prefers longer prefix", () => {
    store.create({
      tool: "cache_t5",
      pattern: "subcmd-prefer",
      risk: "low",
      description: "Base command",
    });
    store.create({
      tool: "cache_t5",
      pattern: "subcmd-prefer push",
      risk: "high",
      description: "Push subcommand",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    // "subcmd-prefer push --force" should match "subcmd-prefer push" (longer prefix wins)
    const result = cache.findBaseRisk("cache_t5", "subcmd-prefer push --force");
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("subcmd-prefer push");
    expect(result!.risk).toBe("high");
  });

  test("action: rule matches the bare resolved action key", () => {
    // The rule editor persists generalized bash patterns with an `action:`
    // prefix; the classifier resolves the command to the bare action key.
    store.create({
      tool: "cache_action_t1",
      pattern: "action:cache-action-prog avatar set",
      risk: "medium",
      description: "assistant avatar set",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    // Classifier resolves `... avatar set --image "..."` to this bare key.
    const result = cache.findBaseRisk(
      "cache_action_t1",
      "cache-action-prog avatar set",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("action:cache-action-prog avatar set");
    expect(result!.risk).toBe("medium");
  });

  test("action: rule matches via subcommand fallback", () => {
    store.create({
      tool: "cache_action_t2",
      pattern: "action:cache-action-sub",
      risk: "high",
      description: "Any cache-action-sub command",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    // Deeper resolved key falls back to the broader `action:` rule.
    const result = cache.findBaseRisk(
      "cache_action_t2",
      "cache-action-sub avatar set",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("action:cache-action-sub");
    expect(result!.risk).toBe("high");
  });

  test("literal rule takes precedence over action: rule at the same level", () => {
    store.create({
      tool: "cache_action_t3",
      pattern: "cache-action-lit deploy",
      risk: "low",
      description: "Literal",
    });
    store.create({
      tool: "cache_action_t3",
      pattern: "action:cache-action-lit deploy",
      risk: "high",
      description: "Action",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk(
      "cache_action_t3",
      "cache-action-lit deploy",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("cache-action-lit deploy");
    expect(result!.risk).toBe("low");
  });

  test("longer action: prefix wins over shorter action: prefix", () => {
    store.create({
      tool: "cache_action_t4",
      pattern: "action:cache-action-depth",
      risk: "low",
      description: "Broad",
    });
    store.create({
      tool: "cache_action_t4",
      pattern: "action:cache-action-depth avatar set",
      risk: "medium",
      description: "Specific",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk(
      "cache_action_t4",
      "cache-action-depth avatar set",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("action:cache-action-depth avatar set");
    expect(result!.risk).toBe("medium");
  });

  test("returns null when no match found", () => {
    store.create({
      tool: "cache_t6",
      pattern: "no-match-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk(
      "cache_t6",
      "nonexistent-command-no-match",
    );
    expect(result).toBeNull();
  });

  test("returns null when tool not found", () => {
    store.create({
      tool: "cache_t7",
      pattern: "tool-not-found-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findBaseRisk(
      "nonexistent_tool_cache",
      "tool-not-found-echo",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findBaseRisk() — user-rule vs seeded-default precedence
// ---------------------------------------------------------------------------

describe("findBaseRisk() precedence", () => {
  test("user action: rule wins over a seeded literal at the same key", () => {
    // Without same-key precedence the seeded literal `cmd sub` is found first
    // and the user's `action:cmd sub` is silently ignored.
    store.upsertDefault({
      id: "default:cache_prec_t1:cmd-sub",
      tool: "cache_prec_t1",
      pattern: "cmd sub",
      risk: "high",
      description: "Seeded literal default",
    });
    store.create({
      tool: "cache_prec_t1",
      pattern: "action:cmd sub",
      risk: "low",
      description: "User-saved action rule",
    });

    initTrustRuleCache(store);

    const result = getTrustRuleCache().findBaseRisk(
      "cache_prec_t1",
      "cmd sub extra",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("action:cmd sub");
    expect(result!.risk).toBe("low");
  });

  test("more specific seeded default is preserved over a broader user rule", () => {
    // A broad `action:cmd` must NOT silently override a more specific seeded
    // escalation (`cmd sub` = high). Specificity wins for seeded defaults.
    store.upsertDefault({
      id: "default:cache_prec_t2:cmd-sub",
      tool: "cache_prec_t2",
      pattern: "cmd sub",
      risk: "high",
      description: "Seeded specific default",
    });
    store.create({
      tool: "cache_prec_t2",
      pattern: "action:cmd",
      risk: "low",
      description: "Broad user rule",
    });

    initTrustRuleCache(store);

    const result = getTrustRuleCache().findBaseRisk(
      "cache_prec_t2",
      "cmd sub extra",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("cmd sub");
    expect(result!.risk).toBe("high");
  });

  test("broader user rule applies to a subcommand without its own default", () => {
    store.create({
      tool: "cache_prec_t3",
      pattern: "action:cmd",
      risk: "low",
      description: "Broad user rule",
    });

    initTrustRuleCache(store);

    const result = getTrustRuleCache().findBaseRisk(
      "cache_prec_t3",
      "cmd other extra",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("action:cmd");
    expect(result!.risk).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// findToolOverride()
// ---------------------------------------------------------------------------

describe("findToolOverride()", () => {
  test("exact match returns the matching rule", () => {
    store.create({
      tool: "cache_override_t1",
      pattern: "/etc/override-test",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findToolOverride(
      "cache_override_t1",
      "/etc/override-test",
    );
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("/etc/override-test");
    expect(result!.risk).toBe("high");
  });

  test("returns null when pattern not found", () => {
    store.create({
      tool: "cache_override_t2",
      pattern: "/etc/override-pattern-miss",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findToolOverride("cache_override_t2", "/tmp/safe");
    expect(result).toBeNull();
  });

  test("returns null when tool not found", () => {
    store.create({
      tool: "cache_override_t3",
      pattern: "/etc/override-tool-miss",
      risk: "high",
      description: "Sensitive file",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.findToolOverride(
      "nonexistent_override_tool",
      "/etc/override-tool-miss",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAllForTool()
// ---------------------------------------------------------------------------

describe("getAllForTool()", () => {
  test("returns all active rules for a given tool", () => {
    store.create({
      tool: "cache_getall_t1",
      pattern: "getall-echo",
      risk: "low",
      description: "Echo",
    });
    store.create({
      tool: "cache_getall_t1",
      pattern: "getall-rm",
      risk: "high",
      description: "Remove",
    });
    store.create({
      tool: "cache_getall_other",
      pattern: "/tmp/getall-other",
      risk: "medium",
      description: "File read",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const rules = cache.getAllForTool("cache_getall_t1");
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.pattern).sort()).toEqual([
      "getall-echo",
      "getall-rm",
    ]);
  });

  test("returns empty array when tool not found", () => {
    store.create({
      tool: "cache_getall_t2",
      pattern: "getall-empty-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    const result = cache.getAllForTool("nonexistent_getall_tool");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refresh() and invalidation
// ---------------------------------------------------------------------------

describe("refresh()", () => {
  test("cache reflects data after refresh", () => {
    store.create({
      tool: "cache_refresh_t1",
      pattern: "refresh-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    // Verify initial state
    expect(
      cache.findBaseRisk("cache_refresh_t1", "refresh-echo"),
    ).not.toBeNull();
    expect(cache.findBaseRisk("cache_refresh_t1", "refresh-curl")).toBeNull();

    // Add a new rule directly to the store (bypassing cache)
    store.create({
      tool: "cache_refresh_t1",
      pattern: "refresh-curl",
      risk: "medium",
      description: "Curl",
    });

    // Cache should still not have it
    expect(cache.findBaseRisk("cache_refresh_t1", "refresh-curl")).toBeNull();

    // After refresh, cache should pick it up
    invalidateTrustRuleCache();
    expect(
      cache.findBaseRisk("cache_refresh_t1", "refresh-curl"),
    ).not.toBeNull();
    expect(cache.findBaseRisk("cache_refresh_t1", "refresh-curl")!.risk).toBe(
      "medium",
    );
  });

  test("refresh picks up removed rules", () => {
    const rule = store.create({
      tool: "cache_refresh_t2",
      pattern: "refresh-remove-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();

    expect(
      cache.findBaseRisk("cache_refresh_t2", "refresh-remove-echo"),
    ).not.toBeNull();

    // Remove the rule from the store
    store.remove(rule.id);

    // Cache still has old data
    expect(
      cache.findBaseRisk("cache_refresh_t2", "refresh-remove-echo"),
    ).not.toBeNull();

    // After refresh, the rule should be gone
    invalidateTrustRuleCache();
    expect(
      cache.findBaseRisk("cache_refresh_t2", "refresh-remove-echo"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Singleton functions
// ---------------------------------------------------------------------------

describe("singleton functions", () => {
  test("getTrustRuleCache() throws if not initialized", () => {
    expect(() => getTrustRuleCache()).toThrow(
      "Risk rule cache not initialized",
    );
  });

  test("initTrustRuleCache() initializes the cache", () => {
    store.create({
      tool: "cache_singleton_t1",
      pattern: "singleton-echo",
      risk: "low",
      description: "Echo",
    });

    initTrustRuleCache(store);
    const cache = getTrustRuleCache();
    expect(
      cache.findBaseRisk("cache_singleton_t1", "singleton-echo"),
    ).not.toBeNull();
  });

  test("resetTrustRuleCache() clears the singleton", () => {
    initTrustRuleCache(store);
    // Should work
    getTrustRuleCache();

    resetTrustRuleCache();
    // Should throw again
    expect(() => getTrustRuleCache()).toThrow(
      "Risk rule cache not initialized",
    );
  });

  test("invalidateTrustRuleCache() is safe to call when cache is null", () => {
    // Should not throw
    invalidateTrustRuleCache();
  });
});
