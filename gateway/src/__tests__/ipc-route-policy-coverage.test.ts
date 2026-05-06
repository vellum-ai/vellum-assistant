/**
 * Lint test: every daemon route whose HTTP-side policy is gateway-only
 * MUST have a matching IPC policy entry, with matching required scopes.
 *
 * Background: the gateway's IPC proxy default-allows operationIds that
 * have no policy entry. Routes restricted to the `svc_gateway` principal
 * on the daemon HTTP path must also be locked down on IPC — otherwise an
 * authenticated edge JWT can reach them by setting
 * `X-Vellum-Proxy-Server: ipc`, bypassing the daemon HTTP router entirely.
 *
 * Symmetrically, the IPC entry's `requiredScopes` must match the daemon's
 * `requiredScopes`. If IPC permits a broader scope than the daemon HTTP
 * path requires, the IPC path is more permissive than the HTTP path —
 * the same scope-bypass class this guard is designed to prevent.
 *
 * This bug class has bitten us multiple times:
 *   - PR #29571 (MCP OAuth routes — Codex finding)
 *   - PR #29612 (OAuth connect routes — Codex finding)
 *
 * Rather than rely on Codex catching it a third time, this test walks
 * the daemon route source files and the daemon route-policy source file
 * at test time and asserts every gateway-only operationId is registered
 * in the IPC policy table with matching scopes and principals.
 *
 * Implementation notes:
 *   - Uses text parsing rather than direct imports because the gateway
 *     and assistant packages don't share source-level imports (they
 *     communicate through the `@vellumai/service-contracts` package).
 *   - Regexes are intentionally loose. False positives (matching too
 *     much) only result in extra coverage; false negatives (missing
 *     real gateway-only routes) defeat the lint.
 *   - Daemon route endpoints may include parameter segments
 *     (e.g. `internal/oauth/connect/status/:state`) while the
 *     daemon's route-policy keys drop those segments
 *     (e.g. `internal/oauth/connect/status`). We normalize by
 *     stripping `/:param` segments before matching so parameterized
 *     gateway-only routes are not silently excluded.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getIpcRoutePolicy } from "../auth/ipc-route-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// gateway/src/__tests__ → repo root → assistant/...
const ASSISTANT_SRC = join(
  __dirname,
  "..",
  "..",
  "..",
  "assistant",
  "src",
);
const ROUTES_DIR = join(ASSISTANT_SRC, "runtime", "routes");
const ROUTE_POLICY_FILE = join(
  ASSISTANT_SRC,
  "runtime",
  "auth",
  "route-policy.ts",
);

// ---------------------------------------------------------------------------
// Step 1 — Collect every (operationId, endpoint) pair from daemon routes.
// ---------------------------------------------------------------------------

interface RoutePair {
  operationId: string;
  endpoint: string;
  sourceFile: string;
}

function collectRouteSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...collectRouteSourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * For each `operationId: "..."` literal, find the closest `endpoint: "..."`
 * literal within a 600-character window. The codebase's style writes both
 * fields near the top of each route definition, so 600 chars comfortably
 * covers the longest route block.
 */
function extractRoutePairs(source: string, sourceFile: string): RoutePair[] {
  const pairs: RoutePair[] = [];
  const opRegex = /operationId:\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(opRegex)) {
    const operationId = m[1]!;
    const start = m.index!;
    const end = Math.min(start + 600, source.length);
    const window = source.slice(start, end);
    const epMatch = window.match(/endpoint:\s*["']([^"']+)["']/);
    if (epMatch) {
      pairs.push({ operationId, endpoint: epMatch[1]!, sourceFile });
    }
  }
  return pairs;
}

function collectAllRoutePairs(): RoutePair[] {
  const out: RoutePair[] = [];
  for (const file of collectRouteSourceFiles(ROUTES_DIR)) {
    out.push(...extractRoutePairs(readFileSync(file, "utf-8"), file));
  }
  return out;
}

/**
 * Strip `/:param` segments so a route's `endpoint` matches the policy
 * key registered in route-policy.ts. The daemon's HTTP router uses the
 * non-parameterized form as the canonical policy key.
 *
 * Examples:
 *   "internal/oauth/connect/status/:state" → "internal/oauth/connect/status"
 *   "internal/mcp/auth/status/:serverId"   → "internal/mcp/auth/status"
 *   "profiler/runs/:runId"                 → "profiler/runs"
 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/:[^/]+/g, "");
}

// ---------------------------------------------------------------------------
// Step 2 — Extract gateway-only endpoints (with required scopes) from
// daemon's route-policy.ts.
// ---------------------------------------------------------------------------

/**
 * Parse the daemon's route-policy.ts source to find every endpoint
 * registered with `allowedPrincipalTypes: ["svc_gateway"]`. For each,
 * record the `requiredScopes` array so the IPC policy can be cross-checked
 * for scope parity (not just principal parity).
 *
 * Two patterns are supported:
 *   1. Direct: `registerPolicy("endpoint", { requiredScopes: [...], ["svc_gateway"] ... })`
 *   2. Loop:   `const X_ENDPOINTS = ["a", "b", ...]; for (const e of X_ENDPOINTS) { registerPolicy(e, { requiredScopes: [...], ["svc_gateway"] ... }) }`
 *
 * Pattern 2 is detected heuristically: when a `const ARRAY = [...]` is
 * followed by a `for...of ARRAY` containing `registerPolicy(...)` and
 * `["svc_gateway"]`, every string in the array is treated as gateway-only
 * and shares the loop body's `requiredScopes`.
 */
function extractScopes(block: string): string[] | null {
  const m = block.match(/requiredScopes:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const scopes: string[] = [];
  for (const lit of m[1]!.matchAll(/["']([^"']+)["']/g)) {
    scopes.push(lit[1]!);
  }
  return scopes;
}

interface GatewayOnlyEntry {
  requiredScopes: string[];
}

function extractGatewayOnlyEndpoints(): Map<string, GatewayOnlyEntry> {
  const text = readFileSync(ROUTE_POLICY_FILE, "utf-8");
  const out = new Map<string, GatewayOnlyEntry>();

  // Pattern 1: explicit registerPolicy calls.
  //
  // Split the file into individual `registerPolicy(...)` blocks first
  // (using a non-greedy match up to the next `});`) so the multi-line
  // [\s\S]*? alternation can't accidentally span multiple registrations
  // and pick up a "svc_gateway"-only array from a different policy.
  const blockRegex =
    /registerPolicy\(\s*["']([^"']+)["']\s*,\s*\{[\s\S]*?\}\s*\)\s*;/g;
  for (const m of text.matchAll(blockRegex)) {
    const endpoint = m[1]!;
    const block = m[0]!;
    // Within this single registerPolicy block, require allowedPrincipalTypes
    // to be EXACTLY ["svc_gateway"] — no other principals.
    if (
      !/allowedPrincipalTypes:\s*\[\s*["']svc_gateway["']\s*\]/.test(block)
    )
      continue;
    const scopes = extractScopes(block);
    if (!scopes) continue;
    out.set(endpoint, { requiredScopes: scopes });
  }

  // Pattern 2: const ARRAY = [...] followed by a for-of loop that
  // registers svc_gateway-only policies for each element. Detected
  // heuristically: when a `const ARRAY = [...]` is followed somewhere
  // in the file by a for-of loop over that array containing both a
  // `registerPolicy(` and a literal `["svc_gateway"]`, every string in
  // the array is treated as gateway-only and shares the loop body's
  // `requiredScopes`.
  const arrayDeclRegex =
    /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\[([\s\S]*?)\]\s*;/g;
  for (const m of text.matchAll(arrayDeclRegex)) {
    const arrayName = m[1]!;
    const arrayBody = m[2]!;
    // Find a for-of loop over this array. Use a non-greedy body match
    // that stops at the closing `}` of the for-block.
    const loopBlockRegex = new RegExp(
      String.raw`for\s*\(\s*const\s+\w+\s+of\s+` +
        arrayName +
        String.raw`\s*\)\s*\{[\s\S]*?\}`,
    );
    const loopMatch = text.match(loopBlockRegex);
    if (!loopMatch) continue;
    const loopBody = loopMatch[0];
    if (!loopBody.includes("registerPolicy")) continue;
    if (!/\[\s*["']svc_gateway["']\s*\]/.test(loopBody)) continue;
    const scopes = extractScopes(loopBody);
    if (!scopes) continue;
    // Extract every string literal from the array body.
    for (const lit of arrayBody.matchAll(/["']([^"']+)["']/g)) {
      out.set(lit[1]!, { requiredScopes: scopes });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Step 3 — Cross-reference and assert.
// ---------------------------------------------------------------------------

describe("ipc-route-policy: gateway-only coverage lint", () => {
  const gatewayOnlyEndpoints = extractGatewayOnlyEndpoints();
  const routePairs = collectAllRoutePairs();

  // Build the gateway-only operationId set by intersecting
  // (normalized routes) ∩ (policy keys). Preserve the daemon's
  // requiredScopes so the IPC policy can be checked for scope parity.
  const gatewayOnlyRoutes = routePairs
    .map((r) => {
      const normalized = normalizeEndpoint(r.endpoint);
      const entry = gatewayOnlyEndpoints.get(normalized);
      if (!entry) return null;
      return { ...r, normalizedEndpoint: normalized, daemonScopes: entry.requiredScopes };
    })
    .filter(
      (r): r is RoutePair & { normalizedEndpoint: string; daemonScopes: string[] } =>
        r !== null,
    );

  test("discovery sanity: found gateway-only daemon routes", () => {
    // If the discovery returns zero, we'd silently pass every check
    // below. Fail loud instead.
    expect(gatewayOnlyEndpoints.size).toBeGreaterThan(0);
    expect(gatewayOnlyRoutes.length).toBeGreaterThan(0);
  });

  // One test case per gateway-only route so the failure message points
  // directly at the specific operationId that's missing coverage.
  for (const route of gatewayOnlyRoutes) {
    const relPath = route.sourceFile.split("/assistant/src/")[1] ?? route.sourceFile;
    test(`${route.operationId} (endpoint=${route.endpoint}) has an IPC policy entry`, () => {
      const policy = getIpcRoutePolicy(route.operationId);
      expect(
        policy,
        `${route.operationId} is registered as a gateway-only daemon ` +
          `route (endpoint=${route.endpoint}, defined in assistant/src/${relPath}) ` +
          `but is missing from gateway/src/auth/ipc-route-policy.ts. ` +
          `Add an entry: ` +
          `["${route.operationId}", ${JSON.stringify(route.daemonScopes)}, ["svc_gateway"]] ` +
          `to match the daemon HTTP policy.`,
      ).toBeDefined();
      expect(policy!.allowedPrincipalTypes).toEqual(["svc_gateway"]);
      // Scope parity: IPC requiredScopes must match daemon requiredScopes
      // exactly (as a set). Otherwise the IPC path could be reached with
      // a broader/different scope than the daemon HTTP path requires,
      // recreating the scope-bypass class this lint exists to prevent.
      // Compare as plain string[] — Scope is a string union, but the daemon
      // scopes come from text-parsed source so they're already string[].
      const ipcScopes: string[] = [...policy!.requiredScopes].sort();
      const daemonScopes: string[] = [...route.daemonScopes].sort();
      expect(
        ipcScopes,
        `${route.operationId} has IPC requiredScopes=${JSON.stringify(ipcScopes)} ` +
          `but daemon HTTP requires ${JSON.stringify(daemonScopes)}. ` +
          `Scope mismatch makes the IPC path more permissive than the HTTP ` +
          `path, recreating the scope-bypass class this lint prevents. ` +
          `Update the entry in gateway/src/auth/ipc-route-policy.ts to use ` +
          `${JSON.stringify(daemonScopes)}.`,
      ).toEqual(daemonScopes);
    });
  }
});
