export type TrustRuleRisk = "low" | "medium" | "high";
export type TrustRuleOrigin = "default" | "user_defined";

export interface TrustRuleItem {
  id: string;
  tool: string;
  pattern: string;
  risk: TrustRuleRisk;
  description: string;
  origin: TrustRuleOrigin;
  userModified: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TrustRulesListResponse {
  rules: TrustRuleItem[];
}

export interface AddTrustRuleBody {
  tool: string;
  pattern: string;
  risk: TrustRuleRisk;
  description: string;
  /** Directory scope for this rule (e.g. a specific path, or "everywhere"). */
  scope?: string;
}

export interface UpdateTrustRuleBody {
  risk?: TrustRuleRisk;
  description?: string;
}

export interface SuggestTrustRuleBody {
  tool: string;
  command: string;
  riskAssessment: {
    risk: string;
    reasoning: string;
    reasonDescription: string;
  };
  scopeOptions: { pattern: string; label: string }[];
  directoryScopeOptions?: { scope: string; label: string }[];
  intent: "auto_approve" | "escalate";
  existingRule?: {
    id: string;
    pattern: string;
    risk: string;
  };
}

export interface TrustRuleSuggestion {
  pattern: string;
  risk: string;
  scope: string | null;
  description: string;
  scopeOptions: { pattern: string; label: string }[];
  directoryScopeOptions?: { scope: string; label: string }[] | null;
}
