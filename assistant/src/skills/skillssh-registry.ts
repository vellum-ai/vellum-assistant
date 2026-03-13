// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillsShSearchResult {
  id: string; // e.g. "vercel-labs/agent-skills/vercel-react-best-practices"
  skillId: string; // e.g. "vercel-react-best-practices"
  name: string;
  installs: number;
  source: string; // e.g. "vercel-labs/agent-skills"
}

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

// ─── Display helpers ─────────────────────────────────────────────────────────

const RISK_DISPLAY: Record<RiskLevel, string> = {
  safe: "PASS",
  low: "PASS",
  medium: "WARN",
  high: "FAIL",
  critical: "FAIL",
  unknown: "?",
};

const PROVIDER_DISPLAY: Record<string, string> = {
  ath: "ATH",
  socket: "Socket",
  snyk: "Snyk",
};

export function riskToDisplay(risk: RiskLevel): string {
  return RISK_DISPLAY[risk] ?? "?";
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY[provider] ?? provider;
}

export function formatAuditBadges(auditData: SkillAuditData): string {
  const providers = Object.keys(auditData);
  if (providers.length === 0) return "Security: no audit data";

  const badges = providers.map((provider) => {
    const audit = auditData[provider]!;
    const display = riskToDisplay(audit.risk);
    const name = providerDisplayName(provider);
    return `[${name}:${display}]`;
  });

  return `Security: ${badges.join(" ")}`;
}

// ─── API clients ─────────────────────────────────────────────────────────────

export async function searchSkillsRegistry(
  query: string,
  limit?: number,
): Promise<SkillsShSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (limit != null) {
    params.set("limit", String(limit));
  }

  const url = `https://skills.sh/api/search?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `skills.sh search failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as SkillsShSearchResult[];
}

export async function fetchSkillAudits(
  source: string,
  skillSlugs: string[],
): Promise<AuditResponse> {
  if (skillSlugs.length === 0) return {};

  const params = new URLSearchParams({
    source,
    skills: skillSlugs.join(","),
  });

  const url = `https://add-skill.vercel.sh/audit?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Audit fetch failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AuditResponse;
}
