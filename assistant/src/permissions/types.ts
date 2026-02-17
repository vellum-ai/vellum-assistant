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
  // v3 fields — optional for backward compatibility with v2 rules
  principalKind?: string;
  principalId?: string;
  principalVersion?: string;
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

// ── Principal + policy context types (PR 3) ──────────────────

/** Distinguishes whether a tool is a built-in core tool or provided by a skill. */
export type ToolPrincipalKind = 'core' | 'skill';

/** Identifies the security principal that owns a tool invocation. */
export interface ToolPrincipal {
  kind: ToolPrincipalKind;
  /** Skill ID when kind is 'skill'. */
  id?: string;
  /** Content-hash of the skill source at the time of approval. */
  version?: string;
}

/** Contextual information passed alongside a permission check for policy decisions. */
export interface PolicyContext {
  principal?: ToolPrincipal;
  executionTarget?: string;
}
