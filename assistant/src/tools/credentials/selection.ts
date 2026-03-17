/**
 * Credential selection ranking helper.
 *
 * Pure function that ranks stored credentials for a given target endpoint,
 * allowing the assistant to auto-pick the best credential or know when
 * to ask the user due to ambiguity.
 */

import { isDomainAllowed } from "./domain-policy.js";
import { matchHostPattern } from "./host-pattern-match.js";
import type { CredentialMetadata } from "./metadata-store.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";

export interface CredentialCandidate {
  credentialId: string;
  score: number;
  matchReason: string;
}

export interface CredentialSelectionResult {
  topChoice: {
    credentialId: string;
    confidence: "high" | "medium" | "low";
  } | null;
  candidates: CredentialCandidate[];
  ambiguous: boolean;
}

/**
 * Tier scores - higher-priority criteria use larger values so they
 * dominate over lower-priority ones regardless of accumulation.
 */
const SCORE_EXACT_HOST = 100;
const SCORE_WILDCARD_HOST = 50;
const SCORE_ALIAS_SET = 10;

/**
 * Check whether `host` matches a glob-style `hostPattern`.
 * Supports leading wildcard like "*.example.com".
 */
function hostMatchesPattern(
  host: string,
  pattern: string,
): "exact" | "wildcard" | "none" {
  return matchHostPattern(host, pattern, { includeApexForWildcard: true });
}

/**
 * Compute the best host-match level across all injection templates for a credential.
 */
function bestHostMatch(
  templates: CredentialInjectionTemplate[] | undefined,
  targetHost: string,
): "exact" | "wildcard" | "none" {
  if (!templates || templates.length === 0) return "none";

  let best: "exact" | "wildcard" | "none" = "none";
  for (const t of templates) {
    const match = hostMatchesPattern(targetHost, t.hostPattern);
    if (match === "exact") return "exact"; // can't do better
    if (match === "wildcard") best = "wildcard";
  }
  return best;
}

interface ScoredCandidate extends CredentialCandidate {
  tierScore: number;
  updatedAt: number;
}

/**
 * Rank credentials for a given endpoint and return a selection result.
 *
 * Ranking criteria (in priority order):
 * 1. Template host specificity: exact > wildcard > no match
 * 2. Alias hints: credentials with an alias rank higher
 * 3. Recency: more recently updated credentials rank higher (tiebreaker only)
 *
 * Only credentials whose `allowedDomains` include the target host (or are
 * empty, which is treated as "no domain restriction") are considered.
 */
export function rankCredentialsForEndpoint(
  credentials: CredentialMetadata[],
  targetHost: string,
  _targetPath?: string,
): CredentialSelectionResult {
  if (credentials.length === 0) {
    return { topChoice: null, candidates: [], ambiguous: false };
  }

  const scored: ScoredCandidate[] = [];

  for (const cred of credentials) {
    // Domain policy check using the same matcher as credential enforcement
    if (cred.allowedDomains.length > 0) {
      if (!isDomainAllowed(targetHost, cred.allowedDomains)) continue;
    }

    let tierScore = 0;
    const reasons: string[] = [];

    // 1. Host specificity from injection templates
    const hostMatch = bestHostMatch(cred.injectionTemplates, targetHost);
    if (hostMatch === "exact") {
      tierScore += SCORE_EXACT_HOST;
      reasons.push("exact host match");
    } else if (hostMatch === "wildcard") {
      tierScore += SCORE_WILDCARD_HOST;
      reasons.push("wildcard host match");
    }

    // 2. Alias hint
    if (cred.alias) {
      tierScore += SCORE_ALIAS_SET;
      reasons.push("alias set");
    }

    if (reasons.length === 0) {
      reasons.push("domain allowed");
    }

    scored.push({
      credentialId: cred.credentialId,
      score: tierScore,
      tierScore,
      updatedAt: cred.updatedAt,
      matchReason: reasons.join(", "),
    });
  }

  // Sort by tier score first, then by recency as tiebreaker
  scored.sort((a, b) => {
    const tierDiff = b.tierScore - a.tierScore;
    if (tierDiff !== 0) return tierDiff;
    return b.updatedAt - a.updatedAt;
  });

  if (scored.length === 0) {
    return { topChoice: null, candidates: scored, ambiguous: false };
  }

  const top = scored[0];

  // Ambiguity: top two candidates share the same tier score
  const ambiguous = scored.length >= 2 && top.tierScore === scored[1].tierScore;

  // Confidence is based on the tier score, not inflated by recency
  let confidence: "high" | "medium" | "low";
  if (ambiguous) {
    confidence = "low";
  } else if (top.tierScore >= SCORE_EXACT_HOST) {
    confidence = "high";
  } else if (top.tierScore >= SCORE_WILDCARD_HOST) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    topChoice: { credentialId: top.credentialId, confidence },
    candidates: scored,
    ambiguous,
  };
}
