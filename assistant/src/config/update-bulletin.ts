import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stripCommentLines } from './system-prompt.js';
import { appendReleaseBlock, hasReleaseBlock } from './update-bulletin-format.js';
import {
  addActiveRelease,
  getActiveReleases,
  isReleaseCompleted,
  markReleasesCompleted,
  setActiveReleases,
} from './update-bulletin-state.js';
import { APP_VERSION } from '../version.js';
import { getWorkspacePromptPath } from '../util/platform.js';

/**
 * Materializes the current release's update bulletin on startup.
 *
 * First checks for deletion-completion: if the workspace UPDATES.md was
 * deleted while releases were active, those releases are marked completed
 * (the assistant signals "done" by deleting the file).
 *
 * Then reads the bundled UPDATES.md template, strips comment lines, and
 * appends a release block to the workspace UPDATES.md if one doesn't
 * already exist for this version. Skips completed releases entirely.
 */
export function syncUpdateBulletinOnStartup(): void {
  const currentReleaseId = APP_VERSION;
  const workspacePath = getWorkspacePromptPath('UPDATES.md');

  // --- Deletion completion ---
  // If UPDATES.md was deleted and there are active releases, the assistant
  // has signaled it is done with those updates. Mark them completed.
  const activeReleases = getActiveReleases();
  if (!existsSync(workspacePath) && activeReleases.length > 0) {
    markReleasesCompleted(activeReleases);
    setActiveReleases([]);
  }

  // --- Template materialization ---
  const templatePath = join(import.meta.dirname ?? __dirname, 'templates', 'UPDATES.md');
  if (!existsSync(templatePath)) return;

  const rawTemplate = readFileSync(templatePath, 'utf-8');
  const templateContent = stripCommentLines(rawTemplate);

  if (!templateContent || templateContent.trim().length === 0) return;

  if (isReleaseCompleted(currentReleaseId)) return;

  if (!existsSync(workspacePath)) {
    const content = appendReleaseBlock('', currentReleaseId, templateContent);
    writeFileSync(workspacePath, content, 'utf-8');
  } else {
    const existing = readFileSync(workspacePath, 'utf-8');
    if (!hasReleaseBlock(existing, currentReleaseId)) {
      const updated = appendReleaseBlock(existing, currentReleaseId, templateContent);
      writeFileSync(workspacePath, updated, 'utf-8');
    }
  }

  addActiveRelease(currentReleaseId);
}
