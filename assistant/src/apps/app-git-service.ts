/**
 * Git-backed version control for user-defined apps.
 *
 * App files live under the apps directory (workspace/data/apps/), which is
 * itself tracked by the workspace git repository. Rather than maintaining a
 * second, nested repository inside the apps directory, this module records
 * app history as commits in the workspace repo, scoped to the apps subtree.
 *
 * `commitAppTurnChanges` commits just the apps subtree at each turn boundary
 * (so app edits keep their own per-app commit message), while the workspace
 * turn commit captures everything else. Query methods (history, diff,
 * file-at-version, restore) read/write the same workspace repo, scoping git
 * pathspecs to the apps subtree.
 *
 * Reuses WorkspaceGitService for all git operations (mutex, circuit breaker,
 * lazy init, etc.).
 *
 * NOTE: History queries scope pathspecs by dirName (slug), not appId (UUID).
 * See the 010-app-dir-rename migration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { getAppsDir, resolveAppDir } from "./app-store.js";

const log = getLogger("app-git");

// ---------------------------------------------------------------------------
// Pending commit message — set by app tool executors, consumed at turn boundary
// ---------------------------------------------------------------------------

const pendingAppCommitMessages = new Map<string, string>();

/** Set the commit message for the next app turn-boundary commit. */
export function setAppCommitMessage(
  conversationId: string,
  message: string,
): void {
  pendingAppCommitMessages.set(conversationId, message);
}

/** Consume and clear the pending commit message for a conversation. */
function consumeAppCommitMessage(conversationId: string): string | undefined {
  const msg = pendingAppCommitMessages.get(conversationId);
  pendingAppCommitMessages.delete(conversationId);
  return msg;
}

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
// Workspace-repo scoping helpers
// ---------------------------------------------------------------------------

/**
 * The apps directory expressed as a git pathspec relative to the workspace
 * repo root (e.g. "data/apps"). App commits and history queries scope to this
 * subtree so they only ever touch app files within the shared workspace repo.
 */
function appsSubtree(): string {
  const rel = relative(getWorkspaceDir(), getAppsDir());
  return rel.split(/[\\/]/).join("/");
}

/** git service for the workspace repo (the single repo that tracks apps). */
function workspaceGit() {
  return getWorkspaceGitService(getWorkspaceDir());
}

// ---------------------------------------------------------------------------
// Gitignore management
// ---------------------------------------------------------------------------

/**
 * Patterns excluded from app version tracking.
 * - *.preview -- large base64 preview images
 * - records directories -- user data (form submissions), not app code
 * - dist directories -- regenerable build output; tracking it would churn the
 *   workspace repo on every recompile and pollute app history with bundles
 *
 * Written to a .gitignore inside the apps directory so the workspace repo
 * (which tracks the apps subtree) skips these paths.
 */
const APP_GITIGNORE_RULES = ["*.preview", "*/records/", "*/dist/"];

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
// Commit-message derivation
// ---------------------------------------------------------------------------

/**
 * Derive a fallback commit subject from the staged app files when no explicit
 * change summary was provided. Reads app names from their .json definitions.
 */
function deriveAppCommitSubject(
  appsDir: string,
  subtree: string,
  stagedFiles: string[],
): string {
  const prefix = subtree.endsWith("/") ? subtree : `${subtree}/`;
  const dirNames = [
    ...new Set(
      stagedFiles.map((f) => {
        const rel = f.startsWith(prefix) ? f.slice(prefix.length) : f;
        return rel.split("/")[0].replace(/\.json$/, "");
      }),
    ),
  ].filter(Boolean);

  const appNames = dirNames.map((dirName) => {
    try {
      const jsonPath = join(appsDir, `${dirName}.json`);
      const raw = readFileSync(jsonPath, "utf-8");
      const app = JSON.parse(raw) as { name?: string };
      return app.name || dirName;
    } catch {
      return dirName;
    }
  });

  if (appNames.length === 0) return "update apps";
  if (appNames.length === 1) return `update ${appNames[0]}`;
  if (appNames.length <= 3) return `update ${appNames.join(", ")}`;
  return `update ${appNames.length} apps`;
}

/**
 * Commit app changes at turn boundaries.
 *
 * Commits only the apps subtree of the workspace repo. Only creates a commit
 * if there are actual staged changes under the apps subtree, so multiple
 * mutations within a single turn are batched into one version.
 *
 * Runs before the workspace turn commit so app edits keep their own per-app
 * message; anything the workspace commit later sweeps up is everything else.
 *
 * Fire-and-forget safe: errors are logged but never thrown.
 */
export async function commitAppTurnChanges(
  conversationId: string,
  turnNumber: number,
): Promise<void> {
  // Consume before any work that could throw, so the message doesn't leak
  const changeSummary = consumeAppCommitMessage(conversationId);
  try {
    const appsDir = getAppsDir();
    ensureAppGitignoreRules(appsDir);

    const subtree = appsSubtree();
    const gitService = workspaceGit();

    await gitService.runWithMutex(async (exec) => {
      // Stage only the apps subtree so this commit stays scoped to app files.
      // The workspace repo's index is empty between commits, so committing the
      // index below records exactly these app changes.
      await exec(["add", "--", subtree]);

      // Nothing staged under the apps subtree -> skip (no empty commit).
      // `diff --cached --quiet` exits 0 when clean, 1 when there are changes.
      try {
        await exec(["diff", "--cached", "--quiet", "--", subtree]);
        return;
      } catch (err) {
        if ((err as { code?: number }).code !== 1) throw err;
        // exit 1 => staged app changes exist; proceed to commit.
      }

      // Only needed for the fallback subject; a hiccup here must not abort the
      // commit, so fall back to an empty list (=> "update apps").
      let stagedFiles: string[] = [];
      if (!changeSummary) {
        try {
          const { stdout } = await exec([
            "diff",
            "--cached",
            "--name-only",
            "--",
            subtree,
          ]);
          stagedFiles = stdout
            .split("\n")
            .map((f) => f.trim())
            .filter(Boolean);
        } catch {
          // keep stagedFiles empty
        }
      }

      const subject =
        changeSummary ?? deriveAppCommitSubject(appsDir, subtree, stagedFiles);
      const message =
        `${subject}\n\n` +
        `conversationId: ${JSON.stringify(conversationId)}\n` +
        `turnNumber: ${JSON.stringify(turnNumber)}`;

      await exec(["commit", "-m", message]);
    });
  } catch (err) {
    log.error(
      { err, conversationId, turnNumber },
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
 * Scopes `git log` to files belonging to this app using dirName-based
 * pathspecs within the apps subtree: {subtree}/{dirName}.json, {subtree}/{dirName}/.
 */
export async function getAppHistory(
  appId: string,
  limit = 50,
): Promise<AppVersion[]> {
  validateAppId(appId);
  const { dirName } = resolveAppDir(appId);
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 50, 500));
  const subtree = appsSubtree();
  const gitService = workspaceGit();

  // Format: hash<TAB>unix-seconds<TAB>subject line
  const { stdout } = await gitService.runReadOnlyGit([
    "log",
    `--max-count=${safeLimit}`,
    "--format=%H\t%at\t%s",
    "--",
    `${subtree}/${dirName}.json`,
    `${subtree}/${dirName}/`,
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

  const { dirName } = resolveAppDir(appId);
  const subtree = appsSubtree();
  const gitService = workspaceGit();

  const range = toCommit ? `${fromCommit}..${toCommit}` : `${fromCommit}..HEAD`;
  const { stdout } = await gitService.runReadOnlyGit([
    "diff",
    range,
    "--",
    `${subtree}/${dirName}.json`,
    `${subtree}/${dirName}/`,
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

  const { dirName } = resolveAppDir(appId);
  const subtree = appsSubtree();
  const gitService = workspaceGit();

  const { stdout } = await gitService.runReadOnlyGit([
    "show",
    `${commitHash}:${subtree}/${dirName}/${path}`,
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

  const { dirName } = resolveAppDir(appId);
  const appsDir = getAppsDir();
  const subtree = appsSubtree();
  const gitService = workspaceGit();

  await gitService.runWithMutex(async (exec) => {
    // Checkout the app's files at the target commit.
    // --no-overlay removes files that don't exist at the target commit.
    await exec([
      "checkout",
      commitHash,
      "--no-overlay",
      "--",
      `${subtree}/${dirName}.json`,
      `${subtree}/${dirName}/`,
    ]);

    // Read the app name and refresh updatedAt so the restored app
    // doesn't appear stale in recency ordering.
    let appName = appId;
    const jsonPath = join(appsDir, `${dirName}.json`);
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
    await exec([
      "add",
      "--",
      `${subtree}/${dirName}.json`,
      `${subtree}/${dirName}/`,
    ]);
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
