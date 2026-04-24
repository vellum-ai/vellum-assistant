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

import type { Logger } from "./types.js";
import { noopLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 10_000;

/** Options for constructing a trust rules client. */
export interface TrustRulesClientOptions {
  /** Base URL of the gateway (e.g. "http://localhost:7820"). */
  gatewayBaseUrl: string;
  /** Returns a bearer token for authenticating with the gateway. */
  mintToken: () => string;
  /** Optional logger. */
  log?: Logger;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AcceptStarterBundleResult {
  accepted: boolean;
  rulesAdded: number;
}

// ---------------------------------------------------------------------------
// Client class
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client for gateway trust rule endpoints.
 *
 * Encapsulates the base URL, auth token minting, and response parsing
 * so consumers don't need to assemble URLs or parse raw responses.
 */
export class TrustRulesClient {
  private readonly gatewayBaseUrl: string;
  private readonly mintToken: () => string;
  private readonly log: Logger;

  constructor(options: TrustRulesClientOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl;
    this.mintToken = options.mintToken;
    this.log = options.log ?? noopLogger;
  }

  // -------------------------------------------------------------------------
  // Async API
  // -------------------------------------------------------------------------

  /** Fetch all trust rules from the gateway. */
  async getAllRules(): Promise<TrustRule[]> {
    const data = await this.request<{ rules: unknown[] }>(
      "GET",
      "/v1/trust-rules",
    );
    return parseRulesResponse(data.rules);
  }

  /** Create a new trust rule. */
  async addRule(params: {
    tool: string;
    pattern: string;
    scope?: string;
    decision?: TrustRule["decision"];
    priority?: number;
    executionTarget?: string;
  }): Promise<TrustRule> {
    const { scope, ...rest } = params;
    const body = scope != null ? { ...rest, scope } : rest;
    const data = await this.request<{ rule: unknown }>(
      "POST",
      "/v1/trust-rules",
      body,
    );
    return parseRuleResponse(data.rule);
  }

  /** Update an existing trust rule by ID. */
  async updateRule(
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
    const data = await this.request<{ rule: unknown }>(
      "PATCH",
      `/v1/trust-rules/${encodeURIComponent(id)}`,
      updates,
    );
    return parseRuleResponse(data.rule);
  }

  /** Remove a trust rule by ID. Returns true if deleted. */
  async removeRule(id: string): Promise<boolean> {
    const data = await this.request<{ success: boolean }>(
      "DELETE",
      `/v1/trust-rules/${encodeURIComponent(id)}`,
    );
    return data.success;
  }

  /** Clear all user trust rules (default rules are preserved by the gateway). */
  async clearRules(): Promise<void> {
    await this.request<{ success: boolean }>("POST", "/v1/trust-rules/clear");
  }

  /**
   * Find the highest-priority matching rule for a tool invocation.
   *
   * @param tool          Tool name (e.g. "host_bash")
   * @param candidates    Command candidates to match against rule patterns
   * @param scope         Working directory scope
   * @param resolvedPaths Optional resolved path args — when present and
   *                      non-empty, the rule's scope must cover ALL of them
   *                      (AND semantics). Forwarded to the gateway via the
   *                      `paths` query parameter.
   */
  async findMatchingRule(
    tool: string,
    candidates: string[],
    scope: string,
    resolvedPaths?: readonly string[],
  ): Promise<TrustRule | null> {
    const params = new URLSearchParams({
      tool,
      commands: candidates.join(","),
      scope,
    });
    if (resolvedPaths && resolvedPaths.length > 0) {
      params.set("paths", resolvedPaths.join(","));
    }
    const data = await this.request<{ rule: unknown | null }>(
      "GET",
      `/v1/trust-rules/match?${params.toString()}`,
    );
    return data.rule != null ? parseRuleResponse(data.rule) : null;
  }

  /** Accept the starter approval bundle, seeding common low-risk allow rules. */
  async acceptStarterBundle(): Promise<AcceptStarterBundleResult> {
    return this.request<AcceptStarterBundleResult>(
      "POST",
      "/v1/trust-rules/starter-bundle",
    );
  }

  // -------------------------------------------------------------------------
  // Synchronous API — used by the gateway trust store adapter
  // -------------------------------------------------------------------------

  /** Fetch all trust rules from the gateway (synchronous). */
  getAllRulesSync(): TrustRule[] {
    const data = this.requestSync<{ rules: unknown[] }>(
      "GET",
      "/v1/trust-rules",
    );
    return parseRulesResponse(data.rules);
  }

  /** Create a new trust rule (synchronous). */
  addRuleSync(params: {
    tool: string;
    pattern: string;
    scope?: string;
    decision?: TrustRule["decision"];
    priority?: number;
    executionTarget?: string;
  }): TrustRule {
    const { scope, ...rest } = params;
    const body = scope != null ? { ...rest, scope } : rest;
    const data = this.requestSync<{ rule: unknown }>(
      "POST",
      "/v1/trust-rules",
      body,
    );
    return parseRuleResponse(data.rule);
  }

  /** Update an existing trust rule by ID (synchronous). */
  updateRuleSync(
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
    const data = this.requestSync<{ rule: unknown }>(
      "PATCH",
      `/v1/trust-rules/${encodeURIComponent(id)}`,
      updates,
    );
    return parseRuleResponse(data.rule);
  }

  /** Remove a trust rule by ID (synchronous). Returns true if deleted. */
  removeRuleSync(id: string): boolean {
    const data = this.requestSync<{ success: boolean }>(
      "DELETE",
      `/v1/trust-rules/${encodeURIComponent(id)}`,
    );
    return data.success;
  }

  /** Clear all user trust rules (synchronous). */
  clearRulesSync(): void {
    this.requestSync<{ success: boolean }>("POST", "/v1/trust-rules/clear");
  }

  /** Accept the starter approval bundle (synchronous). */
  acceptStarterBundleSync(): AcceptStarterBundleResult {
    return this.requestSync<AcceptStarterBundleResult>(
      "POST",
      "/v1/trust-rules/starter-bundle",
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.mintToken()}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.gatewayBaseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      this.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          method,
          path,
        },
        "Trust rule request failed (network)",
      );
      throw new Error(
        `Trust rule request failed: ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      this.log.error(
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
   */
  private requestSync<T>(method: string, path: string, body?: unknown): T {
    const url = `${this.gatewayBaseUrl}${path}`;
    const headers = this.authHeaders();
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
      this.log.error(
        { exitCode: proc.exitCode, stderr, method, path },
        "Trust rule sync request failed (curl)",
      );
      throw new Error(
        `Trust rule sync request failed: ${method} ${path}: curl exit ${proc.exitCode}: ${stderr}`,
      );
    }

    const output = proc.stdout.toString().trim();
    const lastNewline = output.lastIndexOf("\n");
    const responseBody =
      lastNewline >= 0 ? output.slice(0, lastNewline) : "";
    const statusCode = parseInt(
      lastNewline >= 0 ? output.slice(lastNewline + 1) : output,
      10,
    );

    if (statusCode < 200 || statusCode >= 300) {
      this.log.error(
        { status: statusCode, body: responseBody, method, path },
        "Trust rule sync request failed",
      );
      throw new Error(
        `Trust rule sync request failed (${statusCode}): ${method} ${path}: ${responseBody}`,
      );
    }

    if (!responseBody) {
      throw new Error(
        `Trust rule sync request: empty response body: ${method} ${path}`,
      );
    }

    try {
      return JSON.parse(responseBody) as T;
    } catch (err) {
      this.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          responseBody,
          method,
          path,
        },
        "Failed to parse sync response JSON",
      );
      throw new Error(
        `Trust rule sync request: failed to parse response: ${method} ${path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Response parsing helpers
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
