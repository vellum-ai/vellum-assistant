import type { SkillsShAuditReport, SkillsShAuditDimension } from './skillssh.js';
import type { SkillsShRisk } from './remote-skill-policy.js';
import { deriveOverallRisk } from './skillssh.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type SecurityRecommendation = 'proceed' | 'proceed_with_caution' | 'do_not_recommend';

export interface SecurityDecision {
  recommendation: SecurityRecommendation;
  overallRisk: SkillsShRisk;
  rationale: string;
  auditSummary: AuditDimensionSummary[];
}

export interface AuditDimensionSummary {
  provider: string;
  risk: string;
  analyzedAt: string;
  details?: string;
}

// ─── Decision logic ─────────────────────────────────────────────────────────────

function recommendationFromRisk(risk: SkillsShRisk): SecurityRecommendation {
  switch (risk) {
    case 'safe':
    case 'low':
      return 'proceed';
    case 'medium':
      return 'proceed_with_caution';
    case 'high':
    case 'critical':
    case 'unknown':
      return 'do_not_recommend';
  }
}

function buildDimensionDetails(dim: SkillsShAuditDimension): string | undefined {
  const parts: string[] = [];
  if (dim.alerts != null) parts.push(`${dim.alerts} alert${dim.alerts === 1 ? '' : 's'}`);
  if (dim.score != null) parts.push(`score ${dim.score}/100`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function buildAuditSummary(audit: SkillsShAuditReport): AuditDimensionSummary[] {
  const summaries: AuditDimensionSummary[] = [];
  const providers = ['ath', 'socket', 'snyk'] as const;

  for (const provider of providers) {
    const dim = audit[provider];
    if (dim) {
      summaries.push({
        provider,
        risk: dim.risk,
        analyzedAt: dim.analyzedAt,
        details: buildDimensionDetails(dim),
      });
    }
  }

  return summaries;
}

function buildRationale(
  recommendation: SecurityRecommendation,
  overallRisk: SkillsShRisk,
  auditSummary: AuditDimensionSummary[],
): string {
  if (auditSummary.length === 0) {
    return 'No audit data available. Unable to assess security risk.';
  }

  switch (recommendation) {
    case 'proceed':
      return 'All security audits passed with safe/low risk ratings.';

    case 'proceed_with_caution': {
      const mediumProviders = auditSummary
        .filter((s) => s.risk === 'medium')
        .map((s) => {
          const label = s.provider.charAt(0).toUpperCase() + s.provider.slice(1);
          return s.details ? `${label} reports ${s.details}` : label;
        });
      const providerInfo = mediumProviders.length > 0 ? ` ${mediumProviders.join('. ')}.` : '';
      return `Medium risk detected.${providerInfo}`;
    }

    case 'do_not_recommend': {
      const riskLabel = overallRisk.charAt(0).toUpperCase() + overallRisk.slice(1);
      const flaggedProviders = auditSummary
        .filter((s) => s.risk === overallRisk || s.risk === 'critical' || s.risk === 'high')
        .map((s) => s.provider.charAt(0).toUpperCase() + s.provider.slice(1));
      const providerNames =
        flaggedProviders.length > 0 ? ` by ${flaggedProviders.join(' and ')}` : '';
      return `${riskLabel} risk detected${providerNames}. Review the audit details before proceeding.`;
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluate a skills.sh audit report and produce a structured security recommendation.
 * The recommendation is purely advisory -- callers decide whether to act on it
 * or present it to the user for an override decision.
 */
export function makeSecurityDecision(audit: SkillsShAuditReport): SecurityDecision {
  const overallRisk = deriveOverallRisk(audit);
  const recommendation = recommendationFromRisk(overallRisk);
  const auditSummary = buildAuditSummary(audit);
  const rationale = buildRationale(recommendation, overallRisk, auditSummary);

  return { recommendation, overallRisk, rationale, auditSummary };
}
