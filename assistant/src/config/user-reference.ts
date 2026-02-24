import { getWorkspacePromptPath } from '../util/platform.js';
import { readTextFileSync } from '../util/fs.js';

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
  if (content !== null) {
    const match = content.match(/Preferred name\/reference:[ \t]*(.*)/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  return DEFAULT_USER_REFERENCE;
}
