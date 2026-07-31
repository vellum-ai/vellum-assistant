/**
 * Trust-rules view-model types, derived from the generated gateway SDK
 * types so they cannot drift from the wire (see docs/CONVENTIONS.md
 * "Generated types are the source of truth"). The schemas originate in
 * `gateway/src/http/routes/trust-rules-routes.ts`.
 */

import type {
  AssistantTrustRuleCreateData,
  AssistantTrustRuleSuggestData,
  AssistantTrustRuleSuggestResponses,
  AssistantTrustRuleUpdateData,
  AssistantTrustRulesListResponses,
} from "@/generated/gateway/types.gen";

export type TrustRulesListResponse = AssistantTrustRulesListResponses[200];
export type TrustRuleItem = TrustRulesListResponse["rules"][number];
export type TrustRuleRisk = TrustRuleItem["risk"];
export type TrustRuleOrigin = TrustRuleItem["origin"];

export type AddTrustRuleBody = AssistantTrustRuleCreateData["body"];
export type UpdateTrustRuleBody = AssistantTrustRuleUpdateData["body"];
export type SuggestTrustRuleBody = AssistantTrustRuleSuggestData["body"];
export type TrustRuleSuggestion =
  AssistantTrustRuleSuggestResponses[200]["suggestion"];
