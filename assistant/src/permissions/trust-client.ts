/**
 * Assistant-side trust rule client.
 *
 * Async methods use IPC over the gateway socket (no HTTP auth needed).
 * Sync methods still delegate to the HTTP-based `TrustRulesClient` from
 * `@vellumai/gateway-client/http-trust-rules` — these will be converted
 * to async IPC in a follow-up once the trust-store is made async.
 *
 * Auth context (token minting, gateway base URL) for the sync path is
 * injected from the assistant's own config/auth modules.
 */

import {
  type AcceptStarterBundleResult,
  TrustRulesClient,
} from "@vellumai/gateway-client/http-trust-rules";
import type { TrustRule } from "@vellumai/service-contracts/trust-rules";
import { parseTrustRule } from "@vellumai/service-contracts/trust-rules";

import { getGatewayInternalBaseUrl } from "../config/env.js";
import { ipcCall } from "../ipc/gateway-client.js";
import { mintEdgeRelayToken } from "../runtime/auth/token-service.js";
import { getLogger } from "../util/logger.js";

// Re-export the result type so existing import sites are unchanged.
export type { AcceptStarterBundleResult };

const log = getLogger("trust-client");

// ---------------------------------------------------------------------------
// IPC response parsing
// ---------------------------------------------------------------------------

function parseRuleResponse(raw: unknown): TrustRule {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trust rule response is not a valid object");
  }
  const { rule } = parseTrustRule(raw as Record<string, unknown>);
  return rule as TrustRule;
}

function parseRulesResponse(raw: unknown[]): TrustRule[] {
  return raw.map((r) => parseRuleResponse(r));
}

// ---------------------------------------------------------------------------
// Public async API — IPC over gateway socket
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway via IPC. */
export async function getAllRules(): Promise<TrustRule[]> {
  const result = (await ipcCall("list_trust_rules")) as {
    rules: unknown[];
  } | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: list_trust_rules");
  }
  return parseRulesResponse(result.rules);
}

/** Create a new trust rule via IPC. */
export async function addRule(params: {
  tool: string;
  pattern: string;
  scope?: string;
  decision?: TrustRule["decision"];
  priority?: number;
  executionTarget?: string;
}): Promise<TrustRule> {
  const result = (await ipcCall("add_trust_rule", {
    tool: params.tool,
    pattern: params.pattern,
    ...(params.scope != null && { scope: params.scope }),
    ...(params.decision != null && { decision: params.decision }),
    ...(params.priority != null && { priority: params.priority }),
    ...(params.executionTarget != null && {
      executionTarget: params.executionTarget,
    }),
  })) as { rule: unknown } | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: add_trust_rule");
  }
  return parseRuleResponse(result.rule);
}

/** Update an existing trust rule by ID via IPC. */
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
  const result = (await ipcCall("update_trust_rule", {
    id,
    ...updates,
  })) as { rule: unknown } | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: update_trust_rule");
  }
  return parseRuleResponse(result.rule);
}

/** Remove a trust rule by ID via IPC. Returns true if deleted. */
export async function removeRule(id: string): Promise<boolean> {
  const result = (await ipcCall("remove_trust_rule", { id })) as {
    success: boolean;
  } | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: remove_trust_rule");
  }
  return result.success;
}

/**
 * Find the highest-priority matching rule for a tool invocation via IPC.
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
  const result = (await ipcCall("match_trust_rule", {
    tool,
    commands: candidates,
    scope,
    ...(resolvedPaths &&
      resolvedPaths.length > 0 && {
        resolvedPaths: [...resolvedPaths],
      }),
  })) as { rule: unknown | null } | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: match_trust_rule");
  }
  return result.rule != null ? parseRuleResponse(result.rule) : null;
}

/** Accept the starter approval bundle via IPC. */
export async function acceptStarterBundle(): Promise<AcceptStarterBundleResult> {
  const result = (await ipcCall(
    "accept_starter_bundle",
  )) as AcceptStarterBundleResult | null;
  if (!result) {
    throw new Error("Trust rule IPC call failed: accept_starter_bundle");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Synchronous API — HTTP-based, used by GatewayTrustStoreAdapter
//
// These still go through the HTTP TrustRulesClient because the trust-store
// backend interface is synchronous. Phase 2 will make the interface async,
// then Phase 3 will delete these sync methods entirely.
// ---------------------------------------------------------------------------

/**
 * Lazily-created singleton HTTP client for sync methods only.
 */
let _httpClient: TrustRulesClient | undefined;

function getHttpClient(): TrustRulesClient {
  if (!_httpClient) {
    _httpClient = new TrustRulesClient({
      gatewayBaseUrl: getGatewayInternalBaseUrl(),
      mintToken: mintEdgeRelayToken,
      log,
    });
  }
  return _httpClient;
}

/** Fetch all trust rules from the gateway (synchronous). */
export function getAllRulesSync(): TrustRule[] {
  return getHttpClient().getAllRulesSync();
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
  return getHttpClient().addRuleSync(params);
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
  return getHttpClient().updateRuleSync(id, updates);
}

/** Remove a trust rule by ID (synchronous). Returns true if deleted. */
export function removeRuleSync(id: string): boolean {
  return getHttpClient().removeRuleSync(id);
}

/** Clear all user trust rules (synchronous). */
export function clearRulesSync(): void {
  getHttpClient().clearRulesSync();
}

/** Accept the starter approval bundle (synchronous). */
export function acceptStarterBundleSync(): AcceptStarterBundleResult {
  return getHttpClient().acceptStarterBundleSync();
}
