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

/**
 * Eagerly initialize the app git repo so that the "Initial commit" is
 * created before any app files are written. Without this, the first
 * mutation's files get absorbed into WorkspaceGitService's bootstrap
 * commit and the "Create app: ..." commit ends up empty.
 *
 * Safe to call multiple times — ensureInitialized() is idempotent.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function initAppGit(): Promise<void> {
  try {
    const appsDir = getAppsDir();
    ensureAppGitignoreRules(appsDir);
    const gitService = getWorkspaceGitService(appsDir);
    await gitService.ensureInitialized();
  } catch (err) {
    log.error({ err }, 'Failed to initialize app git repo');
  }
}

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

    // Re-check .gitignore rules every call in case the apps dir was
    // recreated while the process was running.
    ensureAppGitignoreRules(appsDir);

    const gitService = getWorkspaceGitService(appsDir);
    await gitService.commitChanges(message);
  } catch (err) {
    log.error({ err, message }, 'Failed to commit app change');
  }
}

/**
 * @internal Test-only: reset module state.
 */
export function _resetAppGitState(): void {
  // no-op — kept for test API compatibility
}
