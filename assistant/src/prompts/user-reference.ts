import { resolveGuardianPersona } from "./persona-resolver.js";

export const DEFAULT_USER_REFERENCE = "my human";
export const DECLINED_BY_USER_SENTINEL = "declined_by_user";

/**
 * Read the raw "Preferred name/reference:" value from the guardian's
 * per-user persona file (`users/<slug>.md`).
 *
 * Returns the trimmed value when present, or `null` when no guardian
 * is resolvable, the persona file is missing / empty, or the field
 * itself is blank.
 */
function readPreferredNameFromUserMd(): string | null {
  const content = resolveGuardianPersona();
  if (content != null) {
    const match = content.match(/Preferred name\/reference:[ \t]*(.*)/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Resolve the name/reference the assistant uses when referring to
 * the human it represents in external communications.
 *
 * Reads the "Preferred name/reference:" field from the guardian's
 * persona file. Falls back to "my human" when the file is missing,
 * unreadable, or the field is empty.
 */
export function resolveUserReference(): string {
  const preferredName = readPreferredNameFromUserMd();
  if (preferredName != null && preferredName !== DECLINED_BY_USER_SENTINEL) {
    return preferredName;
  }
  return DEFAULT_USER_REFERENCE;
}

/**
 * Resolve the user's pronouns from the guardian's per-user persona file.
 * Returns `null` when no guardian is resolvable, the file is missing,
 * the field is empty, or the value is a sentinel like `declined_by_user`.
 *
 * When a legacy `## Onboarding Snapshot` section exists, a `Pronouns:`
 * line *above* that section takes priority (explicit post-onboarding edit).
 * Otherwise falls back to the structured `- Pronouns:` field anywhere
 * in the file.
 */
export function resolveUserPronouns(): string | null {
  const content = resolveGuardianPersona();
  if (content == null) return null;

  const snapshotIdx = content.indexOf("## Onboarding Snapshot");

  // 1. Legacy format: check for a Pronouns line outside the Onboarding
  //    Snapshot section (explicit post-onboarding update takes priority).
  if (snapshotIdx >= 0) {
    const beforeSnapshot = content.slice(0, snapshotIdx);
    const outsideMatch = beforeSnapshot.match(/Pronouns:[ \t]*(.*)/);
    if (outsideMatch && outsideMatch[1].trim()) {
      return cleanPronounValue(outsideMatch[1].trim());
    }
  }

  // 2. Search the entire file for the structured `- Pronouns:` field.
  //    Handles both legacy (inside Onboarding Snapshot) and new flat format.
  const match = content.match(/^- Pronouns:[ \t]*(.*)/m);
  if (match && match[1].trim()) {
    return cleanPronounValue(match[1].trim());
  }

  return null;
}

function cleanPronounValue(raw: string): string | null {
  if (raw === DECLINED_BY_USER_SENTINEL) return null;
  // Strip "inferred: " prefix for clean output
  return raw.replace(/^inferred:\s*/i, "");
}

/**
 * Resolve the guardian's display name.
 *
 * Priority:
 *   1. Guardian persona file "Preferred name/reference:" — the
 *      user-editable, actively maintained source of truth.
 *   2. guardianDisplayName (fallback for when the persona file is
 *      missing or empty, e.g. pre-onboarding). Callers pass in
 *      Contact.displayName.
 *   3. DEFAULT_USER_REFERENCE ("my human").
 */
export function resolveGuardianName(
  guardianDisplayName?: string | null,
): string {
  const preferredName = readPreferredNameFromUserMd();
  if (preferredName != null && preferredName !== DECLINED_BY_USER_SENTINEL) {
    return preferredName;
  }

  if (guardianDisplayName && guardianDisplayName.trim().length > 0) {
    return guardianDisplayName.trim();
  }

  return DEFAULT_USER_REFERENCE;
}
