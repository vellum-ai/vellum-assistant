import { readTextFileSync } from '../util/fs.js';
import { getWorkspacePromptPath } from '../util/platform.js';

const DEFAULT_USER_REFERENCE = 'my human';

/**
 * Resolve the name/reference the assistant uses when referring to
 * the human it represents in external communications.
 *
 * Reads the "Preferred name/reference:" field from the Onboarding
 * Snapshot section of USER.md.  Falls back to "my human" when the
 * file is missing, unreadable, or the field is empty.
 */
export function resolveUserReference(): string {
  const content = readTextFileSync(getWorkspacePromptPath('USER.md'));
  if (content != null) {
    const match = content.match(/Preferred name\/reference:[ \t]*(.*)/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  return DEFAULT_USER_REFERENCE;
}

/**
 * Resolve the user's pronouns from USER.md.  Returns `null` when the
 * file is missing, the field is empty, or the value is a sentinel like
 * `declined_by_user`.
 *
 * Checks the Onboarding Snapshot section first (structured `- Pronouns:`
 * field), then falls back to a file-wide `Pronouns:` match so that
 * pronouns set or updated outside of onboarding are still picked up.
 */
export function resolveUserPronouns(): string | null {
  const content = readTextFileSync(getWorkspacePromptPath('USER.md'));
  if (content == null) return null;

  // Prefer the structured field in the Onboarding Snapshot section.
  const snapshotIdx = content.indexOf('## Onboarding Snapshot');
  if (snapshotIdx >= 0) {
    const section = content.slice(snapshotIdx);
    const match = section.match(/^- Pronouns:[ \t]*(.*)/m);
    if (match && match[1].trim()) {
      return cleanPronounValue(match[1].trim());
    }
  }

  // Fallback: match anywhere in the file (e.g. set in the Details section
  // after onboarding).
  const fallback = content.match(/Pronouns:[ \t]*(.*)/);
  if (fallback && fallback[1].trim()) {
    return cleanPronounValue(fallback[1].trim());
  }

  return null;
}

function cleanPronounValue(raw: string): string | null {
  if (raw === 'declined_by_user') return null;
  // Strip "inferred: " prefix for clean output
  return raw.replace(/^inferred:\s*/i, '');
}
