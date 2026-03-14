/**
 * Git-backed version control for user-defined apps.
 *
 * Initializes a git repository in the apps directory (~/.vellum/apps/) and
 * commits after every app mutation (create, update, delete, file write/edit).
 * Commits are fire-and-forget — they never block the caller.
 *
 * Also exposes query methods (history, diff, file-at-version, restore) for
 * browsing and reverting app version history.
 *
 * Reuses WorkspaceGitService for all git operations (mutex, circuit breaker,
 * lazy init, etc.).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { getAppsDir } from "./app-store.js";

const log = getLogger("app-git");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppVersion {
  commitHash: string;
  message: string;
  /** Unix milliseconds */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Gitignore management
// ---------------------------------------------------------------------------

/**
 * Patterns excluded from app version tracking.
 * - *.preview — large base64 preview images
 * - records directories — user data (form submissions), not app code
 */
const APP_GITIGNORE_RULES = ["*.preview", "*/records/"];

/**
 * Ensure the apps directory .gitignore contains app-specific exclusion rules.
 * Idempotent: only appends rules that are missing.
 */
function ensureAppGitignoreRules(appsDir: string): void {
  const gitignorePath = join(appsDir, ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf-8");
  }

  const missingRules = APP_GITIGNORE_RULES.filter(
    (rule) => !content.includes(rule),
  );
  if (missingRules.length > 0) {
    if (content && !content.endsWith("\n")) {
      content += "\n";
    }
    content += missingRules.join("\n") + "\n";
    writeFileSync(gitignorePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Validate that a string looks like a hex commit hash (short or full). */
function validateCommitHash(hash: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
    throw new Error(`Invalid commit hash: ${hash}`);
  }
}

/** Validate an app ID (UUID-like, no path traversal or git pathspec chars). */
function validateAppId(id: string): void {
  if (
    !id ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("..") ||
    id !== id.trim()
  ) {
    throw new Error(`Invalid app ID: ${id}`);
  }
  // Reject git pathspec metacharacters to prevent cross-app operations
  if (/[*?[\]:(]/.test(id)) {
    throw new Error(`Invalid app ID: contains git pathspec characters: ${id}`);
  }
}

/** Validate a relative file path within an app (no traversal). */
function validateRelativePath(path: string): void {
  if (
    !path ||
    path.includes("..") ||
    path.startsWith("/") ||
    path.startsWith("\\")
  ) {
    throw new Error(`Invalid file path: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Initialization & commit
// ---------------------------------------------------------------------------

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
    log.error({ err }, "Failed to initialize app git repo");
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
    log.error({ err, message }, "Failed to commit app change");
  }
}

/**
 * Commit app changes at turn boundaries.
 *
 * Called once per agent turn (after all tool calls complete). Only creates
 * a commit if there are actual changes in the apps directory, so multiple
 * mutations within a single turn are batched into one version.
 *
 * Fire-and-forget safe: errors are logged but never thrown.
 */
export async function commitAppTurnChanges(
  sessionId: string,
  turnNumber: number,
): Promise<void> {
  try {
    const appsDir = getAppsDir();
    ensureAppGitignoreRules(appsDir);

    const gitService = getWorkspaceGitService(appsDir);
    await gitService.commitIfDirty(() => ({
      message: `Turn ${turnNumber}: app changes`,
      metadata: { sessionId, turnNumber },
    }));
  } catch (err) {
    log.error(
      { err, sessionId, turnNumber },
      "Failed to commit app turn changes",
    );
  }
}

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

/**
 * Get the commit history for a specific app.
 *
 * Scopes `git log` to files belonging to this app:
 *   {appId}.json, {appId}/index.html, {appId}/pages/*, etc.
 */
export async function getAppHistory(
  appId: string,
  limit = 50,
): Promise<AppVersion[]> {
  validateAppId(appId);
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 50, 500));
  const appsDir = getAppsDir();
  const gitService = getWorkspaceGitService(appsDir);

  // Format: hash<TAB>unix-seconds<TAB>subject line
  const { stdout } = await gitService.runReadOnlyGit([
    "log",
    `--max-count=${safeLimit}`,
    "--format=%H\t%at\t%s",
    "--",
    `${appId}.json`,
    `${appId}/`,
  ]);

  if (!stdout.trim()) return [];

  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [commitHash, epochSec, ...messageParts] = line.split("\t");
      return {
        commitHash,
        message: messageParts.join("\t"),
        timestamp: parseInt(epochSec, 10) * 1000,
      };
    });
}

/**
 * Get a unified diff for a specific app between two commits.
 * If `toCommit` is omitted, diffs against HEAD.
 */
export async function getAppDiff(
  appId: string,
  fromCommit: string,
  toCommit?: string,
): Promise<string> {
  validateAppId(appId);
  validateCommitHash(fromCommit);
  if (toCommit) validateCommitHash(toCommit);

  const appsDir = getAppsDir();
  const gitService = getWorkspaceGitService(appsDir);

  const range = toCommit ? `${fromCommit}..${toCommit}` : `${fromCommit}..HEAD`;
  const { stdout } = await gitService.runReadOnlyGit([
    "diff",
    range,
    "--",
    `${appId}.json`,
    `${appId}/`,
  ]);

  return stdout;
}

/**
 * Get the contents of a file at a specific commit.
 */
export async function getAppFileAtVersion(
  appId: string,
  path: string,
  commitHash: string,
): Promise<string> {
  validateAppId(appId);
  validateRelativePath(path);
  validateCommitHash(commitHash);

  const appsDir = getAppsDir();
  const gitService = getWorkspaceGitService(appsDir);

  const { stdout } = await gitService.runReadOnlyGit([
    "show",
    `${commitHash}:${appId}/${path}`,
  ]);

  return stdout;
}

/**
 * Restore an app's files to a previous version.
 *
 * Checks out the app's files at `commitHash`, then creates a new commit
 * recording the restore action. Both operations run under the git mutex
 * to prevent concurrent commits from interfering.
 *
 * Uses --no-overlay so files added after the target commit are removed,
 * giving a true restore rather than a merge.
 */
export async function restoreAppVersion(
  appId: string,
  commitHash: string,
): Promise<void> {
  validateAppId(appId);
  validateCommitHash(commitHash);

  const appsDir = getAppsDir();
  const gitService = getWorkspaceGitService(appsDir);

  await gitService.runWithMutex(async (exec) => {
    // Checkout the app's files at the target commit.
    // --no-overlay removes files that don't exist at the target commit.
    await exec([
      "checkout",
      commitHash,
      "--no-overlay",
      "--",
      `${appId}.json`,
      `${appId}/`,
    ]);

    // Read the app name and refresh updatedAt so the restored app
    // doesn't appear stale in recency ordering.
    let appName = appId;
    const jsonPath = join(appsDir, `${appId}.json`);
    if (existsSync(jsonPath)) {
      try {
        const raw = readFileSync(jsonPath, "utf-8");
        const app = JSON.parse(raw);
        if (app.name) appName = app.name;
        app.updatedAt = Date.now();
        writeFileSync(jsonPath, JSON.stringify(app, null, 2) + "\n", "utf-8");
      } catch {
        // fall back to id
      }
    }

    const shortHash = commitHash.substring(0, 7);

    // Stage only this app's files and commit atomically within the same mutex lock
    await exec(["add", "--", `${appId}.json`, `${appId}/`]);
    await exec([
      "commit",
      "-m",
      `Restore app: ${appName} to ${shortHash}`,
      "--allow-empty",
    ]);
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
