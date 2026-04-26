/**
 * Tests for gateway trust-rule route handlers.
 *
 * Tests exercise the route handlers directly (not via the full HTTP server),
 * using the SQLite database initialized by initGatewayDb() against a temp dir.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { initGatewayDb, resetGatewayDb } from "../db/connection.js";
import { TrustRuleStore } from "../db/trust-rule-store.js";
import {
  initTrustRuleCache,
  resetTrustRuleCache,
} from "../risk/trust-rule-cache.js";
import {
  createTrustRulesListHandler,
  createTrustRulesCreateHandler,
  createTrustRulesUpdateHandler,
  createTrustRulesDeleteHandler,
  createTrustRulesResetHandler,
} from "../http/routes/trust-rules.js";
import { clearFeatureFlagStoreCache } from "../feature-flag-store.js";
import "./test-preload.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let store: TrustRuleStore;

beforeEach(async () => {
  resetGatewayDb();
  resetTrustRuleCache();
  clearFeatureFlagStoreCache();
  await initGatewayDb();
  initTrustRuleCache();
  store = new TrustRuleStore();

});

afterEach(() => {
  resetTrustRuleCache();
  clearFeatureFlagStoreCache();
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(url: string, method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules — list
// ---------------------------------------------------------------------------

describe("GET /v1/trust-rules — list", () => {
  test("default listing returns only user-relevant rules (user_defined + modified defaults)", async () => {
    const handler = createTrustRulesListHandler();

    // Without any user-defined or user-modified rules, the default listing
    // should return 0 results (seeded defaults are unmodified).
    const reqEmpty = jsonRequest("http://localhost/v1/trust-rules", "GET");
    const resEmpty = await handler(reqEmpty);
    expect(resEmpty.status).toBe(200);
    const bodyEmpty = (await resEmpty.json()) as { rules: unknown[] };
    expect(bodyEmpty.rules.length).toBe(0);

    // Create a user-defined rule — it should now appear in the default listing
    store.create({
      tool: "bash",
      pattern: "user-cmd",
      risk: "low",
      description: "user created",
    });
    const reqUser = jsonRequest("http://localhost/v1/trust-rules", "GET");
    const resUser = await handler(reqUser);
    const bodyUser = (await resUser.json()) as {
      rules: Array<{ origin: string; deleted: boolean }>;
    };
    expect(bodyUser.rules.length).toBe(1);
    expect(bodyUser.rules[0].origin).toBe("user_defined");
    expect(bodyUser.rules[0].deleted).toBe(false);

    // Modify a default rule — it should also appear in the default listing
    const defaults = store.list({ origin: "default" });
    expect(defaults.length).toBeGreaterThan(0);
    store.update(defaults[0].id, { risk: "high" });

    const reqModified = jsonRequest(
      "http://localhost/v1/trust-rules",
      "GET",
    );
    const resModified = await handler(reqModified);
    const bodyModified = (await resModified.json()) as {
      rules: Array<{ origin: string; userModified: boolean }>;
    };
    expect(bodyModified.rules.length).toBe(2);
  });

  test("origin=default returns all defaults including unmodified", async () => {
    const handler = createTrustRulesListHandler();
    const req = jsonRequest(
      "http://localhost/v1/trust-rules?origin=default",
      "GET",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { rules: unknown[] };
    // Should have seeded defaults from the command registry
    expect(body.rules.length).toBeGreaterThan(0);
    for (const rule of body.rules as Array<{
      origin: string;
      deleted: boolean;
    }>) {
      expect(rule.origin).toBe("default");
      expect(rule.deleted).toBe(false);
    }
  });

  test("filters by origin=default", async () => {
    // Create a user-defined rule so there's a mix
    store.create({
      tool: "bash",
      pattern: "my-custom-command",
      risk: "low",
      description: "test rule",
    });

    const handler = createTrustRulesListHandler();
    const req = jsonRequest(
      "http://localhost/v1/trust-rules?origin=default",
      "GET",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rules: Array<{ origin: string }>;
    };
    for (const rule of body.rules) {
      expect(rule.origin).toBe("default");
    }
  });

  test("filters by tool=bash", async () => {
    const handler = createTrustRulesListHandler();
    // Combine with origin=default to bypass userRelevantOnly filtering
    const req = jsonRequest(
      "http://localhost/v1/trust-rules?tool=bash&origin=default",
      "GET",
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rules: Array<{ tool: string }>;
    };
    expect(body.rules.length).toBeGreaterThan(0);
    for (const rule of body.rules) {
      expect(rule.tool).toBe("bash");
    }
  });

  test("includes deleted rules when include_deleted=true", async () => {
    // Soft-delete a default rule
    const defaults = store.list({ origin: "default" });
    expect(defaults.length).toBeGreaterThan(0);
    const targetRule = defaults[0];
    store.remove(targetRule.id);

    const handler = createTrustRulesListHandler();

    // Without include_deleted, the deleted rule should not appear
    // Use origin=default to bypass userRelevantOnly filtering
    const reqExclude = jsonRequest(
      "http://localhost/v1/trust-rules?origin=default",
      "GET",
    );
    const resExclude = await handler(reqExclude);
    const bodyExclude = (await resExclude.json()) as {
      rules: Array<{ id: string }>;
    };
    const deletedInExclude = bodyExclude.rules.find(
      (r) => r.id === targetRule.id,
    );
    expect(deletedInExclude).toBeUndefined();

    // With include_deleted=true, the deleted rule should appear
    const reqInclude = jsonRequest(
      "http://localhost/v1/trust-rules?origin=default&include_deleted=true",
      "GET",
    );
    const resInclude = await handler(reqInclude);
    const bodyInclude = (await resInclude.json()) as {
      rules: Array<{ id: string; deleted: boolean }>;
    };
    const deletedInInclude = bodyInclude.rules.find(
      (r) => r.id === targetRule.id,
    );
    expect(deletedInInclude).toBeDefined();
    expect(deletedInInclude!.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/trust-rules — create
// ---------------------------------------------------------------------------

describe("POST /v1/trust-rules — create", () => {
  test("creates a rule with valid body (201)", async () => {
    const handler = createTrustRulesCreateHandler();
    const req = jsonRequest("http://localhost/v1/trust-rules", "POST", {
      tool: "bash",
      pattern: "echo hello",
      risk: "low",
      description: "Allow echo hello",
    });
    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      rule: {
        tool: string;
        pattern: string;
        risk: string;
        description: string;
        origin: string;
      };
    };
    expect(body.rule.tool).toBe("bash");
    expect(body.rule.pattern).toBe("echo hello");
    expect(body.rule.risk).toBe("low");
    expect(body.rule.description).toBe("Allow echo hello");
    expect(body.rule.origin).toBe("user_defined");
  });

  test("returns 400 for missing fields", async () => {
    const handler = createTrustRulesCreateHandler();

    // Missing tool
    const res1 = await handler(
      jsonRequest("http://localhost/v1/trust-rules", "POST", {
        pattern: "echo",
        risk: "low",
        description: "test",
      }),
    );
    expect(res1.status).toBe(400);

    // Missing pattern
    const res2 = await handler(
      jsonRequest("http://localhost/v1/trust-rules", "POST", {
        tool: "bash",
        risk: "low",
        description: "test",
      }),
    );
    expect(res2.status).toBe(400);

    // Missing risk
    const res3 = await handler(
      jsonRequest("http://localhost/v1/trust-rules", "POST", {
        tool: "bash",
        pattern: "echo",
        description: "test",
      }),
    );
    expect(res3.status).toBe(400);

    // Missing description
    const res4 = await handler(
      jsonRequest("http://localhost/v1/trust-rules", "POST", {
        tool: "bash",
        pattern: "echo",
        risk: "low",
      }),
    );
    expect(res4.status).toBe(400);
  });

  test("returns 400 for invalid risk value", async () => {
    const handler = createTrustRulesCreateHandler();
    const req = jsonRequest("http://localhost/v1/trust-rules", "POST", {
      tool: "bash",
      pattern: "echo",
      risk: "critical",
      description: "test",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("risk");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/trust-rules/:id — update
// ---------------------------------------------------------------------------

describe("PATCH /v1/trust-rules/:id — update", () => {
  test("updates risk and description (200)", async () => {
    const created = store.create({
      tool: "bash",
      pattern: "test-update",
      risk: "low",
      description: "original",
    });

    const handler = createTrustRulesUpdateHandler();
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${created.id}`,
      "PATCH",
      { risk: "high", description: "updated" },
    );
    const res = await handler(req, created.id);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rule: { risk: string; description: string };
    };
    expect(body.rule.risk).toBe("high");
    expect(body.rule.description).toBe("updated");
  });

  test("returns 404 for non-existent rule", async () => {
    const handler = createTrustRulesUpdateHandler();
    const fakeId = "00000000-0000-4000-8000-000000000000";
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${fakeId}`,
      "PATCH",
      { risk: "high" },
    );
    const res = await handler(req, fakeId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/trust-rules/:id — delete
// ---------------------------------------------------------------------------

describe("DELETE /v1/trust-rules/:id — delete", () => {
  test("deletes a user-defined rule (200)", async () => {
    const created = store.create({
      tool: "bash",
      pattern: "test-delete",
      risk: "low",
      description: "to be deleted",
    });

    const handler = createTrustRulesDeleteHandler();
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${created.id}`,
      "DELETE",
    );
    const res = await handler(req, created.id);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    // Should be gone from list
    const found = store.getById(created.id);
    expect(found).toBeNull();
  });

  test("returns 404 for non-existent rule", async () => {
    const handler = createTrustRulesDeleteHandler();
    const fakeId = "00000000-0000-4000-8000-000000000000";
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${fakeId}`,
      "DELETE",
    );
    const res = await handler(req, fakeId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/:id/reset — reset default rule
// ---------------------------------------------------------------------------

describe("POST /v1/trust-rules/:id/reset — reset", () => {
  test("resets a modified default rule to original risk (200)", async () => {
    // Find a default rule seeded from the registry (e.g. "ls" which is "low")
    const defaults = store.list({ origin: "default" });
    const lsRule = defaults.find((r) => r.pattern === "ls");
    // Skip if "ls" not in defaults (shouldn't happen, but defensive)
    if (!lsRule) return;

    // Modify it to a different risk
    store.update(lsRule.id, { risk: "high" });
    const modified = store.getById(lsRule.id)!;
    expect(modified.risk).toBe("high");
    expect(modified.userModified).toBe(true);

    const handler = createTrustRulesResetHandler();
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${lsRule.id}/reset`,
      "POST",
    );
    const res = await handler(req, lsRule.id);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rule: { risk: string; userModified: boolean; deleted: boolean };
    };
    expect(body.rule.risk).toBe("low");
    expect(body.rule.userModified).toBe(false);
    expect(body.rule.deleted).toBe(false);
  });

  test("returns 404 for non-existent rule", async () => {
    const handler = createTrustRulesResetHandler();
    const fakeId = "00000000-0000-4000-8000-000000000000";
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${fakeId}/reset`,
      "POST",
    );
    const res = await handler(req, fakeId);
    expect(res.status).toBe(404);
  });

  test("returns 400 for non-default (user_defined) rule", async () => {
    const created = store.create({
      tool: "bash",
      pattern: "test-no-reset",
      risk: "low",
      description: "user-defined, cannot reset",
    });

    const handler = createTrustRulesResetHandler();
    const req = jsonRequest(
      `http://localhost/v1/trust-rules/${created.id}/reset`,
      "POST",
    );
    const res = await handler(req, created.id);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("default");
  });
});
