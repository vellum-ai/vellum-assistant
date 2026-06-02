/**
 * Hand-written fetch wrappers for the assistant daemon's trust-rules endpoints.
 * These endpoints are served via the gateway sidecar under
 * /v1/assistants/{id}/trust-rules/* and are not part of the Django OpenAPI
 * schema.
 */
import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

import type {
  AddTrustRuleBody,
  SuggestTrustRuleBody,
  TrustRuleItem,
  TrustRuleOrigin,
  TrustRulesListResponse,
  TrustRuleSuggestion,
  UpdateTrustRuleBody,
} from "@/types/trust-rules";

export { ApiError };

export interface FetchTrustRulesParams {
  origin?: TrustRuleOrigin;
  tool?: string;
  includeDeleted?: boolean;
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

interface SuggestTrustRuleResponse {
  suggestion: TrustRuleSuggestion;
}

export async function suggestTrustRule(
  assistantId: string,
  body: SuggestTrustRuleBody,
): Promise<TrustRuleSuggestion> {
  const { data, error, response } = await client.post<
    SuggestTrustRuleResponse,
    unknown
  >({
    url: "/v1/assistants/{assistant_id}/trust-rules/suggest/",
    path: { assistant_id: assistantId },
    body,
    headers: { "Content-Type": "application/json" },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get trust rule suggestion.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to get trust rule suggestion."),
    );
  }
  if (!data?.suggestion) {
    throw new ApiError(500, "No suggestion in response.");
  }
  return data.suggestion;
}

export async function deleteTrustRule(
  assistantId: string,
  ruleId: string,
): Promise<void> {
  const { error, response } = await client.delete<unknown, unknown>({
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
