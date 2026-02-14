import type { SkillSummary } from '../config/skills.js';
import type { ResolvedSkill } from '../config/skill-state.js';

/**
 * Parse whether user input starts with a slash-like command token.
 *
 * Rules:
 * - Trim leading whitespace.
 * - Only inspect the first whitespace-delimited token.
 * - A candidate token must begin with `/`.
 * - Return `none` for empty input.
 */

export function extractLeadingToken(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;
  const firstToken = trimmed.split(/\s/)[0];
  return firstToken || null;
}

export function parseSlashCandidate(input: string): { kind: 'none' | 'candidate'; token?: string } {
  const token = extractLeadingToken(input);
  if (!token || !token.startsWith('/')) {
    return { kind: 'none' };
  }
  if (isPathLikeSlashToken(token)) {
    return { kind: 'none' };
  }
  const id = token.slice(1);
  if (!isValidSlashSkillId(id)) {
    return { kind: 'none' };
  }
  return { kind: 'candidate', token };
}

/** Validate that a slash skill ID starts with alphanumeric and contains only [A-Za-z0-9._-] */
export function isValidSlashSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** Detect filesystem-like paths: tokens containing more than one `/` */
export function isPathLikeSlashToken(token: string): boolean {
  // Count slashes — a single leading `/` is expected, but any additional `/` means it's a path
  const slashCount = token.split('/').length - 1;
  return slashCount > 1;
}

// ─── Invocable slash skill catalog ──────────────────────────────────────────

export interface InvocableSlashSkill {
  canonicalId: string;
  name: string;
  summary: SkillSummary;
}

/**
 * Build a map of slash-invocable skills keyed by lowercase ID for
 * case-insensitive lookup. Only includes skills that are `userInvocable`
 * and whose resolved state is not `disabled`.
 */
export function buildInvocableSlashCatalog(
  catalog: SkillSummary[],
  resolvedStates: ResolvedSkill[],
): Map<string, InvocableSlashSkill> {
  const stateById = new Map<string, ResolvedSkill>();
  for (const rs of resolvedStates) {
    stateById.set(rs.summary.id, rs);
  }

  const result = new Map<string, InvocableSlashSkill>();
  for (const skill of catalog) {
    if (!skill.userInvocable) continue;
    const resolved = stateById.get(skill.id);
    if (resolved && resolved.state === 'disabled') continue;
    result.set(skill.id.toLowerCase(), {
      canonicalId: skill.id,
      name: skill.name,
      summary: skill,
    });
  }
  return result;
}
