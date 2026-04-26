/**
 * Assistant-side trust rule client.
 *
 * All methods use IPC over the gateway socket (no HTTP auth needed).
 */

import type { TrustRule } from "@vellumai/service-contracts/trust-rules";
import { parseTrustRule } from "@vellumai/service-contracts/trust-rules";

import { ipcCall } from "../ipc/gateway-client.js";
import type { AcceptStarterBundleResult } from "./trust-store-interface.js";

// Re-export the result type so existing import sites are unchanged.
export type { AcceptStarterBundleResult };

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

/** Clear all user trust rules via IPC. */
export async function clearRules(): Promise<void> {
  const result = (await ipcCall("clear_trust_rules")) as {
    success: boolean;
  } | null;
  if (!result || !result.success) {
    throw new Error("Trust rule IPC call failed: clear_trust_rules");
  }
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
