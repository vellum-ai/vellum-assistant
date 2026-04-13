import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { getConfig } from "../config/loader.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import { APP_VERSION } from "../version.js";
import {
  appendReleaseBlock,
  filterNewContentBlocks,
  hasReleaseBlock,
} from "./update-bulletin-format.js";
import {
  addActiveRelease,
  getActiveReleases,
  isReleaseCompleted,
  markReleasesCompleted,
  setActiveReleases,
} from "./update-bulletin-state.js";
import { getTemplatePath } from "./update-bulletin-template-path.js";

/**
 * Writes content to a file via a temp-file + rename to prevent partial/truncated
 * writes if the process crashes mid-write.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, content, "utf-8");
    // Resolve symlinks so we rename to the real target, preserving the link.
    // If the symlink is dangling (target doesn't exist), fall back to writing
    // through the symlink path directly — realpathSync throws ENOENT for dangling links.
    let targetPath = filePath;
    try {
      if (lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
        targetPath = realpathSync(filePath);
      }
    } catch (err: unknown) {
      // Dangling symlink — fall back to writing through the symlink path.
      // Only swallow ENOENT (dangling target); re-throw ELOOP, EACCES, I/O faults, etc.
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw err;
      }
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
    throw err;
  }
}

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
  if (!getConfig().updates.enabled) return;

  const currentReleaseId = APP_VERSION;
  const workspacePath = getWorkspacePromptPath("UPDATES.md");

  // --- Deletion completion ---
  // If UPDATES.md was deleted and there are active releases, the assistant
  // has signaled it is done with those updates. Mark them completed.
  const activeReleases = getActiveReleases();
  if (!existsSync(workspacePath) && activeReleases.length > 0) {
    markReleasesCompleted(activeReleases);
    setActiveReleases([]);
  }

  // --- Template materialization ---
  const templatePath = getTemplatePath();
  if (!existsSync(templatePath)) return;

  const rawTemplate = readFileSync(templatePath, "utf-8");
  const templateContent = stripCommentLines(rawTemplate);

  if (!templateContent || templateContent.trim().length === 0) return;

  if (isReleaseCompleted(currentReleaseId)) return;

  if (!existsSync(workspacePath)) {
    const content = appendReleaseBlock("", currentReleaseId, templateContent);
    atomicWriteFileSync(workspacePath, content);
  } else {
    const existing = readFileSync(workspacePath, "utf-8");
    if (!hasReleaseBlock(existing, currentReleaseId)) {
      const contentToAppend = filterNewContentBlocks(
        templateContent,
        existing,
      );
      if (contentToAppend.length > 0) {
        const updated = appendReleaseBlock(
          existing,
          currentReleaseId,
          contentToAppend,
        );
        atomicWriteFileSync(workspacePath, updated);
      }
    }
  }

  addActiveRelease(currentReleaseId);
}
