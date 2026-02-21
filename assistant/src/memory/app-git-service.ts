/**
 * Git-backed version control for user-defined apps.
 *
 * Initializes a git repository in the apps directory (~/.vellum/apps/) and
 * commits after every app mutation (create, update, delete, file write/edit).
 * Commits are fire-and-forget — they never block the caller.
 *
 * Reuses WorkspaceGitService for all git operations (mutex, circuit breaker,
 * lazy init, etc.).
 */

import { getWorkspaceGitService } from '../workspace/git-service.js';
import { getAppsDir } from './app-store.js';
import { getLogger } from '../util/logger.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const log = getLogger('app-git');

/**
 * Patterns excluded from app version tracking.
 * - *.preview — large base64 preview images
 * - records directories — user data (form submissions), not app code
 */
const APP_GITIGNORE_RULES = [
  '*.preview',
  '*/records/',
];

/**
 * Ensure the apps directory .gitignore contains app-specific exclusion rules.
 * Idempotent: only appends rules that are missing.
 */
function ensureAppGitignoreRules(appsDir: string): void {
  const gitignorePath = join(appsDir, '.gitignore');
  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const missingRules = APP_GITIGNORE_RULES.filter(rule => !content.includes(rule));
  if (missingRules.length > 0) {
    if (content && !content.endsWith('\n')) {
      content += '\n';
    }
    content += missingRules.join('\n') + '\n';
    writeFileSync(gitignorePath, content, 'utf-8');
  }
}

let gitignoreEnsured = false;

/**
 * Commit app changes to the apps git repository.
 *
 * This is fire-and-forget: errors are logged but never thrown.
 * The caller should not await the returned promise unless it needs
 * to guarantee the commit completed (e.g. in tests).
 */
export async function commitAppChange(message: string): Promise<void> {
  try {
    const appsDir = getAppsDir();

    // Ensure .gitignore rules on first call
    if (!gitignoreEnsured) {
      ensureAppGitignoreRules(appsDir);
      gitignoreEnsured = true;
    }

    const gitService = getWorkspaceGitService(appsDir);
    await gitService.commitChanges(message);
  } catch (err) {
    log.error({ err, message }, 'Failed to commit app change');
  }
}

/**
 * @internal Test-only: reset the gitignore-ensured flag.
 */
export function _resetAppGitState(): void {
  gitignoreEnsured = false;
}
