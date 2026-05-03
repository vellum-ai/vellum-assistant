/**
 * Audit types for SkillSSH partner security analysis.
 *
 * Extracted as a leaf module so daemon message types can reference
 * PartnerAudit without pulling in the full skillssh-registry module
 * (which transitively imports cli/program and the entire CLI graph).
 */

export type RiskLevel =
  | "safe"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "unknown";

export interface PartnerAudit {
  risk: RiskLevel;
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

/** Map from audit provider name (e.g. "ath", "socket", "snyk") to audit data */
export type SkillAuditData = Record<string, PartnerAudit>;

/** Map from skill slug to per-provider audit data */
export type AuditResponse = Record<string, SkillAuditData>;
