import type { SkillSource } from '../config/skills.js';
import type { SkillProvenance } from './managed-store.js';

// ─── Provenance label derivation ─────────────────────────────────────────────

export type ProvenanceLabel =
  | 'Vellum'
  | 'Third-party (skills.sh)'
  | 'Third-party (Clawhub)'
  | 'User'
  | 'Community';

/**
 * Derive a human-readable provenance label for a skill based on its source
 * type and optional provenance metadata.
 *
 * - `'Vellum'` for bundled skills
 * - `'Third-party (skills.sh)'` for managed skills with skills.sh provenance
 * - `'Third-party (Clawhub)'` for managed skills installed via Clawhub
 * - `'User'` for workspace/extra skills
 * - `'Community'` for managed skills without provenance
 */
export function deriveProvenanceLabel(
  source: SkillSource,
  provenance: SkillProvenance | null,
): ProvenanceLabel {
  switch (source) {
    case 'bundled':
      return 'Vellum';

    case 'workspace':
    case 'extra':
      return 'User';

    case 'managed': {
      if (!provenance) {
        return 'Community';
      }

      if (provenance.provider === 'skills.sh') {
        return 'Third-party (skills.sh)';
      }

      // Clawhub or other recognized providers
      if (provenance.provider === 'clawhub') {
        return 'Third-party (Clawhub)';
      }

      // Managed skill with unrecognized provenance provider — treat as community
      return 'Community';
    }

    default:
      return 'Community';
  }
}

// ─── Source URL derivation ───────────────────────────────────────────────────

/**
 * Construct a source URL for a skill that links back to the original source.
 *
 * - For skills.sh skills: returns `https://skills.sh/skills/<source>/<skillId>`
 *   from the provenance data.
 * - For other skills: returns `null`.
 */
export function deriveSourceUrl(
  source: SkillSource,
  provenance: SkillProvenance | null,
): string | null {
  if (source !== 'managed' || !provenance) {
    return null;
  }

  // The provenance already contains a fully constructed sourceUrl
  if (provenance.sourceUrl) {
    return provenance.sourceUrl;
  }

  // Fallback construction for skills.sh skills when sourceUrl is missing
  if (provenance.provider === 'skills.sh' && provenance.source && provenance.skillId) {
    return `https://skills.sh/skills/${provenance.source}/${provenance.skillId}`;
  }

  return null;
}

// ─── Enriched skill entry for UI consumption ─────────────────────────────────

export interface SkillProvenanceInfo {
  provenanceLabel: ProvenanceLabel;
  sourceUrl: string | null;
  provenance: SkillProvenance | null;
}

/**
 * Compute the full provenance info block for a skill, suitable for inclusion
 * in a skills list response.
 */
export function getSkillProvenanceInfo(
  source: SkillSource,
  provenance: SkillProvenance | null,
): SkillProvenanceInfo {
  return {
    provenanceLabel: deriveProvenanceLabel(source, provenance),
    sourceUrl: deriveSourceUrl(source, provenance),
    provenance,
  };
}
