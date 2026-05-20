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
  scope?: string;
}

export interface UpdateTrustRuleBody {
  risk?: TrustRuleRisk;
  description?: string;
}
