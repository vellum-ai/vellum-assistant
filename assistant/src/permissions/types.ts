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
}

export type UserDecision = 'allow' | 'always_allow' | 'deny' | 'always_deny';

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
