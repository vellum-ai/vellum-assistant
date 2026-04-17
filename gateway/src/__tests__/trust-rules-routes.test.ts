/**
 * Tests for gateway trust-rule route handlers.
 *
 * Verifies that the route handlers canonicalize payloads through the shared
 * parseTrustRule parser before persistence: fields invalid for a tool's
 * family are stripped, and legacy request shapes are accepted without 4xx.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { clearCache } from "../trust-store.js";
import {
  createTrustRulesAddHandler,
  createTrustRulesListHandler,
  createTrustRulesMatchHandler,
} from "../http/routes/trust-rules.js";

// GATEWAY_SECURITY_DIR is set by test-preload.ts

function getSecurityDir(): string {
  return process.env.GATEWAY_SECURITY_DIR!;
}

function getTrustPath(): string {
  return join(getSecurityDir(), "trust.json");
}

function writeTrustFile(data: Record<string, unknown>): void {
  const dir = getSecurityDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getTrustPath(), JSON.stringify(data));
}

beforeEach(() => {
  clearCache();
  try {
    unlinkSync(getTrustPath());
  } catch {
    // file may not exist
  }
});

// ---------------------------------------------------------------------------
// POST /v1/trust-rules — canonicalization at route boundary
// ---------------------------------------------------------------------------

describe("POST /v1/trust-rules — canonicalization", () => {
  test("strips executionTarget from URL-family tool rules", async () => {
    const handler = createTrustRulesAddHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "web_fetch",
        pattern: "https://example.com/**",
        scope: "everywhere",
        decision: "allow",
        executionTarget: "host",
        allowHighRisk: true,
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    expect(body.rule.tool).toBe("web_fetch");
    // URL rules should NOT have executionTarget or allowHighRisk after canonicalization
    expect("executionTarget" in body.rule).toBe(false);
    expect("allowHighRisk" in body.rule).toBe(false);
  });

  test("preserves executionTarget and allowHighRisk for scoped tool rules", async () => {
    const handler = createTrustRulesAddHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "bash",
        pattern: "**",
        scope: "everywhere",
        decision: "allow",
        executionTarget: "host",
        allowHighRisk: true,
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    expect(body.rule.tool).toBe("bash");
    expect(body.rule.executionTarget).toBe("host");
    expect(body.rule.allowHighRisk).toBe(true);
  });

  test("strips executionTarget from managed-skill tool rules", async () => {
    const handler = createTrustRulesAddHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "scaffold_managed_skill",
        pattern: "**",
        scope: "everywhere",
        decision: "allow",
        executionTarget: "host",
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    expect(body.rule.tool).toBe("scaffold_managed_skill");
    expect("executionTarget" in body.rule).toBe(false);
  });

  test("strips executionTarget from skill_load rules", async () => {
    const handler = createTrustRulesAddHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "skill_load",
        pattern: "**",
        scope: "everywhere",
        decision: "allow",
        executionTarget: "host",
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    expect(body.rule.tool).toBe("skill_load");
    expect("executionTarget" in body.rule).toBe(false);
  });

  test("preserves executionTarget and allowHighRisk for generic (unknown) tool rules", async () => {
    const handler = createTrustRulesAddHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "some_future_tool",
        pattern: "**",
        scope: "everywhere",
        decision: "allow",
        executionTarget: "container",
        allowHighRisk: false,
      }),
    });

    const res = await handler(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    expect(body.rule.tool).toBe("some_future_tool");
    expect(body.rule.executionTarget).toBe("container");
    expect(body.rule.allowHighRisk).toBe(false);
  });

  test("accepts legacy payloads with invalid-for-family fields without 4xx", async () => {
    const handler = createTrustRulesAddHandler();
    // Send a legacy payload with executionTarget on a URL tool — should succeed
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool: "browser_navigate",
        pattern: "https://example.com/**",
        scope: "everywhere",
        decision: "allow",
        priority: 100,
        executionTarget: "host",
        allowHighRisk: true,
      }),
    });

    const res = await handler(req);
    // Should NOT return 4xx — legacy payloads are accepted
    expect(res.status).toBe(201);

    const body = (await res.json()) as { rule: Record<string, unknown> };
    // But the persisted rule should have the invalid fields stripped
    expect("executionTarget" in body.rule).toBe(false);
    expect("allowHighRisk" in body.rule).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/trust-rules — list
// ---------------------------------------------------------------------------

describe("GET /v1/trust-rules — list", () => {
  test("returns canonicalized rules", async () => {
    // Write a rule with fields that should be stripped on load
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "r-url",
          tool: "web_fetch",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
        {
          id: "r-bash",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
          executionTarget: "host",
          allowHighRisk: true,
        },
      ],
    });

    const handler = createTrustRulesListHandler();
    const req = new Request("http://localhost/v1/trust-rules", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      rules: Array<Record<string, unknown>>;
    };
    expect(body.rules).toHaveLength(2);

    // URL rule should have been normalized (fields stripped on load)
    const urlRule = body.rules.find((r) => r.id === "r-url")!;
    expect("executionTarget" in urlRule).toBe(false);
    expect("allowHighRisk" in urlRule).toBe(false);

    // Scoped rule should preserve fields
    const bashRule = body.rules.find((r) => r.id === "r-bash")!;
    expect(bashRule.executionTarget).toBe("host");
    expect(bashRule.allowHighRisk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/trust-rules/match — query
// ---------------------------------------------------------------------------

describe("GET /v1/trust-rules/match — query", () => {
  test("returns matching rule for tool and candidates", async () => {
    writeTrustFile({
      version: 3,
      rules: [
        {
          id: "m-1",
          tool: "bash",
          pattern: "ls **",
          scope: "everywhere",
          decision: "allow",
          priority: 100,
          createdAt: 1000,
        },
      ],
    });

    const handler = createTrustRulesMatchHandler();
    const req = new Request(
      "http://localhost/v1/trust-rules/match?tool=bash&commands=ls%20/tmp&scope=/some/dir",
      { method: "GET" },
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { rule: Record<string, unknown> | null };
    expect(body.rule).toBeTruthy();
    expect(body.rule!.id).toBe("m-1");
  });

  test("returns null when no rule matches", async () => {
    writeTrustFile({ version: 3, rules: [] });

    const handler = createTrustRulesMatchHandler();
    const req = new Request(
      "http://localhost/v1/trust-rules/match?tool=bash&commands=rm%20-rf&scope=/tmp",
      { method: "GET" },
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { rule: null };
    expect(body.rule).toBeNull();
  });
});
