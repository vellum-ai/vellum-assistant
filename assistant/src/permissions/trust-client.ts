/**
 * Assistant-side trust rule client.
 *
 * Delegates transport logic to `@vellumai/gateway-client/http-trust-rules`
 * (`TrustRulesClient` class) while preserving the free-function API that
 * existing call sites (trust-store.ts) expect.
 *
 * Auth context (token minting, gateway base URL) is injected from the
 * assistant's own config/auth modules so the package stays transport-focused.
 */

import {
  type AcceptStarterBundleResult,
  TrustRulesClient,
} from "@vellumai/gateway-client/http-trust-rules";
import type { TrustRule } from "@vellumai/service-contracts/trust-rules";

import { getGatewayInternalBaseUrl } from "../config/env.js";
import { mintEdgeRelayToken } from "../runtime/auth/token-service.js";
import { getLogger } from "../util/logger.js";

// Re-export the result type so existing import sites are unchanged.
export type { AcceptStarterBundleResult };

const log = getLogger("trust-client");

/**
 * Lazily-created singleton client instance. Constructed on first use so
 * env resolution and token minting hooks are available.
 */
let _client: TrustRulesClient | undefined;

function getClient(): TrustRulesClient {
  if (!_client) {
    _client = new TrustRulesClient({
      gatewayBaseUrl: getGatewayInternalBaseUrl(),
      mintToken: mintEdgeRelayToken,
      log,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Public API — preserves existing free-function signatures
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway. */
export async function getAllRules(): Promise<TrustRule[]> {
  return getClient().getAllRules();
}

/** Create a new trust rule. */
export async function addRule(params: {
  tool: string;
  pattern: string;
  scope?: string;
  decision?: TrustRule["decision"];
  priority?: number;
  executionTarget?: string;
}): Promise<TrustRule> {
  return getClient().addRule(params);
}

/** Update an existing trust rule by ID. */
export async function updateRule(
  id: string,
  updates: {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: TrustRule["decision"];
    priority?: number;
    executionTarget?: string;
  },
): Promise<TrustRule> {
  return getClient().updateRule(id, updates);
}

/** Remove a trust rule by ID. Returns true if the rule was found and deleted. */
export async function removeRule(id: string): Promise<boolean> {
  return getClient().removeRule(id);
}

/**
 * Find the highest-priority matching rule for a tool invocation.
 *
 * @param tool          Tool name (e.g. "host_bash")
 * @param candidates    Command candidates to match against rule patterns
 * @param scope         Working directory scope
 * @param resolvedPaths Optional resolved path args — when present and
 *                      non-empty, the rule's scope must cover ALL of them
 *                      (AND semantics).
 */
export async function findMatchingRule(
  tool: string,
  candidates: string[],
  scope: string,
  resolvedPaths?: readonly string[],
): Promise<TrustRule | null> {
  return getClient().findMatchingRule(tool, candidates, scope, resolvedPaths);
}

/** Accept the starter approval bundle, seeding common low-risk allow rules. */
export async function acceptStarterBundle(): Promise<AcceptStarterBundleResult> {
  return getClient().acceptStarterBundle();
}

// ---------------------------------------------------------------------------
// Synchronous API — used by the gateway trust store adapter
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway (synchronous). */
export function getAllRulesSync(): TrustRule[] {
  return getClient().getAllRulesSync();
}

/** Create a new trust rule (synchronous). */
export function addRuleSync(params: {
  tool: string;
  pattern: string;
  scope?: string;
  decision?: TrustRule["decision"];
  priority?: number;
  executionTarget?: string;
}): TrustRule {
  return getClient().addRuleSync(params);
}

/** Update an existing trust rule by ID (synchronous). */
export function updateRuleSync(
  id: string,
  updates: {
    tool?: string;
    pattern?: string;
    scope?: string;
    decision?: TrustRule["decision"];
    priority?: number;
    executionTarget?: string;
  },
): TrustRule {
  return getClient().updateRuleSync(id, updates);
}

/** Remove a trust rule by ID (synchronous). Returns true if deleted. */
export function removeRuleSync(id: string): boolean {
  return getClient().removeRuleSync(id);
}

/** Clear all user trust rules (synchronous). */
export function clearRulesSync(): void {
  getClient().clearRulesSync();
}

/** Accept the starter approval bundle (synchronous). */
export function acceptStarterBundleSync(): AcceptStarterBundleResult {
  return getClient().acceptStarterBundleSync();
}
