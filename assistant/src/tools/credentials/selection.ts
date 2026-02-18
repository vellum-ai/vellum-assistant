/**
 * Credential selection ranking helper.
 *
 * Pure function that ranks stored credentials for a given target endpoint,
 * allowing the assistant to auto-pick the best credential or know when
 * to ask the user due to ambiguity.
 */

import type { CredentialMetadata } from './metadata-store.js';
import type { CredentialInjectionTemplate } from './policy-types.js';

export interface CredentialCandidate {
  credentialId: string;
  score: number;
  matchReason: string;
}

export interface CredentialSelectionResult {
  topChoice: { credentialId: string; confidence: 'high' | 'medium' | 'low' } | null;
  candidates: CredentialCandidate[];
  ambiguous: boolean;
}

/**
 * Score multipliers — higher-priority criteria use larger values so they
 * dominate over lower-priority ones regardless of accumulation.
 */
const SCORE_EXACT_HOST = 100;
const SCORE_WILDCARD_HOST = 50;
const SCORE_ALIAS_SET = 10;
/** Per-second bonus (scaled to keep recency as a tiebreaker, not a dominant factor). */
const RECENCY_SCALE = 1e-9;

/**
 * Check whether `host` matches a glob-style `hostPattern`.
 * Supports leading wildcard like "*.example.com".
 */
function hostMatchesPattern(host: string, pattern: string): 'exact' | 'wildcard' | 'none' {
  const lHost = host.toLowerCase();
  const lPattern = pattern.toLowerCase();

  if (lHost === lPattern) return 'exact';

  // Wildcard patterns like "*.fal.ai"
  if (lPattern.startsWith('*.')) {
    const suffix = lPattern.slice(1); // ".fal.ai"
    if (lHost.endsWith(suffix) && lHost.length > suffix.length) {
      return 'wildcard';
    }
    // Also match the bare domain: "*.fal.ai" should match "fal.ai"
    if (lHost === lPattern.slice(2)) {
      return 'wildcard';
    }
  }

  return 'none';
}

/**
 * Compute the best host-match level across all injection templates for a credential.
 */
function bestHostMatch(
  templates: CredentialInjectionTemplate[] | undefined,
  targetHost: string,
): 'exact' | 'wildcard' | 'none' {
  if (!templates || templates.length === 0) return 'none';

  let best: 'exact' | 'wildcard' | 'none' = 'none';
  for (const t of templates) {
    const match = hostMatchesPattern(targetHost, t.hostPattern);
    if (match === 'exact') return 'exact'; // can't do better
    if (match === 'wildcard') best = 'wildcard';
  }
  return best;
}

/**
 * Rank credentials for a given endpoint and return a selection result.
 *
 * Ranking criteria (in priority order):
 * 1. Template host specificity: exact > wildcard > no match
 * 2. Alias hints: credentials with an alias rank higher
 * 3. Recency: more recently updated credentials rank higher (tiebreaker)
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

  const scored: CredentialCandidate[] = [];

  for (const cred of credentials) {
    // Domain policy check: if allowedDomains is non-empty, the target must match
    if (cred.allowedDomains.length > 0) {
      const domainAllowed = cred.allowedDomains.some(
        (d) => hostMatchesPattern(targetHost, d) !== 'none',
      );
      if (!domainAllowed) continue;
    }

    let score = 0;
    const reasons: string[] = [];

    // 1. Host specificity from injection templates
    const hostMatch = bestHostMatch(cred.injectionTemplates, targetHost);
    if (hostMatch === 'exact') {
      score += SCORE_EXACT_HOST;
      reasons.push('exact host match');
    } else if (hostMatch === 'wildcard') {
      score += SCORE_WILDCARD_HOST;
      reasons.push('wildcard host match');
    }

    // 2. Alias hint
    if (cred.alias) {
      score += SCORE_ALIAS_SET;
      reasons.push('alias set');
    }

    // 3. Recency tiebreaker (use updatedAt)
    score += cred.updatedAt * RECENCY_SCALE;

    if (reasons.length === 0) {
      reasons.push('domain allowed');
    }

    scored.push({
      credentialId: cred.credentialId,
      score,
      matchReason: reasons.join(', '),
    });
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { topChoice: null, candidates: scored, ambiguous: false };
  }

  const top = scored[0];

  // Determine ambiguity: top two scores are within the same tier
  // (i.e., differ by less than the smallest tier gap)
  const ambiguous =
    scored.length >= 2 &&
    Math.abs(top.score - scored[1].score) < SCORE_ALIAS_SET;

  // Determine confidence
  let confidence: 'high' | 'medium' | 'low';
  if (ambiguous) {
    confidence = 'low';
  } else if (top.score >= SCORE_EXACT_HOST) {
    confidence = 'high';
  } else if (top.score >= SCORE_WILDCARD_HOST) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    topChoice: { credentialId: top.credentialId, confidence },
    candidates: scored,
    ambiguous,
  };
}
