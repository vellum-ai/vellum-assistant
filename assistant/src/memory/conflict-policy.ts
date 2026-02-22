/**
 * Pure, deterministic policy helpers for memory conflict eligibility.
 * Used by contradiction checker, session conflict gate, and background resolver.
 */

export interface ConflictPolicyConfig {
  conflictableKinds: readonly string[];
  [key: string]: unknown;
}

/**
 * Returns true when the given memory item kind is eligible to participate
 * in conflict detection according to the current policy.
 */
export function isConflictKindEligible(kind: string, config: ConflictPolicyConfig): boolean {
  return config.conflictableKinds.includes(kind);
}

/**
 * Returns true when both sides of a potential conflict pair are kind-eligible.
 */
export function isConflictKindPairEligible(
  existingKind: string,
  candidateKind: string,
  config: ConflictPolicyConfig,
): boolean {
  return isConflictKindEligible(existingKind, config) && isConflictKindEligible(candidateKind, config);
}

// ── Transient statement classification ─────────────────────────────────

const PR_URL_PATTERN = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;
const ISSUE_TICKET_PATTERN = /\b(?:issue|pr|ticket|pull request)\s*#?\d+/i;
const TRACKING_LANGUAGE_PATTERN = /\b(?:this pr|that issue|while we wait|currently tracking)\b/i;

/**
 * Returns true when a statement looks like a transient tracking note
 * (PR URLs, issue references, short-lived progress notes) rather than
 * a durable user preference or instruction.
 */
export function isTransientTrackingStatement(statement: string): boolean {
  if (PR_URL_PATTERN.test(statement)) return true;
  if (ISSUE_TICKET_PATTERN.test(statement)) return true;
  if (TRACKING_LANGUAGE_PATTERN.test(statement)) return true;
  return false;
}

const DURABLE_INSTRUCTION_CUES = /\b(?:always|never|default|every time|by default|style|format|tone|convention|standard)\b/i;

/**
 * Returns true when a statement contains strong durable instruction cues,
 * suggesting it represents a persistent user preference or style rule.
 */
export function isDurableInstructionStatement(statement: string): boolean {
  return DURABLE_INSTRUCTION_CUES.test(statement);
}

/**
 * Returns true when a statement of the given kind is eligible to participate
 * in conflict detection at the statement level. This combines kind eligibility
 * with statement-level durability heuristics.
 *
 * For instruction/style kinds: requires positive durable cues and no transient cues.
 * For other eligible kinds: rejects if transient tracking cues dominate.
 */
export function isStatementConflictEligible(kind: string, statement: string, config?: ConflictPolicyConfig): boolean {
  if (config && !isConflictKindEligible(kind, config)) return false;
  if (isTransientTrackingStatement(statement)) return false;
  if (kind === 'instruction' || kind === 'style') {
    return isDurableInstructionStatement(statement);
  }
  return true;
}
