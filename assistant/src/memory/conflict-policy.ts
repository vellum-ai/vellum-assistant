/**
 * Pure, deterministic policy helpers for memory conflict eligibility.
 * Used by contradiction checker, session conflict gate, and background resolver.
 */

export interface ConflictPolicyConfig {
  conflictableKinds: readonly string[];
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
