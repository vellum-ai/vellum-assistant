/**
 * Explicit, ordinal capability ranking for Claude models.
 *
 * The model catalog carries pricing, context windows, and feature flags, but no
 * ordinal "tier" field — there is no machine-readable way to say opus outranks
 * sonnet outranks haiku, or that 4.8 outranks 4.6. This module defines that
 * ordering so callers can decide whether one model is a genuine step up from
 * another (e.g. surfacing a more capable advisor than the current executor).
 *
 * Pure module: no I/O, no daemon/config imports. Cheap to test and reuse.
 */

export interface ModelCapability {
  /**
   * Capability namespace. Models only compare against others sharing a lineage
   * (e.g. the tiered "claude" family, or single-tier lineages like "fable").
   */
  lineage: string;
  /**
   * Ordinal rank within a tiered lineage (haiku < sonnet < opus). Single-tier
   * lineages use 0 since there is no intra-lineage family ordering.
   */
  familyRank: number;
  /**
   * Monotonic version. Tiered families encode `major + minor / 10` so that
   * 4.8 > 4.6 > 4.5; single-tier lineages use the bare release integer.
   */
  version: number;
}

/** Ordinal rank of each tiered Claude family. Higher is more capable. */
export const CLAUDE_FAMILY_RANK: Record<string, number> = {
  haiku: 1,
  sonnet: 2,
  opus: 3,
};

/** Single-tier Claude lineages, each its own non-comparable namespace. */
const CLAUDE_SINGLE_TIER_LINEAGES = ["fable", "mythos"] as const;

/**
 * First `-<major>-<minor>` pair, e.g. `claude-opus-4-8` → major 4, minor 8.
 * Matches the dashed ids used by first-party Anthropic configs.
 */
const VERSION_PATTERN_DASHED = /-(\d+)-(\d+)/;

/**
 * First `<major>.<minor>` pair, e.g. `anthropic/claude-opus-4.8` → major 4,
 * minor 8. Matches the dotted, provider-prefixed ids OpenRouter exposes.
 */
const VERSION_PATTERN_DOTTED = /(\d+)\.(\d+)/;

/**
 * Single-tier lineages encode version as a trailing integer. Accepts both the
 * dashed (`claude-fable-5`, also matches `anthropic/claude-fable-5`) and dotted
 * (`claude-fable-5.2`) forms.
 */
const SINGLE_TIER_VERSION_PATTERN_DASHED = /-(\d+)/;
const SINGLE_TIER_VERSION_PATTERN_DOTTED = /(\d+)\.(\d+)/;

function encodeVersion(major: number, minor: number): number {
  return major + minor / 10;
}

/**
 * Parse a tiered family's version from either the dashed (`-4-8`) or dotted
 * (`4.8`) form, returning the same monotonic encoding for both so that the two
 * spellings of one model compare equal. `null` when neither form is present.
 */
function parseTieredVersion(id: string): number | null {
  const dashed = id.match(VERSION_PATTERN_DASHED);
  if (dashed) return encodeVersion(Number(dashed[1]), Number(dashed[2]));
  const dotted = id.match(VERSION_PATTERN_DOTTED);
  if (dotted) return encodeVersion(Number(dotted[1]), Number(dotted[2]));
  return null;
}

/**
 * Parse a single-tier lineage's version from the bare trailing integer
 * (`-5`, also matches a `provider/` prefix) or the dotted form (`5.2`).
 * `null` when neither form is present.
 */
function parseSingleTierVersion(id: string): number | null {
  const dotted = id.match(SINGLE_TIER_VERSION_PATTERN_DOTTED);
  if (dotted) return encodeVersion(Number(dotted[1]), Number(dotted[2]));
  const dashed = id.match(SINGLE_TIER_VERSION_PATTERN_DASHED);
  if (dashed) return Number(dashed[1]);
  return null;
}

/**
 * Parse a model id into its capability coordinates, or `null` when the id is
 * not a recognized Claude model (other providers, unknown ids).
 */
export function parseModelCapability(modelId: string): ModelCapability | null {
  const id = modelId.toLowerCase();

  for (const family of Object.keys(CLAUDE_FAMILY_RANK)) {
    if (id.includes(family)) {
      const version = parseTieredVersion(id);
      if (version === null) return null;
      return {
        lineage: "claude",
        familyRank: CLAUDE_FAMILY_RANK[family]!,
        version,
      };
    }
  }

  for (const lineage of CLAUDE_SINGLE_TIER_LINEAGES) {
    if (id.includes(lineage)) {
      const version = parseSingleTierVersion(id);
      if (version === null) return null;
      return { lineage, familyRank: 0, version };
    }
  }

  return null;
}

/**
 * Whether `advisorModel` is a strictly more capable model than `executorModel`.
 *
 * Conservative by design: returns `false` for any unrecognized model or any
 * cross-lineage comparison, so callers never surface an "upgrade" they cannot
 * confidently rank. Within a lineage, capability is ordered lexicographically
 * by `(familyRank, version)`.
 */
export function isStrictlyMoreCapable(
  advisorModel: string,
  executorModel: string,
): boolean {
  const advisor = parseModelCapability(advisorModel);
  const executor = parseModelCapability(executorModel);

  if (!advisor || !executor) return false;
  if (advisor.lineage !== executor.lineage) return false;

  if (advisor.familyRank !== executor.familyRank) {
    return advisor.familyRank > executor.familyRank;
  }
  return advisor.version > executor.version;
}
