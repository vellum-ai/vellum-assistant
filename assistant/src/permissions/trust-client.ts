/**
 * HTTP client for the gateway's trust rule endpoints.
 *
 * Provides CRUD operations over trust rules stored in the gateway,
 * replacing direct filesystem access to trust.json when the assistant
 * runs in a containerized environment.
 *
 * Both async and synchronous variants are exported. The sync variants
 * use `Bun.spawnSync` + `curl` to make blocking HTTP calls — acceptable
 * for user-initiated write operations that are infrequent.
 *
 * All rule-returning endpoints parse response payloads through the shared
 * `parseTrustRule` canonical parser so the client never returns unparsed
 * or untyped raw rule objects.
 */

import type { TrustRule } from "@vellumai/ces-contracts";
import { parseTrustRule } from "@vellumai/ces-contracts";

import { getGatewayInternalBaseUrl } from "../config/env.js";
import { mintEdgeRelayToken } from "../runtime/auth/token-service.js";
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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${mintEdgeRelayToken()}`,
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
  const url = `${getGatewayInternalBaseUrl()}${path}`;
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

/**
 * Synchronous HTTP request via `Bun.spawnSync` + `curl`.
 *
 * Used by the gateway trust store adapter for write operations that must
 * return synchronously to satisfy the `TrustStoreBackend` interface.
 * Write operations are user-initiated and infrequent, so blocking is acceptable.
 */
function requestSync<T>(method: string, path: string, body?: unknown): T {
  const url = `${getGatewayInternalBaseUrl()}${path}`;
  const headers = authHeaders();
  const args: string[] = [
    "curl",
    "-s",
    "-S",
    "-X",
    method,
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "-H",
    `Authorization: ${headers.Authorization}`,
    "-H",
    "Content-Type: application/json",
    "-w",
    "\n%{http_code}",
  ];
  if (body !== undefined) {
    args.push("-d", JSON.stringify(body));
  }
  args.push(url);

  const proc = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    log.error(
      { exitCode: proc.exitCode, stderr, method, path },
      "Trust rule sync request failed (curl)",
    );
    throw new Error(
      `Trust rule sync request failed: ${method} ${path}: curl exit ${proc.exitCode}: ${stderr}`,
    );
  }

  const output = proc.stdout.toString().trim();
  // curl -w "\n%{http_code}" appends the HTTP status code on the last line
  const lastNewline = output.lastIndexOf("\n");
  const responseBody = lastNewline >= 0 ? output.slice(0, lastNewline) : "";
  const statusCode = parseInt(
    lastNewline >= 0 ? output.slice(lastNewline + 1) : output,
    10,
  );

  if (statusCode < 200 || statusCode >= 300) {
    log.error(
      { status: statusCode, body: responseBody, method, path },
      "Trust rule sync request failed",
    );
    throw new Error(
      `Trust rule sync request failed (${statusCode}): ${method} ${path}: ${responseBody}`,
    );
  }

  if (!responseBody) {
    return {} as T;
  }

  try {
    return JSON.parse(responseBody) as T;
  } catch (err) {
    log.error(
      { err, responseBody, method, path },
      "Failed to parse sync response JSON",
    );
    throw new Error(
      `Trust rule sync request: failed to parse response: ${method} ${path}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw rule object from a gateway response through the shared
 * canonical parser. Ensures the trust client never returns unparsed or
 * untyped rule objects, regardless of what the gateway sends back.
 */
function parseRuleResponse(raw: unknown): TrustRule {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trust rule response is not a valid object");
  }
  const { rule } = parseTrustRule(raw as Record<string, unknown>);
  return rule as TrustRule;
}

/**
 * Parse an array of raw rule objects from a gateway response.
 */
function parseRulesResponse(raw: unknown[]): TrustRule[] {
  return raw.map((r) => parseRuleResponse(r));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway. */
export async function getAllRules(): Promise<TrustRule[]> {
  const data = await request<{ rules: unknown[] }>("GET", "/v1/trust-rules");
  return parseRulesResponse(data.rules);
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
  // Only include scope in the request body if provided.
  const { scope, ...rest } = params;
  const body = scope != null ? { ...rest, scope } : rest;
  const data = await request<{ rule: unknown }>(
    "POST",
    "/v1/trust-rules",
    body,
  );
  return parseRuleResponse(data.rule);
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
  const data = await request<{ rule: unknown }>(
    "PATCH",
    `/v1/trust-rules/${encodeURIComponent(id)}`,
    updates,
  );
  return parseRuleResponse(data.rule);
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
    commands: candidates.join(","),
    scope,
  });
  const data = await request<{ rule: unknown | null }>(
    "GET",
    `/v1/trust-rules/match?${params.toString()}`,
  );
  return data.rule != null ? parseRuleResponse(data.rule) : null;
}

/** Accept the starter approval bundle, seeding common low-risk allow rules. */
export async function acceptStarterBundle(): Promise<AcceptStarterBundleResult> {
  return request<AcceptStarterBundleResult>(
    "POST",
    "/v1/trust-rules/starter-bundle",
  );
}

// ---------------------------------------------------------------------------
// Synchronous API — used by the gateway trust store adapter
// ---------------------------------------------------------------------------

/** Fetch all trust rules from the gateway (synchronous). */
export function getAllRulesSync(): TrustRule[] {
  const data = requestSync<{ rules: unknown[] }>("GET", "/v1/trust-rules");
  return parseRulesResponse(data.rules);
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
  // Only include scope in the request body if provided.
  const { scope, ...rest } = params;
  const body = scope != null ? { ...rest, scope } : rest;
  const data = requestSync<{ rule: unknown }>("POST", "/v1/trust-rules", body);
  return parseRuleResponse(data.rule);
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
  const data = requestSync<{ rule: unknown }>(
    "PATCH",
    `/v1/trust-rules/${encodeURIComponent(id)}`,
    updates,
  );
  return parseRuleResponse(data.rule);
}

/** Remove a trust rule by ID (synchronous). Returns true if deleted. */
export function removeRuleSync(id: string): boolean {
  const data = requestSync<{ success: boolean }>(
    "DELETE",
    `/v1/trust-rules/${encodeURIComponent(id)}`,
  );
  return data.success;
}

/** Clear all user trust rules (synchronous). */
export function clearRulesSync(): void {
  requestSync<{ success: boolean }>("POST", "/v1/trust-rules/clear");
}

/** Accept the starter approval bundle (synchronous). */
export function acceptStarterBundleSync(): AcceptStarterBundleResult {
  return requestSync<AcceptStarterBundleResult>(
    "POST",
    "/v1/trust-rules/starter-bundle",
  );
}
