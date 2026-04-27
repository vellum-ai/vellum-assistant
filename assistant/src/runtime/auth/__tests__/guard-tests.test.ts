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
import { readFileSync } from "node:fs";
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
  test("every endpoint dispatched in http-server.ts has a policy entry in route-policy.ts", () => {
    // Read both files as source text.
    const httpServerPath = resolve(import.meta.dir, "../../http-server.ts");
    const routePolicyPath = resolve(import.meta.dir, "../route-policy.ts");
    const routeModulesDir = resolve(import.meta.dir, "../../routes");

    const httpServerSrc = readFileSync(httpServerPath, "utf-8");
    const routePolicySrc = readFileSync(routePolicyPath, "utf-8");

    // Collect all source files to scan for endpoint literals: http-server.ts
    // plus every route module under routes/.
    const allSources = [httpServerSrc];
    try {
      const routeFiles = execSync(`ls "${routeModulesDir}"/*.ts`, {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
      for (const filePath of routeFiles) {
        allSources.push(readFileSync(filePath, "utf-8"));
      }
    } catch {
      // No route modules found — only inline routes will be covered.
    }

    // Extract endpoint policy keys from the declarative route table returned
    // by buildRouteTable(). Each route entry has an `endpoint` field and an
    // optional `policyKey` override. When `policyKey` is present it takes
    // precedence; otherwise the key is derived by stripping `:param` segments,
    // mirroring HttpRouter.compileRoute().
    const dispatchedEndpoints = new Set<string>();
    for (const src of allSources) {
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const endpointMatch = lines[i].match(/endpoint:\s*"([^"]+)"/);
        if (!endpointMatch) continue;

        // Look ahead a few lines for an optional policyKey on the same route object.
        let policyKey: string | null = null;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const pkMatch = lines[j].match(/policyKey:\s*"([^"]+)"/);
          if (pkMatch) {
            policyKey = pkMatch[1];
            break;
          }
          // Stop at the next endpoint or closing brace (end of route object).
          if (lines[j].match(/endpoint:\s*"/) || lines[j].trim() === "},")
            break;
        }

        const resolvedKey =
          policyKey ??
          endpointMatch[1]
            .split("/")
            .filter((s) => !s.startsWith(":"))
            .join("/");
        dispatchedEndpoints.add(resolvedKey);
      }
    }

    // These endpoints are in the route table but intentionally don't need
    // a route policy (they are unprotected utility endpoints).
    const UNPROTECTED_ENDPOINTS = new Set([
      "audio", // Twilio fetches audio URLs directly — audioId is a capability token
      "health",
    ]);

    // Extract registered policy endpoint strings from route-policy.ts.
    // Match: `{ endpoint: 'foo' }` entries, `registerPolicy('foo', ...)`
    // calls, and bare string literals in arrays like INTERNAL_ENDPOINTS.
    const policyEndpointMatches = routePolicySrc.matchAll(
      /endpoint:\s*"([^"]+)"|registerPolicy\(\s*"([^"]+)"/g,
    );
    const registeredPolicies = new Set<string>();
    for (const m of policyEndpointMatches) {
      registeredPolicies.add(m[1] ?? m[2]);
    }

    // Also extract string literals from the INTERNAL_ENDPOINTS array,
    // which uses a loop to register policies dynamically.
    const internalArrayMatch = routePolicySrc.match(
      /INTERNAL_ENDPOINTS\s*=\s*\[([\s\S]*?)\]/,
    );
    if (internalArrayMatch) {
      const arrayLiterals = internalArrayMatch[1].matchAll(/"([^"]+)"/g);
      for (const m of arrayLiterals) {
        registeredPolicies.add(m[1]);
      }
    }

    // The policy key might be method-qualified (e.g. `messages:POST`) or plain
    // (`messages`). Check that either the plain key or a method-qualified
    // variant is registered.
    const missingPolicies: string[] = [];
    for (const endpoint of dispatchedEndpoints) {
      if (UNPROTECTED_ENDPOINTS.has(endpoint)) continue;

      // Check if the plain endpoint or any method-qualified variant is registered
      const hasPlainPolicy = registeredPolicies.has(endpoint);
      const hasMethodPolicy = [...registeredPolicies].some((p) =>
        p.startsWith(endpoint + ":"),
      );

      if (!hasPlainPolicy && !hasMethodPolicy) {
        missingPolicies.push(endpoint);
      }
    }

    if (missingPolicies.length > 0) {
      const message = [
        "Endpoints dispatched in http-server.ts have no route policy in route-policy.ts:",
        "",
        ...missingPolicies.map((e) => `  - ${e}`),
        "",
        "Every protected endpoint must have a policy entry.",
        "Add a registerPolicy() call or ACTOR_ENDPOINTS entry in route-policy.ts.",
        "If truly unprotected, add to UNPROTECTED_ENDPOINTS in this guard test.",
      ].join("\n");
      expect(missingPolicies, message).toEqual([]);
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
