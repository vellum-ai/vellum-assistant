import { getLogger } from '../util/logger.js';
import type { SkillsShRisk } from './remote-skill-policy.js';

const log = getLogger('skillssh');

const SKILLS_SH_SEARCH_URL = 'https://skills.sh/api/search';
const SKILLS_SH_AUDIT_URL = 'https://add-skill.vercel.sh/audit';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SkillsShSearchResultItem {
  id: string;        // Full path: source/skillId
  skillId: string;   // Skill name
  name: string;      // Display name
  installs: number;
  source: string;    // GitHub repo path (owner/repo)
}

export interface SkillsShSearchResult {
  skills: SkillsShSearchResultItem[];
  query: string;
}

export interface SkillsShAuditDimension {
  risk: string;
  analyzedAt: string;
  alerts?: number;
  score?: number;
}

export interface SkillsShAuditReport {
  ath?: SkillsShAuditDimension;
  socket?: SkillsShAuditDimension;
  snyk?: SkillsShAuditDimension;
}

export interface SkillsShSearchWithAuditItem extends SkillsShSearchResultItem {
  audit: SkillsShAuditReport;
  /** Derived overall risk (worst-case across dimensions). Maps to SkillsShRisk from remote-skill-policy.ts */
  overallRisk: SkillsShRisk;
}

export interface SkillsShSearchWithAuditResult {
  skills: SkillsShSearchWithAuditItem[];
  query: string;
}

// ─── Risk derivation ────────────────────────────────────────────────────────────

const RISK_RANK: Record<string, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const RANK_TO_RISK: SkillsShRisk[] = ['safe', 'low', 'medium', 'high', 'critical'];

/**
 * Derive the worst-case risk across all audit dimensions.
 * Unrecognized risk labels are treated as 'unknown' (fail closed).
 * If no audit dimensions exist, returns 'unknown'.
 */
export function deriveOverallRisk(audit: SkillsShAuditReport): SkillsShRisk {
  const dimensions = [audit.ath, audit.socket, audit.snyk].filter(
    (d): d is SkillsShAuditDimension => d != null,
  );

  if (dimensions.length === 0) return 'unknown';

  let maxRank = -1;
  for (const dim of dimensions) {
    if (!Object.hasOwn(RISK_RANK, dim.risk)) {
      // Unrecognized risk label -- fail closed (hasOwn guards against inherited properties like toString/constructor)
      return 'unknown';
    }
    const rank = RISK_RANK[dim.risk];
    if (rank > maxRank) maxRank = rank;
  }

  return RANK_TO_RISK[maxRank] ?? 'unknown';
}

// ─── Search adapter ─────────────────────────────────────────────────────────────

export async function skillsshSearch(
  query: string,
  opts?: { limit?: number },
): Promise<SkillsShSearchResult> {
  const limit = opts?.limit ?? 10;
  const url = `${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}`;

  log.info({ query, limit }, 'Searching skills.sh');

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `skills.sh search failed: HTTP ${response.status}${body ? ` — ${body}` : ''}`,
    );
  }

  const data = await response.json();

  if (!data || !Array.isArray(data.skills)) {
    throw new Error('skills.sh search returned unexpected response shape');
  }

  const skills: SkillsShSearchResultItem[] = data.skills.map(
    (s: Record<string, unknown>) => ({
      id: String(s.id ?? ''),
      skillId: String(s.skillId ?? ''),
      name: String(s.name ?? ''),
      installs: typeof s.installs === 'number' ? s.installs : 0,
      source: String(s.source ?? ''),
    }),
  );

  log.info({ query, count: skills.length }, 'skills.sh search completed');

  return { skills, query: String(data.query ?? query) };
}

// ─── Audit adapter ──────────────────────────────────────────────────────────────

export async function skillsshFetchAudit(
  source: string,
  skillId: string,
): Promise<SkillsShAuditReport> {
  const url = `${SKILLS_SH_AUDIT_URL}?source=${encodeURIComponent(source)}&skills=${encodeURIComponent(skillId)}`;

  log.info({ source, skillId }, 'Fetching skills.sh audit');

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `skills.sh audit failed: HTTP ${response.status}${body ? ` — ${body}` : ''}`,
    );
  }

  const data = await response.json();

  if (!data || typeof data !== 'object') {
    throw new Error('skills.sh audit returned unexpected response shape');
  }

  const skillAudit = (data as Record<string, unknown>)[skillId];

  // No audit data for this skill
  if (!skillAudit || typeof skillAudit !== 'object') {
    return {};
  }

  const raw = skillAudit as Record<string, unknown>;
  const report: SkillsShAuditReport = {};

  for (const provider of ['ath', 'socket', 'snyk'] as const) {
    const dim = raw[provider];
    if (dim && typeof dim === 'object') {
      const d = dim as Record<string, unknown>;
      report[provider] = {
        risk: String(d.risk ?? ''),
        analyzedAt: String(d.analyzedAt ?? ''),
        ...(typeof d.alerts === 'number' ? { alerts: d.alerts } : {}),
        ...(typeof d.score === 'number' ? { score: d.score } : {}),
      };
    }
  }

  log.info({ source, skillId, providers: Object.keys(report) }, 'skills.sh audit completed');

  return report;
}

// ─── Combined search + audit ────────────────────────────────────────────────────

export async function skillsshSearchWithAudit(
  query: string,
  opts?: { limit?: number },
): Promise<SkillsShSearchWithAuditResult> {
  const searchResult = await skillsshSearch(query, opts);

  // Fetch audits in parallel for all search results
  const auditResults = await Promise.allSettled(
    searchResult.skills.map((skill) =>
      skillsshFetchAudit(skill.source, skill.skillId),
    ),
  );

  const skills: SkillsShSearchWithAuditItem[] = searchResult.skills.map(
    (skill, i) => {
      const auditResult = auditResults[i];
      let audit: SkillsShAuditReport;

      if (auditResult.status === 'fulfilled') {
        audit = auditResult.value;
      } else {
        // Audit fetch failed -- log the error but don't fail the entire operation.
        // Set audit to empty so overallRisk becomes 'unknown' (fail closed).
        log.warn(
          { skillId: skill.skillId, error: auditResult.reason },
          'Failed to fetch audit for skill — treating as unknown risk',
        );
        audit = {};
      }

      return {
        ...skill,
        audit,
        overallRisk: deriveOverallRisk(audit),
      };
    },
  );

  return { skills, query: searchResult.query };
}
