import { readFileSync, existsSync } from 'node:fs';
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
  const userPath = getWorkspacePromptPath('USER.md');
  if (!existsSync(userPath)) return DEFAULT_USER_REFERENCE;

  try {
    const content = readFileSync(userPath, 'utf-8');
    const match = content.match(/Preferred name\/reference:\s*(.+)/);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  } catch {
    // Fallback on any read error
  }

  return DEFAULT_USER_REFERENCE;
}
