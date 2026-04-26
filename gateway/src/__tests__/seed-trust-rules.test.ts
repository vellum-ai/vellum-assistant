import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { seedTrustRulesFromRegistry } from "../db/seed-trust-rules.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
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
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Basic seeding
// ---------------------------------------------------------------------------

describe("seedTrustRulesFromRegistry()", () => {
  test("creates rows for all registry entries (top-level + subcommands)", () => {
    // initGatewayDb() already seeds, so just check the result
    const rules = store.list({ origin: "default" });
    expect(rules.length).toBeGreaterThan(0);

    // Spot-check a top-level command
    const lsRule = rules.find((r) => r.pattern === "ls");
    expect(lsRule).toBeDefined();
    expect(lsRule!.tool).toBe("bash");
    expect(lsRule!.risk).toBe("low");
    expect(lsRule!.id).toBe("default:bash:ls");

    // Spot-check a subcommand
    const gitPush = rules.find((r) => r.pattern === "git push");
    expect(gitPush).toBeDefined();
    expect(gitPush!.risk).toBe("medium");
    expect(gitPush!.id).toBe("default:bash:git-push");

    // Spot-check a nested subcommand (git stash drop)
    const gitStashDrop = rules.find((r) => r.pattern === "git stash drop");
    expect(gitStashDrop).toBeDefined();
    expect(gitStashDrop!.risk).toBe("high");
    expect(gitStashDrop!.id).toBe("default:bash:git-stash-drop");
  });

  test("count is > 200 for the current registry size", () => {
    // Rules were already seeded by initGatewayDb in beforeEach
    const rules = store.list({ origin: "default" });
    expect(rules.length).toBeGreaterThan(200);
  });

  test("re-seeding is idempotent — same number of active rules", () => {
    const rulesBefore = store.list({ origin: "default" });
    const countBefore = rulesBefore.length;

    // Seed again
    const count = seedTrustRulesFromRegistry(store);

    const rulesAfter = store.list({ origin: "default" });
    expect(rulesAfter.length).toBe(countBefore);
    expect(count).toBe(countBefore);
  });

  test("deterministic IDs are consistent across re-seeds", () => {
    const rulesBefore = store.list({ origin: "default" });
    const idsBefore = new Set(rulesBefore.map((r) => r.id));

    // Seed again
    seedTrustRulesFromRegistry(store);

    const rulesAfter = store.list({ origin: "default" });
    const idsAfter = new Set(rulesAfter.map((r) => r.id));

    expect(idsAfter).toEqual(idsBefore);
  });

  test("deterministic IDs follow default:bash:<slug> format", () => {
    const rules = store.list({ origin: "default" });
    for (const rule of rules) {
      expect(rule.id).toMatch(/^default:bash:/);
      // Slug portion should not contain spaces
      const slug = rule.id.replace("default:bash:", "");
      expect(slug).not.toContain(" ");
    }
  });
});

// ---------------------------------------------------------------------------
// Three-guard protection
// ---------------------------------------------------------------------------

describe("three-guard upsert protection", () => {
  test("user-modified rule is NOT overwritten on re-seed", () => {
    // Modify a seeded rule's risk
    const lsRule = store.getById("default:bash:ls")!;
    expect(lsRule.risk).toBe("low");

    store.update("default:bash:ls", { risk: "high" });

    const modified = store.getById("default:bash:ls")!;
    expect(modified.risk).toBe("high");
    expect(modified.userModified).toBe(true);

    // Re-seed
    seedTrustRulesFromRegistry(store);

    // Verify the modified rule was NOT overwritten
    const afterReseed = store.getById("default:bash:ls")!;
    expect(afterReseed.risk).toBe("high");
    expect(afterReseed.userModified).toBe(true);
  });

  test("soft-deleted rule is NOT restored on re-seed", () => {
    // Soft-delete a seeded rule
    store.remove("default:bash:ls");

    const deleted = store.getById("default:bash:ls")!;
    expect(deleted.deleted).toBe(true);

    // Re-seed
    seedTrustRulesFromRegistry(store);

    // Verify the deleted rule was NOT restored
    const afterReseed = store.getById("default:bash:ls")!;
    expect(afterReseed.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Description generation
// ---------------------------------------------------------------------------

describe("description generation", () => {
  test("uses spec.reason when present", () => {
    const sudoRule = store.getById("default:bash:sudo")!;
    expect(sudoRule.description).toContain("Elevates to superuser privileges");
  });

  test("generates default description when no reason", () => {
    const lsRule = store.getById("default:bash:ls")!;
    expect(lsRule.description).toBe("ls (default)");
  });
});
