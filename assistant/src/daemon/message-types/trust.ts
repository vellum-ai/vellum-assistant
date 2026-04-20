// Trust rule and starter bundle types.

// === Client → Server ===

export interface AddTrustRule {
  type: "add_trust_rule";
  toolName: string;
  pattern: string;
  scope: string;
  decision: "allow" | "deny" | "ask";
  /** Execution target override for this rule. */
  executionTarget?: "host" | "sandbox";
}

export interface TrustRulesList {
  type: "trust_rules_list";
}

export interface RemoveTrustRule {
  type: "remove_trust_rule";
  id: string;
}

export interface UpdateTrustRule {
  type: "update_trust_rule";
  id: string;
  tool?: string;
  pattern?: string;
  scope?: string;
  decision?: "allow" | "deny" | "ask";
  priority?: number;
}

export interface AcceptStarterBundle {
  type: "accept_starter_bundle";
}

// === Server → Client ===

export interface TrustRulesListResponse {
  type: "trust_rules_list_response";
  rules: Array<{
    id: string;
    tool: string;
    pattern: string;
    scope: string;
    decision: "allow" | "deny" | "ask";
    priority: number;
    createdAt: number;
  }>;
}

export interface AcceptStarterBundleResponse {
  type: "accept_starter_bundle_response";
  accepted: boolean;
  rulesAdded: number;
  alreadyAccepted: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _TrustClientMessages =
  | AddTrustRule
  | TrustRulesList
  | RemoveTrustRule
  | UpdateTrustRule
  | AcceptStarterBundle;

export type _TrustServerMessages =
  | TrustRulesListResponse
  | AcceptStarterBundleResponse;
