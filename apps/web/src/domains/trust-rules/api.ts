// Hand-written fetch wrappers intentionally — these endpoints are served by the
// gateway sidecar directly (routed via Django's _GATEWAY_ROUTED_PREFIXES under
// /v1/assistants/{id}/trust-rules/*) and are not part of the Django OpenAPI
// schema, so no generated HeyAPI hooks exist for them. Mirrors the pattern used
// by web/src/lib/memories/api.ts.
import { client } from "@/generated/api/client.gen.js";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/lib/api-errors.js";

import type {
  AddTrustRuleBody,
  TrustRuleItem,
  TrustRuleOrigin,
  TrustRulesListResponse,
  UpdateTrustRuleBody,
} from "@/domains/trust-rules/types.js";

export { ApiError };

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

export interface FetchTrustRulesParams {
  /**
   * When set to `"default"`, returns every default rule (including unmodified
   * ones); when omitted, the gateway returns only user-relevant rules
   * (user-defined plus modified defaults).
   */
  origin?: TrustRuleOrigin;
  /** Restrict results to a single tool. */
  tool?: string;
  /** Include soft-deleted rules. */
  includeDeleted?: boolean;
  /**
   * Force the gateway to return every rule regardless of origin/userModified
   * state. Mutually exclusive with `origin`.
   */
  includeAll?: boolean;
}

function buildFetchQuery(
  params: FetchTrustRulesParams,
): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.origin) query.origin = params.origin;
  if (params.tool) query.tool = params.tool;
  if (params.includeDeleted) query.include_deleted = "true";
  if (params.includeAll) query.include_all = "true";
  return query;
}

export async function fetchTrustRules(
  assistantId: string,
  params: FetchTrustRulesParams = {},
): Promise<TrustRuleItem[]> {
  const { data, error, response } = await client.get<
    TrustRulesListResponse,
    unknown
  >({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/trust-rules/",
    path: { assistant_id: assistantId },
    query: buildFetchQuery(params),
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load trust rules.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load trust rules."),
    );
  }
  return data?.rules ?? [];
}

export async function addTrustRule(
  assistantId: string,
  body: AddTrustRuleBody,
): Promise<void> {
  const { error, response } = await client.post<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/trust-rules/",
    path: { assistant_id: assistantId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to add trust rule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to add trust rule."),
    );
  }
}

export async function updateTrustRule(
  assistantId: string,
  ruleId: string,
  body: UpdateTrustRuleBody,
): Promise<void> {
  const { error, response } = await client.patch<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/trust-rules/{rule_id}/",
    path: { assistant_id: assistantId, rule_id: ruleId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to update trust rule.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to update trust rule."),
    );
  }
}

export async function deleteTrustRule(
  assistantId: string,
  ruleId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
    ...SDK_BASE_OPTIONS,
    url: "/v1/assistants/{assistant_id}/trust-rules/{rule_id}/",
    path: { assistant_id: assistantId, rule_id: ruleId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to delete trust rule.");
  if (!response.ok && response.status !== 204) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to delete trust rule."),
    );
  }
}
