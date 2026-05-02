type RemoteSkillProvider = "clawhub" | "skillssh";

export type SkillsShRisk =
  | "safe"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "unknown";
export type SkillsShRiskThreshold = Exclude<SkillsShRisk, "unknown">;

export interface RemoteSkillPolicy {
  /**
   * When true, suspicious skills are excluded from installable lists
   * and blocked from installation.
   */
  blockSuspicious: boolean;
  /**
   * When true, malware-blocked skills are excluded from installable lists
   * and blocked from installation.
   */
  blockMalware: boolean;
  /**
   * Maximum allowed Skills.sh audit risk. Anything above this threshold is blocked.
   */
  maxSkillsShRisk: SkillsShRiskThreshold;
}

interface ClawhubModerationState {
  isSuspicious?: boolean;
  isMalwareBlocked?: boolean;
}

interface SkillsShAuditState {
  risk?: SkillsShRisk | null;
}

interface RemoteSkillCandidateBase {
  provider: RemoteSkillProvider;
  slug: string;
}

interface ClawhubRemoteSkillCandidate extends RemoteSkillCandidateBase {
  provider: "clawhub";
  moderation?: ClawhubModerationState | null;
}

interface SkillsShRemoteSkillCandidate extends RemoteSkillCandidateBase {
  provider: "skillssh";
  audit?: SkillsShAuditState | null;
}

export type RemoteSkillCandidate =
  | ClawhubRemoteSkillCandidate
  | SkillsShRemoteSkillCandidate;

export type RemoteSkillDenyReason =
  | "clawhub_suspicious"
  | "clawhub_malware_blocked"
  | "clawhub_moderation_missing"
  | "skillssh_risk_exceeds_threshold";

export type RemoteSkillInstallDecision =
  | { ok: true }
  | { ok: false; reason: RemoteSkillDenyReason };

const DEFAULT_REMOTE_SKILL_POLICY: Readonly<RemoteSkillPolicy> = Object.freeze({
  blockSuspicious: true,
  blockMalware: true,
  maxSkillsShRisk: "medium",
});

const SKILLS_SH_RISK_RANK: Record<SkillsShRisk, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  // Fail closed when risk is unknown.
  unknown: 5,
};

function normalizeSkillsShRisk(
  audit: SkillsShAuditState | null | undefined,
): SkillsShRisk {
  const risk = audit?.risk;
  if (risk == null) return "unknown";
  // Coerce unrecognized risk labels to 'unknown' so we fail closed.
  if (!Object.hasOwn(SKILLS_SH_RISK_RANK, risk)) return "unknown";
  return risk;
}

function exceedsSkillsShRiskThreshold(
  audit: SkillsShAuditState | null | undefined,
  threshold: SkillsShRiskThreshold,
): boolean {
  const actualRisk = normalizeSkillsShRisk(audit);
  return SKILLS_SH_RISK_RANK[actualRisk] > SKILLS_SH_RISK_RANK[threshold];
}

export function evaluateRemoteSkillInstall(
  candidate: RemoteSkillCandidate,
  policy: RemoteSkillPolicy = DEFAULT_REMOTE_SKILL_POLICY,
): RemoteSkillInstallDecision {
  if (candidate.provider === "clawhub") {
    // Fail closed: block Clawhub skills when moderation data is missing.
    if (candidate.moderation == null) {
      return { ok: false, reason: "clawhub_moderation_missing" };
    }

    if (policy.blockMalware && candidate.moderation.isMalwareBlocked === true) {
      return { ok: false, reason: "clawhub_malware_blocked" };
    }
    if (policy.blockSuspicious && candidate.moderation.isSuspicious === true) {
      return { ok: false, reason: "clawhub_suspicious" };
    }
    return { ok: true };
  }

  if (exceedsSkillsShRiskThreshold(candidate.audit, policy.maxSkillsShRisk)) {
    return { ok: false, reason: "skillssh_risk_exceeds_threshold" };
  }

  return { ok: true };
}

function isRemoteSkillInstallable(
  candidate: RemoteSkillCandidate,
  policy: RemoteSkillPolicy = DEFAULT_REMOTE_SKILL_POLICY,
): boolean {
  return evaluateRemoteSkillInstall(candidate, policy).ok;
}

export function filterInstallableRemoteSkills<T extends RemoteSkillCandidate>(
  skills: T[],
  policy: RemoteSkillPolicy = DEFAULT_REMOTE_SKILL_POLICY,
): T[] {
  return skills.filter((skill) => isRemoteSkillInstallable(skill, policy));
}
