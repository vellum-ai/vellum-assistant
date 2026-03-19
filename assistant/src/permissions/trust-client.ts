/**
 * HTTP client for the gateway's trust rule endpoints.
 *
 * Provides CRUD operations over trust rules stored in the gateway,
 * replacing direct filesystem access to trust.json when the assistant
 * runs in a containerized environment.
 */

import type { TrustRule } from "@vellumai/ces-contracts";

import { getGatewayInternalBaseUrl } from "../config/env.js";
import { mintDaemonDeliveryToken } from "../runtime/auth/token-service.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("trust-client");

const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Result types (not in ces-contracts — local to the client)
// ---------------------------------------------------------------------------

export interface AcceptStarterBundleResult {
  accepted: boolean;
  rulesAdded: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the gateway base URL for trust rule requests.
 *
 * Prefers the `GATEWAY_INTERNAL_URL` env var (set in Docker environments
 * where the gateway runs in a separate container), falling back to the
 * existing `getGatewayInternalBaseUrl()` helper for local deployments.
 */
function getBaseUrl(): string {
  return process.env.GATEWAY_INTERNAL_URL ?? getGatewayInternalBaseUrl();
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${mintDaemonDeliveryToken()}`,
    "Content-Type": "application/json",
  };
}

/**
 * Execute a fetch request with standard timeout and error handling.
 * Throws a descriptive error on non-OK responses or network failures.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const options: RequestInit = {
    method,
    headers: authHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    log.error({ err, method, path }, "Trust rule request failed (network)");
    throw new Error(
      `Trust rule request failed: ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    log.error(
      { status: response.status, body: text, method, path },
      "Trust rule request failed",
    );
    throw new Error(
      `Trust rule request failed (${response.status}): ${method} ${path}: ${text}`,
    );
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway. */
export async function getAllRules(): Promise<TrustRule[]> {
  const data = await request<{ rules: TrustRule[] }>("GET", "/v1/trust-rules");
  return data.rules;
}

/** Create a new trust rule. */
export async function addRule(params: {
  tool: string;
  pattern: string;
  scope: string;
  decision?: TrustRule["decision"];
  priority?: number;
  allowHighRisk?: boolean;
  executionTarget?: string;
}): Promise<TrustRule> {
  const data = await request<{ rule: TrustRule }>(
    "POST",
    "/v1/trust-rules",
    params,
  );
  return data.rule;
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
    allowHighRisk?: boolean;
    executionTarget?: string;
  },
): Promise<TrustRule> {
  const data = await request<{ rule: TrustRule }>(
    "PATCH",
    `/v1/trust-rules/${encodeURIComponent(id)}`,
    updates,
  );
  return data.rule;
}

/** Remove a trust rule by ID. Returns true if the rule was found and deleted. */
export async function removeRule(id: string): Promise<boolean> {
  const data = await request<{ success: boolean }>(
    "DELETE",
    `/v1/trust-rules/${encodeURIComponent(id)}`,
  );
  return data.success;
}

/** Clear all user trust rules (default rules are preserved by the gateway). */
export async function clearRules(): Promise<void> {
  await request<{ success: boolean }>("POST", "/v1/trust-rules/clear");
}

/**
 * Find the highest-priority matching rule for a tool invocation.
 *
 * @param tool      Tool name (e.g. "host_bash")
 * @param candidates  Command candidates to match against rule patterns
 * @param scope     Working directory scope
 */
export async function findMatchingRule(
  tool: string,
  candidates: string[],
  scope: string,
): Promise<TrustRule | null> {
  const params = new URLSearchParams({
    tool,
    candidates: candidates.join(","),
    scope,
  });
  const data = await request<{ rule: TrustRule | null }>(
    "GET",
    `/v1/trust-rules/match?${params.toString()}`,
  );
  return data.rule;
}

/** Accept the starter approval bundle, seeding common low-risk allow rules. */
export async function acceptStarterBundle(): Promise<AcceptStarterBundleResult> {
  return request<AcceptStarterBundleResult>(
    "POST",
    "/v1/trust-rules/starter-bundle",
  );
}
