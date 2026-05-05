/**
 * Lint test: every daemon route whose HTTP-side policy is gateway-only
 * MUST have a matching IPC policy entry.
 *
 * Background: the gateway's IPC proxy default-allows operationIds that
 * have no policy entry. Routes restricted to the `svc_gateway` principal
 * on the daemon HTTP path must also be locked down on IPC — otherwise an
 * authenticated edge JWT can reach them by setting
 * `X-Vellum-Proxy-Server: ipc`, bypassing the daemon HTTP router entirely.
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

// ---------------------------------------------------------------------------
// Step 2 — Extract gateway-only endpoints from daemon's route-policy.ts.
// ---------------------------------------------------------------------------

/**
 * Parse the daemon's route-policy.ts source to find every endpoint
 * registered with `allowedPrincipalTypes: ["svc_gateway"]`.
 *
 * Two patterns are supported:
 *   1. Direct: `registerPolicy("endpoint", { ... ["svc_gateway"] ... })`
 *   2. Loop:   `const X_ENDPOINTS = ["a", "b", ...]; for (const e of X_ENDPOINTS) { registerPolicy(e, { ... ["svc_gateway"] ... }) }`
 *
 * Pattern 2 is detected heuristically: when a `const ARRAY = [...]` is
 * followed by a `for...of ARRAY` containing `registerPolicy(...)` and
 * `["svc_gateway"]`, every string in the array is treated as gateway-only.
 */
function extractGatewayOnlyEndpoints(): Set<string> {
  const text = readFileSync(ROUTE_POLICY_FILE, "utf-8");
  const out = new Set<string>();

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
      /allowedPrincipalTypes:\s*\[\s*["']svc_gateway["']\s*\]/.test(block)
    ) {
      out.add(endpoint);
    }
  }

  // Pattern 2: const ARRAY = [...] followed by a for-of loop that
  // registers svc_gateway-only policies for each element. Detected
  // heuristically: when a `const ARRAY = [...]` is followed somewhere
  // in the file by a for-of loop over that array containing both a
  // `registerPolicy(` and a literal `["svc_gateway"]`, every string in
  // the array is treated as gateway-only.
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
    // Extract every string literal from the array body.
    for (const lit of arrayBody.matchAll(/["']([^"']+)["']/g)) {
      out.add(lit[1]!);
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

  // Build the gateway-only operationId set by intersecting routes ∩ policy.
  const gatewayOnlyRoutes = routePairs.filter((r) =>
    gatewayOnlyEndpoints.has(r.endpoint),
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
          `["${route.operationId}", ["internal.write"], ["svc_gateway"]] ` +
          `(or use the appropriate scope from the daemon's route-policy.ts).`,
      ).toBeDefined();
      expect(policy!.allowedPrincipalTypes).toEqual(["svc_gateway"]);
    });
  }
});
