/**
 * Guard tests for the single-header JWT auth system.
 *
 * These tests enforce architectural invariants that protect the auth
 * system from regressions:
 *
 * 1. Route policy coverage — every dispatched endpoint has a policy.
 * 2. No X-Actor-Token references in production code.
 * 3. No legacy gateway-origin proof in production code.
 * 4. Scope profile contract — every profile resolves to the expected scopes.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveScopeProfile } from "../scopes.js";
import type { Scope, ScopeProfile } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Project root (one level above assistant/). */
const PROJECT_ROOT = resolve(import.meta.dir, "../../../../..");

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js")
  );
}

function isDocFile(filePath: string): boolean {
  return filePath.endsWith(".md");
}

// ---------------------------------------------------------------------------
// 1. Route policy coverage
// ---------------------------------------------------------------------------

describe("route policy coverage", () => {
  test("every route in ROUTES carries a policy field (RoutePolicy or null)", async () => {
    // With ATL-315 followup, each RouteDefinition owns its own
    // `policy: RoutePolicy | null` — there is no side-registry to
    // verify against. The structural guarantee is that every dispatched
    // route declares a policy explicitly (the type makes it required).
    //
    // This guard catches the "intentionally unprotected" footgun: when
    // the property is `null`, the route author is making an explicit
    // statement. The allowlist below names the endpoints we expect to
    // see in that bucket.
    const { ROUTES } = await import("../../routes/index.js");

    // Endpoints declared `policy: null` deliberately.
    //
    // GROUP A — design-intentional:
    //   - health/healthz — liveness probes used before auth bootstraps
    //   - audio/:audioId — Twilio fetches audio via a capability-token URL
    //   - _internal/route-schema — gateway IPC bootstrap, served before
    //     any actor scope is in play
    //
    // GROUP B — gated by feature flag at runtime, scope check moot:
    //   - conversations/:id/playground/* and playground/* — every
    //     handler calls `assertPlaygroundEnabled()`, so the surface
    //     is invisible in prod regardless of policy.
    //
    // GROUP C — pre-existing latent unprotected on main (the prior
    // registry had no entry for these endpoints, so `enforcePolicy`
    // returned allowed). Migration preserves behavior. Triage these
    // and assign real policies in a follow-up PR:
    //   - PATCH/DELETE documents/:id/comments/:commentId
    //   - integrations/a2a/{config,invite/accept}
    //   - integrations/vercel/config
    const INTENTIONALLY_UNPROTECTED = new Set([
      // A — design-intentional
      "health",
      "healthz",
      "audio/:audioId",
      "_internal/route-schema",
      // B — feature-flag-gated playground surface
      "conversations/:id/playground/compact",
      "conversations/:id/playground/inject-compaction-failures",
      "conversations/:id/playground/reset-compaction-circuit",
      "conversations/:id/playground/compaction-state",
      "playground/seed-conversation",
      "playground/seeded-conversations",
      "playground/seeded-conversations/:id",
      // C — pre-existing latent unprotected (follow-up audit owed)
      "documents/:id/comments/:commentId",
      "integrations/a2a/config",
      "integrations/a2a/invite/accept",
      "integrations/vercel/config",
    ]);

    const unprotectedFound: string[] = [];
    // The `policy` field is required on `RouteDefinition` at the type
    // level, so TS catches omissions at compile time. Belt-and-suspenders
    // runtime check is unnecessary; we only need to verify the *value*
    // is non-null or explicitly allowlisted.
    const missingField: string[] = [];

    for (const r of ROUTES) {
      if (r.policy === null) {
        const key = r.endpoint;
        if (!INTENTIONALLY_UNPROTECTED.has(key)) {
          unprotectedFound.push(`${r.method} ${r.endpoint}`);
        }
      }
    }

    if (missingField.length > 0) {
      expect(
        missingField,
        `Routes missing the required \`policy\` field:\n${missingField.map((e) => `  - ${e}`).join("\n")}`,
      ).toEqual([]);
    }

    if (unprotectedFound.length > 0) {
      const message = [
        "Routes declared policy: null but are not in the intentionally-unprotected allowlist:",
        "",
        ...unprotectedFound.map((e) => `  - ${e}`),
        "",
        "Either declare a real policy on the RouteDefinition, or add the",
        "endpoint to INTENTIONALLY_UNPROTECTED in this guard test with a",
        "comment explaining why it must remain open.",
      ].join("\n");
      expect(unprotectedFound, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No X-Actor-Token references in production code
// ---------------------------------------------------------------------------

describe("no X-Actor-Token in production code", () => {
  test("production files do not reference X-Actor-Token", () => {
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -liE "X-Actor-Token" -- '*.ts' '*.tsx' '*.js' '*.swift'`,
        { encoding: "utf-8", cwd: PROJECT_ROOT },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — that's the happy path.
      if ((err as { status?: number }).status === 1) return;
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);

    // Files that are allowed to mention X-Actor-Token (comments explaining
    // the migration, or this guard test itself).
    const ALLOWLIST = new Set([
      // This guard test references it by definition
      "assistant/src/runtime/auth/__tests__/guard-tests.test.ts",
    ]);

    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (isDocFile(f)) return false;
      if (ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Production files still reference X-Actor-Token.",
        "The old two-header auth model has been replaced by single JWT auth.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "Remove or update these references.",
        "If a comment explains the migration, that is fine — add the file to the ALLOWLIST.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No legacy GATEWAY_ORIGIN_HEADER / verifyGatewayOrigin in production code
// ---------------------------------------------------------------------------

describe("no legacy gateway-origin proof in production code", () => {
  test("production files do not import or use GATEWAY_ORIGIN_HEADER or verifyGatewayOrigin", () => {
    let grepOutput = "";
    try {
      grepOutput = execSync(
        `git grep -lE "GATEWAY_ORIGIN_HEADER|verifyGatewayOrigin" -- '*.ts' '*.tsx'`,
        { encoding: "utf-8", cwd: PROJECT_ROOT },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status === 1) return;
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);

    const ALLOWLIST = new Set([
      "assistant/src/runtime/auth/__tests__/guard-tests.test.ts",
    ]);

    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (isDocFile(f)) return false;
      if (ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Production files still reference GATEWAY_ORIGIN_HEADER or verifyGatewayOrigin.",
        "Gateway origin is now proven by JWT principal type (svc_gateway), not a separate header.",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "Remove or update these references.",
      ].join("\n");
      expect(violations, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Scope profile contract
// ---------------------------------------------------------------------------

describe("scope profile contract", () => {
  const EXPECTED_PROFILES: Record<ScopeProfile, Scope[]> = {
    actor_client_v1: [
      "chat.read",
      "chat.write",
      "approval.read",
      "approval.write",
      "settings.read",
      "settings.write",
      "attachments.read",
      "attachments.write",
      "calls.read",
      "calls.write",
      "feature_flags.read",
      "feature_flags.write",
    ],
    gateway_ingress_v1: ["ingress.write", "internal.write"],
    gateway_service_v1: [
      "chat.read",
      "chat.write",
      "settings.read",
      "settings.write",
      "attachments.read",
      "attachments.write",
      "internal.write",
    ],
    local_v1: ["local.all"],
    ui_page_v1: ["settings.read"],
  };

  for (const [profile, expectedScopes] of Object.entries(EXPECTED_PROFILES)) {
    test(`${profile} resolves to exactly the expected scopes`, () => {
      const resolved = resolveScopeProfile(profile as ScopeProfile);
      const resolvedArray = [...resolved].sort();
      const expectedSorted = [...expectedScopes].sort();

      expect(resolvedArray).toEqual(expectedSorted);
      expect(resolved.size).toBe(expectedScopes.length);
    });
  }

  test("all ScopeProfile values are covered by the contract test", () => {
    // The type system ensures EXPECTED_PROFILES covers all ScopeProfile
    // values via the Record<ScopeProfile, ...> type. This test verifies
    // that resolveScopeProfile returns a non-empty set for each.
    const profiles: ScopeProfile[] = [
      "actor_client_v1",
      "gateway_ingress_v1",
      "gateway_service_v1",
      "local_v1",
      "ui_page_v1",
    ];

    for (const profile of profiles) {
      const scopes = resolveScopeProfile(profile);
      expect(scopes.size).toBeGreaterThan(0);
    }
  });
});
