/**
 * Trust-rules API wrappers over the generated gateway SDK.
 *
 * The endpoints are gateway-native (`/v1/assistants/{id}/trust-rules/*`);
 * their schemas live on the gateway's route metadata
 * (`gateway/src/http/routes/trust-rules-routes.ts`), so the types here are
 * codegen-derived. The gateway client's interceptor routes to the
 * self-hosted gateway in local mode and through the platform proxy for
 * platform-hosted assistants.
 */
import {
  assistantTrustRuleCreate,
  assistantTrustRuleDelete,
  assistantTrustRuleSuggest,
  assistantTrustRulesList,
  assistantTrustRuleUpdate,
} from "@/generated/gateway/sdk.gen";
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

export async function fetchTrustRules(
  assistantId: string,
  params: FetchTrustRulesParams = {},
): Promise<TrustRuleItem[]> {
  const { data, error, response } = await assistantTrustRulesList({
    path: { assistant_id: assistantId },
    query: {
      origin: params.origin,
      tool: params.tool,
      include_deleted: params.includeDeleted ? "true" : undefined,
      include_all: params.includeAll ? "true" : undefined,
    },
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
  const { error, response } = await assistantTrustRuleCreate({
    path: { assistant_id: assistantId },
    body,
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
  const { error, response } = await assistantTrustRuleUpdate({
    path: { assistant_id: assistantId, rule_id: ruleId },
    body,
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

export async function suggestTrustRule(
  assistantId: string,
  body: SuggestTrustRuleBody,
): Promise<TrustRuleSuggestion> {
  const { data, error, response } = await assistantTrustRuleSuggest({
    path: { assistant_id: assistantId },
    body,
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
  const { error, response } = await assistantTrustRuleDelete({
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
