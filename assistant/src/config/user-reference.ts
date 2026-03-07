import { readTextFileSync } from "../util/fs.js";
import { getWorkspacePromptPath } from "../util/platform.js";

export const DEFAULT_USER_REFERENCE = "my human";
export const DECLINED_BY_USER_SENTINEL = "declined_by_user";

/**
 * Read the raw "Preferred name/reference:" value from USER.md.
 * Returns the trimmed value when present, or `null` when the file
 * is missing, unreadable, or the field is empty.
 */
function readPreferredNameFromUserMd(): string | null {
  const content = readTextFileSync(getWorkspacePromptPath("USER.md"));
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
 * Reads the "Preferred name/reference:" field from the Onboarding
 * Snapshot section of USER.md.  Falls back to "my human" when the
 * file is missing, unreadable, or the field is empty.
 */
export function resolveUserReference(): string {
  const preferredName = readPreferredNameFromUserMd();
  if (preferredName != null && preferredName !== DECLINED_BY_USER_SENTINEL) {
    return preferredName;
  }
  return DEFAULT_USER_REFERENCE;
}

/**
 * Resolve the user's pronouns from USER.md.  Returns `null` when the
 * file is missing, the field is empty, or the value is a sentinel like
 * `declined_by_user`.
 *
 * Priority order:
 *   1. Any `Pronouns:` line outside the Onboarding Snapshot section
 *      (explicit user update post-onboarding takes precedence).
 *   2. The structured `- Pronouns:` field inside the Onboarding Snapshot.
 */
export function resolveUserPronouns(): string | null {
  const content = readTextFileSync(getWorkspacePromptPath("USER.md"));
  if (content == null) return null;

  const snapshotIdx = content.indexOf("## Onboarding Snapshot");

  // 1. Check for a Pronouns line outside the Onboarding Snapshot section.
  //    This represents an explicit post-onboarding update and takes priority.
  if (snapshotIdx >= 0) {
    const beforeSnapshot = content.slice(0, snapshotIdx);
    const outsideMatch = beforeSnapshot.match(/Pronouns:[ \t]*(.*)/);
    if (outsideMatch && outsideMatch[1].trim()) {
      return cleanPronounValue(outsideMatch[1].trim());
    }
  }

  // 2. Fall back to the structured field in the Onboarding Snapshot.
  if (snapshotIdx >= 0) {
    const section = content.slice(snapshotIdx);
    const match = section.match(/^- Pronouns:[ \t]*(.*)/m);
    if (match && match[1].trim()) {
      return cleanPronounValue(match[1].trim());
    }
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
 *   1. USER.md "Preferred name/reference:" — the user-editable, actively
 *      maintained source of truth.
 *   2. guardianDisplayName (fallback for when USER.md is missing or empty,
 *      e.g. pre-onboarding). Callers pass in Contact.displayName.
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
