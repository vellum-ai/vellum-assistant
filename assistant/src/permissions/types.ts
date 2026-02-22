export enum RiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export interface TrustRule {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny' | 'ask';
  priority: number;
  createdAt: number;
  executionTarget?: string;
  allowHighRisk?: boolean;
}

export type UserDecision = 'allow' | 'always_allow' | 'always_allow_high_risk' | 'deny' | 'always_deny';

export interface PermissionCheckResult {
  decision: 'allow' | 'deny' | 'prompt';
  reason: string;
  matchedRule?: TrustRule;
}

export interface AllowlistOption {
  label: string;
  description: string;
  pattern: string;
}

export interface ScopeOption {
  label: string;
  scope: string;
}

/** Contextual information passed alongside a permission check for policy decisions. */
export interface PolicyContext {
  executionTarget?: string;
  /** Ephemeral rules for task-scoped permissions — checked before persistent trust.json rules. */
  ephemeralRules?: TrustRule[];
}
