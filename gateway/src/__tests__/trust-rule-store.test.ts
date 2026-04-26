import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
//
// resetGatewayDb() only closes the connection — the SQLite file persists
// inside the per-file temp dir set by test-preload. That means tool+pattern
// pairs must be unique across every test in this file or the UNIQUE index
// on (tool, pattern) will trip on re-inserts.
// ---------------------------------------------------------------------------

let store: TrustRuleStore;

/**
 * Baseline counts captured after initGatewayDb() seeds the registry defaults.
 * Tests that assert counts use these as a starting point.
 */
let seededDefaultCount: number;
let seededBashCount: number;
let seededTotalCount: number;
let seededTotalWithDeleted: number;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  store = new TrustRuleStore();

  // Capture baselines — initGatewayDb() seeds DEFAULT_COMMAND_REGISTRY.
  // The file accumulates user rules across tests, so these counts drift
  // upward; tests should always compute deltas relative to the baseline.
  // `seededTotalWithDeleted` is needed separately because prior tests may
  // have soft-deleted rules that `list()` hides but `list({ includeDeleted })`
  // surfaces.
  seededDefaultCount = store.list({ origin: "default" }).length;
  seededBashCount = store.list({ tool: "bash" }).length;
  seededTotalCount = store.list().length;
  seededTotalWithDeleted = store.list({ includeDeleted: true }).length;
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("create()", () => {
  test("creates a user-defined rule with all fields", () => {
    const rule = store.create({
      tool: "bash",
      pattern: "create-all-fields-echo",
      risk: "low",
      description: "Allow echo commands",
    });

    expect(rule.id).toBeTruthy();
    // Should be a valid UUID format
    expect(rule.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(rule.tool).toBe("bash");
    expect(rule.pattern).toBe("create-all-fields-echo");
    expect(rule.risk).toBe("low");
    expect(rule.description).toBe("Allow echo commands");
    expect(rule.origin).toBe("user_defined");
    expect(rule.userModified).toBe(false);
    expect(rule.deleted).toBe(false);
    expect(rule.createdAt).toBeTruthy();
    expect(rule.updatedAt).toBeTruthy();
  });

  test("sets createdAt and updatedAt to ISO 8601 UTC", () => {
    const before = new Date().toISOString();
    const rule = store.create({
      tool: "bash",
      pattern: "create-iso-ls",
      risk: "low",
      description: "test",
    });
    const after = new Date().toISOString();

    expect(rule.createdAt >= before).toBe(true);
    expect(rule.createdAt <= after).toBe(true);
    expect(rule.updatedAt).toBe(rule.createdAt);
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
  test("returns all non-deleted rules by default", () => {
    store.create({
      tool: "bash",
      pattern: "list-default-bash",
      risk: "low",
      description: "Rule 1",
    });
    store.create({
      tool: "file_read",
      pattern: "/list-default/tmp/**",
      risk: "medium",
      description: "Rule 2",
    });

    const rules = store.list();
    expect(rules).toHaveLength(seededTotalCount + 2);
  });

  test("filters by origin", () => {
    store.create({
      tool: "bash",
      pattern: "list-origin-user",
      risk: "low",
      description: "User rule",
    });
    store.upsertDefault({
      id: "default:bash:list-origin-rm-rf",
      tool: "bash",
      pattern: "list-origin-rm-rf",
      risk: "high",
      description: "Default rule",
    });

    const userRules = store
      .list({ origin: "user_defined" })
      .filter((r) => r.pattern === "list-origin-user");
    expect(userRules).toHaveLength(1);
    expect(userRules[0].origin).toBe("user_defined");

    const defaultRules = store.list({ origin: "default" });
    expect(defaultRules).toHaveLength(seededDefaultCount + 1);
    expect(defaultRules.every((r) => r.origin === "default")).toBe(true);
  });

  test("filters by tool", () => {
    store.create({
      tool: "bash",
      pattern: "list-tool-bash",
      risk: "low",
      description: "Bash rule",
    });
    store.create({
      tool: "file_read",
      pattern: "/list-tool/tmp/**",
      risk: "medium",
      description: "File rule",
    });

    const bashRules = store.list({ tool: "bash" });
    expect(bashRules).toHaveLength(seededBashCount + 1);
    expect(bashRules.every((r) => r.tool === "bash")).toBe(true);
  });

  test("excludes soft-deleted rules by default", () => {
    store.upsertDefault({
      id: "default:bash:list-excl-danger",
      tool: "bash",
      pattern: "list-excl-danger",
      risk: "high",
      description: "Danger",
    });
    store.remove("default:bash:list-excl-danger");

    const rules = store.list();
    // upsertDefault + remove is net-zero on the visible count, so we expect
    // to be back at the pre-test baseline even though the row still exists.
    expect(rules).toHaveLength(seededTotalCount);
    expect(
      rules.find((r) => r.id === "default:bash:list-excl-danger"),
    ).toBeUndefined();
  });

  test("includes soft-deleted rules when includeDeleted is true", () => {
    store.upsertDefault({
      id: "default:bash:list-incl-danger",
      tool: "bash",
      pattern: "list-incl-danger",
      risk: "high",
      description: "Danger",
    });
    store.remove("default:bash:list-incl-danger");

    const rules = store.list({ includeDeleted: true });
    expect(rules).toHaveLength(seededTotalWithDeleted + 1);
    const deleted = rules.find((r) => r.id === "default:bash:list-incl-danger");
    expect(deleted).toBeDefined();
    expect(deleted!.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getById()
// ---------------------------------------------------------------------------

describe("getById()", () => {
  test("returns rule when found", () => {
    const created = store.create({
      tool: "bash",
      pattern: "getbyid-found-echo",
      risk: "low",
      description: "Test",
    });

    const found = store.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.tool).toBe("bash");
  });

  test("returns null when not found", () => {
    const found = store.getById("nonexistent-id");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe("update()", () => {
  test("updates risk and description", () => {
    const created = store.create({
      tool: "bash",
      pattern: "update-risk-echo",
      risk: "low",
      description: "Original",
    });

    const updated = store.update(created.id, {
      risk: "high",
      description: "Updated",
    });

    expect(updated.risk).toBe("high");
    expect(updated.description).toBe("Updated");
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });

  test("sets userModified=true for default rules", () => {
    store.upsertDefault({
      id: "default:bash:update-set-usermod",
      tool: "bash",
      pattern: "update-set-usermod",
      risk: "low",
      description: "Default rule",
    });

    const rule = store.getById("default:bash:update-set-usermod")!;
    expect(rule.userModified).toBe(false);

    const updated = store.update("default:bash:update-set-usermod", {
      risk: "high",
    });
    expect(updated.userModified).toBe(true);
  });

  test("does not set userModified for user_defined rules", () => {
    const created = store.create({
      tool: "bash",
      pattern: "update-no-usermod-echo",
      risk: "low",
      description: "User rule",
    });

    const updated = store.update(created.id, { risk: "high" });
    expect(updated.userModified).toBe(false);
  });

  test("throws if rule not found", () => {
    expect(() => store.update("nonexistent", { risk: "high" })).toThrow(
      "Trust rule not found: nonexistent",
    );
  });
});

// ---------------------------------------------------------------------------
// remove()
// ---------------------------------------------------------------------------

describe("remove()", () => {
  test("hard-deletes user_defined rules", () => {
    const created = store.create({
      tool: "bash",
      pattern: "remove-hard-echo",
      risk: "low",
      description: "User rule",
    });

    const result = store.remove(created.id);
    expect(result).toBe(true);

    // Should be completely gone, even with includeDeleted
    const found = store.getById(created.id);
    expect(found).toBeNull();

    const allRules = store.list({ includeDeleted: true });
    expect(allRules.find((r) => r.id === created.id)).toBeUndefined();
  });

  test("soft-deletes default rules", () => {
    store.upsertDefault({
      id: "default:bash:remove-soft",
      tool: "bash",
      pattern: "remove-soft",
      risk: "low",
      description: "Default rule",
    });

    const result = store.remove("default:bash:remove-soft");
    expect(result).toBe(true);

    // Should not appear in default list (without includeDeleted)
    const rules = store.list();
    expect(
      rules.find((r) => r.id === "default:bash:remove-soft"),
    ).toBeUndefined();

    // Should still exist as soft-deleted
    const found = store.getById("default:bash:remove-soft");
    expect(found).not.toBeNull();
    expect(found!.deleted).toBe(true);
  });

  test("throws if rule not found", () => {
    expect(() => store.remove("nonexistent")).toThrow(
      "Trust rule not found: nonexistent",
    );
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("reset()", () => {
  test("clears userModified and deleted, restores risk", () => {
    store.upsertDefault({
      id: "default:bash:reset-clears",
      tool: "bash",
      pattern: "reset-clears",
      risk: "low",
      description: "Default rule",
    });

    // Modify and delete
    store.update("default:bash:reset-clears", { risk: "high" });
    store.remove("default:bash:reset-clears");

    const beforeReset = store.getById("default:bash:reset-clears")!;
    expect(beforeReset.userModified).toBe(true);
    expect(beforeReset.deleted).toBe(true);
    expect(beforeReset.risk).toBe("high");

    // Reset
    const resetRule = store.reset("default:bash:reset-clears", "low");
    expect(resetRule.userModified).toBe(false);
    expect(resetRule.deleted).toBe(false);
    expect(resetRule.risk).toBe("low");
    // updatedAt is ISO millisecond precision; reset can land in the same ms
    // as the preceding update/remove on fast machines, so allow equality.
    expect(resetRule.updatedAt >= beforeReset.updatedAt).toBe(true);
  });

  test("throws if rule not found", () => {
    expect(() => store.reset("nonexistent", "low")).toThrow(
      "Trust rule not found: nonexistent",
    );
  });

  test("throws if origin is not default", () => {
    const created = store.create({
      tool: "bash",
      pattern: "reset-non-default-echo",
      risk: "low",
      description: "User rule",
    });

    expect(() => store.reset(created.id, "low")).toThrow(
      `Cannot reset non-default rule: ${created.id}`,
    );
  });
});

// ---------------------------------------------------------------------------
// upsertDefault()
// ---------------------------------------------------------------------------

describe("upsertDefault()", () => {
  test("inserts a new default rule", () => {
    store.upsertDefault({
      id: "default:bash:upsert-insert",
      tool: "bash",
      pattern: "upsert-insert",
      risk: "low",
      description: "Default rule",
    });

    const rule = store.getById("default:bash:upsert-insert");
    expect(rule).not.toBeNull();
    expect(rule!.origin).toBe("default");
    expect(rule!.userModified).toBe(false);
    expect(rule!.deleted).toBe(false);
    expect(rule!.risk).toBe("low");
  });

  test("updates unmodified default rule on conflict", () => {
    store.upsertDefault({
      id: "default:bash:upsert-conflict",
      tool: "bash",
      pattern: "upsert-conflict",
      risk: "low",
      description: "Original",
    });

    // Re-upsert with updated risk and description
    store.upsertDefault({
      id: "default:bash:upsert-conflict",
      tool: "bash",
      pattern: "upsert-conflict",
      risk: "medium",
      description: "Updated",
    });

    const rule = store.getById("default:bash:upsert-conflict")!;
    expect(rule.risk).toBe("medium");
    expect(rule.description).toBe("Updated");
  });

  test("three-guard: does NOT overwrite user-modified rule", () => {
    store.upsertDefault({
      id: "default:bash:upsert-3g-modified",
      tool: "bash",
      pattern: "upsert-3g-modified",
      risk: "low",
      description: "Original",
    });

    // User modifies the rule
    store.update("default:bash:upsert-3g-modified", { risk: "high" });

    const modified = store.getById("default:bash:upsert-3g-modified")!;
    expect(modified.userModified).toBe(true);
    expect(modified.risk).toBe("high");

    // Re-upsert should NOT overwrite because userModified=true
    store.upsertDefault({
      id: "default:bash:upsert-3g-modified",
      tool: "bash",
      pattern: "upsert-3g-modified",
      risk: "low",
      description: "Should not overwrite",
    });

    const afterUpsert = store.getById("default:bash:upsert-3g-modified")!;
    expect(afterUpsert.risk).toBe("high");
    expect(afterUpsert.description).toBe("Original");
    expect(afterUpsert.userModified).toBe(true);
  });

  test("three-guard: does NOT overwrite soft-deleted rule", () => {
    store.upsertDefault({
      id: "default:bash:upsert-3g-deleted",
      tool: "bash",
      pattern: "upsert-3g-deleted",
      risk: "low",
      description: "Original",
    });

    // Soft-delete the rule
    store.remove("default:bash:upsert-3g-deleted");

    const deleted = store.getById("default:bash:upsert-3g-deleted")!;
    expect(deleted.deleted).toBe(true);

    // Re-upsert should NOT overwrite because deleted=true
    store.upsertDefault({
      id: "default:bash:upsert-3g-deleted",
      tool: "bash",
      pattern: "upsert-3g-deleted",
      risk: "medium",
      description: "Should not overwrite",
    });

    const afterUpsert = store.getById("default:bash:upsert-3g-deleted")!;
    expect(afterUpsert.risk).toBe("low");
    expect(afterUpsert.description).toBe("Original");
    expect(afterUpsert.deleted).toBe(true);
  });

  test("three-guard: does NOT overwrite user_defined origin rule on conflict", () => {
    // Create a user-defined rule first
    store.create({
      tool: "bash",
      pattern: "upsert-3g-user-defined",
      risk: "high",
      description: "User created",
    });

    // Upsert a default with same tool+pattern should NOT overwrite
    // because origin != 'default'
    store.upsertDefault({
      id: "default:bash:upsert-3g-user-defined",
      tool: "bash",
      pattern: "upsert-3g-user-defined",
      risk: "low",
      description: "Default version",
    });

    // The user-defined rule should remain unchanged
    const rules = store.list({ tool: "bash" });
    const customRule = rules.find(
      (r) => r.pattern === "upsert-3g-user-defined",
    );
    expect(customRule).toBeDefined();
    expect(customRule!.origin).toBe("user_defined");
    expect(customRule!.risk).toBe("high");
    expect(customRule!.description).toBe("User created");
  });
});

// ---------------------------------------------------------------------------
// listActive()
// ---------------------------------------------------------------------------

describe("listActive()", () => {
  test("returns only non-deleted rules", () => {
    store.create({
      tool: "bash",
      pattern: "listactive-only-user",
      risk: "low",
      description: "Active user rule",
    });
    store.upsertDefault({
      id: "default:bash:listactive-only-danger",
      tool: "bash",
      pattern: "listactive-only-danger",
      risk: "high",
      description: "Deleted default",
    });
    store.remove("default:bash:listactive-only-danger");

    const active = store.listActive();
    // Baseline + 1 active user rule, minus the soft-deleted upsert (net 0).
    expect(active).toHaveLength(seededTotalCount + 1);
    expect(
      active.find((r) => r.pattern === "listactive-only-user"),
    ).toBeDefined();
    expect(
      active.find((r) => r.pattern === "listactive-only-danger"),
    ).toBeUndefined();
  });

  test("filters by tool", () => {
    store.create({
      tool: "bash",
      pattern: "listactive-tool-bash",
      risk: "low",
      description: "Bash rule",
    });
    store.create({
      tool: "file_read",
      pattern: "/listactive-tool/tmp/**",
      risk: "medium",
      description: "File rule",
    });

    const bashRules = store.listActive("bash");
    expect(bashRules).toHaveLength(seededBashCount + 1);
    expect(bashRules.every((r) => r.tool === "bash")).toBe(true);

    const fileRules = store
      .listActive("file_read")
      .filter((r) => r.pattern === "/listactive-tool/tmp/**");
    expect(fileRules).toHaveLength(1);
    expect(fileRules[0].tool).toBe("file_read");
  });

  test("returns all active rules when no tool filter is provided", () => {
    store.create({
      tool: "bash",
      pattern: "listactive-all-bash",
      risk: "low",
      description: "Bash rule",
    });
    store.create({
      tool: "file_read",
      pattern: "/listactive-all/tmp/**",
      risk: "medium",
      description: "File rule",
    });

    const allActive = store.listActive();
    expect(allActive).toHaveLength(seededTotalCount + 2);
  });
});
