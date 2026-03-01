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
 * Resolve the user's pronouns from the Onboarding Snapshot section of
 * USER.md.  Returns `null` when the file is missing, the field is empty,
 * or the value is a sentinel like `declined_by_user`.
 *
 * The match is scoped to lines after "## Onboarding Snapshot" to avoid
 * false matches against free-form notes earlier in the file.
 */
export function resolveUserPronouns(): string | null {
  const content = readTextFileSync(getWorkspacePromptPath('USER.md'));
  if (content != null) {
    // Only search within the Onboarding Snapshot section
    const snapshotIdx = content.indexOf('## Onboarding Snapshot');
    const section = snapshotIdx >= 0 ? content.slice(snapshotIdx) : content;
    const match = section.match(/^- Pronouns:[ \t]*(.*)/m);
    if (match && match[1].trim()) {
      const raw = match[1].trim();
      if (raw === 'declined_by_user') return null;
      // Strip "inferred: " prefix for clean output
      return raw.replace(/^inferred:\s*/i, '');
    }
  }

  return null;
}
