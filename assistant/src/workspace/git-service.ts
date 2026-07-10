import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { Mutex } from "../util/mutex.js";
import { PromiseGuard } from "../util/promise-guard.js";

const execFileAsync = promisify(execFile);
const log = getLogger("workspace-git");

/**
 * Build a clean env for git subprocesses.
 *
 * Strips all GIT_* env vars (e.g. GIT_DIR, GIT_WORK_TREE) that CI runners
 * or parent processes may set, then adds GIT_CEILING_DIRECTORIES to prevent
 * walking up to a parent repo.
 *
 * On macOS, augments PATH with common binary directories so the real git
 * binary is found even when the daemon is launched from a .app bundle with
 * a minimal PATH. Without this, the macOS /usr/bin/git shim triggers an
 * "Install Command Line Developer Tools" popup on every git invocation.
 */
function cleanGitEnv(workspaceDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CEILING_DIRECTORIES = workspaceDir;

  const home = process.env.HOME ?? "";
  const extraDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
  ];
  const currentPath = env.PATH ?? "";
  const pathDirs = currentPath.split(":");
  const missing = extraDirs.filter((d) => !pathDirs.includes(d));
  if (missing.length > 0) {
    env.PATH = [...missing, currentPath].filter(Boolean).join(":");
  }

  return env;
}

/**
 * Patterns excluded from workspace git tracking.
 * These are written to .gitignore on init and appended to existing .gitignore files.
 */
const WORKSPACE_GITIGNORE_RULES = [
  // Runtime state directories
  "data/db/",
  "data/qdrant/",
  "data/monitoring/",
  // App files under data/apps/ are tracked as ordinary workspace state, but
  // their user data (form submissions), build output, and large preview blobs
  // are not worth versioning and would churn the workspace repo.
  "data/apps/*/records/",
  "data/apps/*/dist/",
  "data/apps/*.preview",
  // Runtime-managed installs and caches — large and restorable
  "/embedding-models/",
  "/external/",
  "/bin/",
  "/plugins-data/",
  "node_modules/",
  "__pycache__/",
  ".venv/",
  // Logs and process state
  "logs/",
  "*.log",
  "*.jsonl",
  "*.sock",
  "*.pid",
  "daemon-startup.lock",
  "session-token",
  // Databases (covers sidecar -journal/-wal/-shm files)
  "*.sqlite*",
  "*.db",
  "*.db-*",
  // OS junk
  ".DS_Store",
  // Archives and disk images
  "*.zip",
  "*.tar",
  "*.gz",
  "*.tgz",
  "*.bz2",
  "*.xz",
  "*.7z",
  "*.rar",
  "*.dmg",
  "*.iso",
  // Images (svg is text-based and stays tracked)
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.heic",
  "*.bmp",
  "*.tiff",
  // Audio and video
  "*.mp3",
  "*.wav",
  "*.m4a",
  "*.flac",
  "*.ogg",
  "*.mp4",
  "*.mov",
  "*.avi",
  "*.mkv",
  "*.webm",
  // Documents and model weights
  "*.pdf",
  "*.gguf",
  "*.onnx",
  "*.safetensors",
  "*.pt",
  "*.pth",
  // Canonical user state re-included despite the extension rules above.
  // Must stay after the extension rules: last matching pattern wins.
  // (Not a broad !data/apps/** — that would also re-include dist/.)
  // conversations/ holds the messages.jsonl disk view that DB recovery
  // rebuilds from, so it survives the *.jsonl rule.
  "!data/avatar/**",
  "!data/sounds/**",
  "!data/apps/*/icon.png",
  "!conversations/**",
];

/** Default identity for automated workspace commits. */
const DEFAULT_GIT_NAME = "Vellum Assistant";
// generic-examples:ignore-next-line — reason: real daemon commit identity, not an example
const DEFAULT_GIT_EMAIL = "assistant@vellum.ai";

const NULL_GIT_OID = "0000000000000000000000000000000000000000";

/**
 * Git's well-known empty tree object id, used as the diff/reset base when
 * HEAD does not exist yet (unborn branch, before the initial commit).
 */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_MAX_FILE_SIZE_BYTES = 256000;

/**
 * History compaction keeps commits younger than this; older ones are
 * squashed into a scrubbed base commit so oversized blobs referenced only
 * by old history can be pruned from .git.
 */
const HISTORY_RETENTION_DAYS = 7;

/** Timeout for one-shot history rewrite / gc operations. */
const HISTORY_COMPACTION_TIMEOUT_MS = 10 * 60_000;

/**
 * Delay between init and the first compaction attempt, so boot-time
 * foreground work (first turn commit, status reads) never queues on the
 * git mutex behind a detection scan or rewrite.
 */
const HISTORY_COMPACTION_INITIAL_DELAY_MS = 60_000;

/** Lower bound between compaction retries while blobs wait out retention. */
const HISTORY_COMPACTION_MIN_RETRY_MS = 60 * 60_000;

const WORKSPACE_BRANCH_GUARD_HOOK = `#!/bin/sh
set -eu

state="\${1:-}"
if [ "$state" != "prepared" ]; then
  exit 0
fi

while read -r _old_oid new_oid refname; do
  case "$refname" in
    refs/heads/main)
      ;;
    refs/heads/*)
      if [ "$new_oid" = "${NULL_GIT_OID}" ]; then
        continue
      fi

      cat >&2 <<MSG
Blocked: assistant workspace git branches are disabled.

Use the workspace main branch for assistant state. Create task branches only in
external product repositories or dedicated worktrees.

Rejected ref update: $refname
MSG
      exit 1
      ;;
  esac
done

exit 0
`;

/**
 * Parse NUL-terminated `git status --porcelain -z` output into status/path
 * pairs. NUL termination is required so paths with special characters
 * (non-ASCII, quotes, newlines) arrive verbatim instead of C-style quoted.
 * A rename/copy record is followed by a bare origin-path entry, which is
 * skipped.
 */
function parsePorcelainZ(
  stdout: string,
): Array<{ status: string; path: string }> {
  const entries = stdout.split("\0");
  const parsed: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (entry.length < 4) {
      continue;
    }
    const status = entry.substring(0, 2);
    parsed.push({ status, path: entry.substring(3) });
    if (status[0] === "R" || status[0] === "C") {
      i++;
    }
  }
  return parsed;
}

/** Properties added by Node's child_process errors. */
interface ExecError extends Error {
  killed?: boolean;
  signal?: string;
  code?: string | number;
}

interface GitCommitMetadata {
  /** Optional metadata to include in the commit message or as git notes */
  [key: string]: unknown;
}

interface GitStatus {
  /** Files staged for commit */
  staged: string[];
  /** Files modified but not staged */
  modified: string[];
  /** Untracked files */
  untracked: string[];
  /** True if the working directory is clean */
  clean: boolean;
}

/**
 * Git service for workspace change management.
 *
 * Provides git-backed tracking of workspace state with lazy initialization.
 * Each workspace gets its own git repository initialized on first write.
 *
 * Key features:
 * - Lazy initialization: git repo created only when needed
 * - Mutex-protected operations: prevents concurrent git command conflicts
 * - Handles both new and existing workspaces transparently
 * - Synchronous initial commit within mutex to prevent races
 * - Size guard: files over workspaceGit.maxFileSizeBytes never enter commits
 */
export class WorkspaceGitService {
  private readonly workspaceDir: string;
  private readonly mutex: Mutex;
  private initialized = false;
  private readonly initGuard = new PromiseGuard<void>();
  private consecutiveFailures = 0;
  private nextAllowedAttemptMs = 0;
  private initConsecutiveFailures = 0;
  private initNextAllowedAttemptMs = 0;
  /** Oversized paths already logged, to avoid re-warning every commit cycle. */
  private readonly warnedOversizedPaths = new Set<string>();
  private historyCompactionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.mutex = new Mutex();
  }

  /**
   * Check if the circuit breaker is open (too many recent failures).
   * When open, commit attempts are skipped until the backoff window expires.
   */
  private isBreakerOpen(): boolean {
    if (this.consecutiveFailures === 0) return false;
    return Date.now() < this.nextAllowedAttemptMs;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(
        {
          workspaceDir: this.workspaceDir,
          previousFailures: this.consecutiveFailures,
        },
        "Circuit breaker closed: commit succeeded after failures",
      );
    }
    this.consecutiveFailures = 0;
    this.nextAllowedAttemptMs = 0;
  }

  private recordFailure(): void {
    const config = getConfig();
    const failureBackoffBaseMs =
      config.workspaceGit?.failureBackoffBaseMs ?? 2000;
    const failureBackoffMaxMs =
      config.workspaceGit?.failureBackoffMaxMs ?? 60000;
    this.consecutiveFailures++;
    const delay = Math.min(
      failureBackoffBaseMs * Math.pow(2, this.consecutiveFailures - 1),
      failureBackoffMaxMs,
    );
    this.nextAllowedAttemptMs = Date.now() + delay;
    log.warn(
      {
        workspaceDir: this.workspaceDir,
        consecutiveFailures: this.consecutiveFailures,
        backoffMs: delay,
      },
      "Circuit breaker opened: commit failed, backing off",
    );
  }

  /**
   * Check if the init circuit breaker is open (too many recent init failures).
   * When open, init attempts are skipped until the backoff window expires.
   */
  private isInitBreakerOpen(): boolean {
    if (this.initConsecutiveFailures < 2) return false;
    return Date.now() < this.initNextAllowedAttemptMs;
  }

  private recordInitSuccess(): void {
    if (this.initConsecutiveFailures > 0) {
      log.info(
        {
          workspaceDir: this.workspaceDir,
          previousFailures: this.initConsecutiveFailures,
        },
        "Init circuit breaker closed: initialization succeeded after failures",
      );
    }
    this.initConsecutiveFailures = 0;
    this.initNextAllowedAttemptMs = 0;
  }

  private recordInitFailure(): void {
    const config = getConfig();
    const failureBackoffBaseMs =
      config.workspaceGit?.failureBackoffBaseMs ?? 2000;
    const failureBackoffMaxMs =
      config.workspaceGit?.failureBackoffMaxMs ?? 60000;
    this.initConsecutiveFailures++;
    const delay = Math.min(
      failureBackoffBaseMs * Math.pow(2, this.initConsecutiveFailures - 1),
      failureBackoffMaxMs,
    );
    this.initNextAllowedAttemptMs = Date.now() + delay;
    log.warn(
      {
        workspaceDir: this.workspaceDir,
        consecutiveFailures: this.initConsecutiveFailures,
        backoffMs: delay,
      },
      "Init circuit breaker opened: initialization failed, backing off",
    );
  }

  /**
   * Remove `.git/index.lock` if it exists and no external process holds it.
   *
   * This method is always called inside the mutex, so no git operation from
   * our code can be concurrently holding the lock. However, an external git
   * process (user running `git add`, IDE tooling, etc.) could legitimately
   * hold the lock. We use `lsof` to check — if any process has the file
   * open, we leave it alone. If no process holds it, it's stale (crashed
   * process) and safe to remove.
   */
  private cleanStaleLockFile(): void {
    const lockPath = join(this.workspaceDir, ".git", "index.lock");
    if (!existsSync(lockPath)) {
      return;
    }

    try {
      const result = spawnSync("lsof", ["-t", lockPath], {
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status === 0 && result.stdout?.length > 0) {
        log.debug("index.lock held by an active process, skipping removal");
        return;
      }
    } catch {
      // lsof unavailable or errored — fall through to remove.
      // On platforms without lsof this degrades to unconditional removal,
      // which is the same as the previous behavior.
    }

    try {
      unlinkSync(lockPath);
      log.debug("Removed stale index.lock");
    } catch {
      // File was removed between check and unlink, or can't be removed — move on.
    }
  }

  /**
   * Ensure the git repository is initialized.
   * Idempotent: safe to call multiple times.
   *
   * If .git doesn't exist:
   * 1. Run git init -b main
   * 2. Create .gitignore
   * 3. Set git identity
   * 4. Stage all files and create initial commit
   *
   * The initial commit is created synchronously within the mutex lock
   * to prevent races with the first commitChanges() call.
   */
  async ensureInitialized(): Promise<void> {
    // Fast path: already initialized
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initGuard.active) {
      return this.initGuard.run(() => {
        throw new Error("unreachable");
      });
    }

    // Circuit breaker: skip if multiple recent init attempts have been failing.
    // Checked AFTER initGuard.active so callers waiting on in-progress init aren't
    // blocked, and only activates after 2+ consecutive failures so that a
    // single transient failure allows immediate retry.
    if (this.isInitBreakerOpen()) {
      throw new Error(
        "Init circuit breaker open: backing off after repeated failures",
      );
    }

    return this.initGuard.run(
      () =>
        this.mutex.withLock(async () => {
          // Double-check after acquiring lock
          if (this.initialized) {
            return;
          }

          const gitDir = join(this.workspaceDir, ".git");

          // Clean up stale lock files before any git operations.
          if (existsSync(gitDir)) {
            this.cleanStaleLockFile();
          }

          if (existsSync(gitDir)) {
            // Validate existing repo is not corrupted before marking as ready.
            // A corrupted .git directory (e.g. missing HEAD) would cause all
            // subsequent git operations to fail with confusing errors.
            try {
              await this.execGit(["rev-parse", "--git-dir"]);
            } catch (err: unknown) {
              // Distinguish transient failures from genuine corruption.
              // Transient errors (timeouts, permissions, missing git binary)
              // should NOT destroy .git — they will resolve on retry via
              // the guard clearing logic.
              const errMsg = err instanceof Error ? err.message : String(err);
              const execErr = err as ExecError;
              const isTimeout =
                execErr.killed === true ||
                execErr.signal === "SIGTERM" ||
                errMsg.includes("SIGTERM") ||
                errMsg.includes("timed out");
              const isPermission =
                execErr.code === "EACCES" ||
                errMsg.includes("EACCES") ||
                errMsg.toLowerCase().includes("permission denied");
              const isMissingBinary =
                execErr.code === "ENOENT" || errMsg.includes("ENOENT");

              if (isTimeout || isPermission || isMissingBinary) {
                // Re-throw so initialization fails gracefully without
                // destroying valid git history.
                throw err;
              }

              // Genuine corruption (e.g. missing HEAD, broken refs) —
              // remove corrupted .git and fall through to full init below.
              log.warn(
                { workspaceDir: this.workspaceDir, err: errMsg },
                "Corrupted .git directory detected; reinitializing",
              );
              const { rmSync } = await import("node:fs");
              rmSync(gitDir, { recursive: true, force: true });
            }

            if (existsSync(gitDir)) {
              // .git exists and passed the corruption check, but we still
              // need to verify that at least one commit exists. A partial
              // init (e.g. git init succeeded but the initial commit failed)
              // leaves .git present with an undefined HEAD. In that case,
              // fall through to the initial commit logic below.
              let headExists = false;
              try {
                await this.execGit(["rev-parse", "HEAD"]);
                headExists = true;
              } catch (err: unknown) {
                // Distinguish transient failures from genuine "no commits".
                // Transient errors (timeouts, permissions, missing git binary)
                // should NOT fall through to re-initialization — they will
                // resolve on retry via the guard clearing logic.
                const errMsg = err instanceof Error ? err.message : String(err);
                const execErr = err as ExecError;
                const isTimeout =
                  execErr.killed === true ||
                  execErr.signal === "SIGTERM" ||
                  errMsg.includes("SIGTERM") ||
                  errMsg.includes("timed out");
                const isPermission =
                  execErr.code === "EACCES" ||
                  errMsg.includes("EACCES") ||
                  errMsg.toLowerCase().includes("permission denied");
                const isMissingBinary =
                  execErr.code === "ENOENT" || errMsg.includes("ENOENT");

                if (isTimeout || isPermission || isMissingBinary) {
                  throw err;
                }
                // Genuine "no commits" (unborn HEAD) — fall through to
                // create the initial commit.
              }

              if (headExists) {
                // HEAD resolves — repo is fully initialized.
                // Run normalization for existing repos that may have been
                // created before these helpers existed, or by external tools.
                // These calls are OUTSIDE the rev-parse try/catch so that
                // normalization errors are not misclassified as "no commits".
                this.ensureBranchGuardHookLocked();
                await this.ensureCommitIdentityLocked();
                await this.ensureBranchGuardConfigLocked();
                await this.ensureOnMainLocked();
                // After the main switch: ensureOnMainLocked can discard
                // local changes, which would wipe appended gitignore rules
                // and staged deletions alike.
                this.ensureGitignoreRulesLocked();
                await this.untrackIgnoredFilesLocked();
                await this.untrackOversizedFilesLocked();
                this.initialized = true;
                this.recordInitSuccess();
                this.scheduleHistoryCompaction();
                return;
              }
            }
            // Otherwise fall through to reinitialize / create initial commit
          }

          // Initialize new git repository
          await this.execGit(["init", "-b", "main"]);

          // Run normalization (identity + branch enforcement + gitignore).
          // For fresh `git init -b main` the branch is already main, but
          // in the corruption-recovery path we fall through here after
          // removing .git, so branch enforcement is still useful.
          this.ensureBranchGuardHookLocked();
          await this.ensureCommitIdentityLocked();
          await this.ensureBranchGuardConfigLocked();
          await this.ensureOnMainLocked();
          // After the main switch (see above). A partial init (`.git`
          // exists, no commit) can carry staged now-ignored paths from an
          // interrupted `git add -A`; untracking must precede the initial
          // commit.
          this.ensureGitignoreRulesLocked();
          await this.untrackIgnoredFilesLocked();

          // Create initial commit synchronously within the lock to prevent
          // races with the first commitChanges() call. Without this, the
          // initial commit could run concurrently and consume edits meant
          // for the first user-requested commit.
          const status = await this.getStatusInternal();
          const autoCreatedInitFiles = new Set([
            ".gitignore",
            ".githooks/",
            ".githooks/reference-transaction",
          ]);
          const hasExistingFiles = status.untracked.some(
            (f) => !autoCreatedInitFiles.has(f),
          );

          await this.stageAllLocked();

          const message = hasExistingFiles
            ? "Initial commit: migrated existing workspace"
            : "Initial commit: new workspace";

          await this.execGit(
            this.buildSafeCommitArgs(["-m", message, "--allow-empty"]),
          );

          this.initialized = true;
          this.recordInitSuccess();
        }),
      () => this.recordInitFailure(),
    );
  }

  /**
   * Commit all changes in the workspace.
   *
   * @param message - Commit message describing the changes
   * @param metadata - Optional metadata (currently stored in commit message)
   */
  async commitChanges(
    message: string,
    metadata?: GitCommitMetadata,
  ): Promise<void> {
    await this.ensureInitialized();

    await this.mutex.withLock(async () => {
      this.cleanStaleLockFile();

      // Stage all changes (minus oversized files)
      await this.stageAllLocked();

      // Build commit message with metadata if provided
      let fullMessage = message;
      if (metadata && Object.keys(metadata).length > 0) {
        fullMessage +=
          "\n\n" +
          Object.entries(metadata)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join("\n");
      }

      // Commit (will succeed even if no changes)
      await this.execGit(
        this.buildSafeCommitArgs(["-m", fullMessage, "--allow-empty"]),
      );
    });
  }

  /**
   * Atomically check for uncommitted changes and commit if the caller decides to.
   *
   * The status check, staging, and commit all happen within a single mutex lock,
   * eliminating the TOCTOU race that exists when calling getStatus() and
   * commitChanges() separately.
   *
   * @param decide - Called with the current status. Return an object with `message`
   *   (and optional `metadata`) to commit, or `null` to skip.
   * @param options.bypassBreaker - Skip circuit breaker checks (used for shutdown commits).
   * @param options.deadlineMs - Absolute timestamp (Date.now()) after which the commit
   *   should be skipped. Checked before lock acquisition, after lock acquisition, and
   *   before git add/commit to prevent stale queued attempts from doing expensive work.
   * @returns Whether a commit was created and the status at check time.
   */
  async commitIfDirty(
    decide: (
      status: GitStatus,
    ) => { message: string; metadata?: GitCommitMetadata } | null,
    options?: { bypassBreaker?: boolean; deadlineMs?: number },
  ): Promise<{ committed: boolean; status: GitStatus }> {
    const emptyStatus: GitStatus = {
      staged: [],
      modified: [],
      untracked: [],
      clean: false,
    };

    // Circuit breaker: skip expensive git work if recent attempts have been failing.
    // Shutdown commits bypass the breaker because the process is about to exit and
    // this is the last chance to persist workspace state.
    if (!options?.bypassBreaker && this.isBreakerOpen()) {
      log.debug(
        {
          workspaceDir: this.workspaceDir,
          consecutiveFailures: this.consecutiveFailures,
        },
        "Circuit breaker open, skipping commit attempt",
      );
      return { committed: false, status: emptyStatus };
    }

    // Deadline fast-path: bail before acquiring the lock if already past deadline.
    if (isDeadlineExpired(options?.deadlineMs)) {
      log.debug(
        { workspaceDir: this.workspaceDir },
        "Deadline expired before lock acquisition, skipping commit",
      );
      return { committed: false, status: emptyStatus };
    }

    await this.ensureInitialized();

    try {
      const result = await this.mutex.withLock(async () => {
        this.cleanStaleLockFile();

        // Re-check breaker under lock: a queued call that started before the
        // breaker opened should not proceed with expensive git work now that
        // the breaker is open.
        if (!options?.bypassBreaker && this.isBreakerOpen()) {
          log.debug(
            {
              workspaceDir: this.workspaceDir,
              consecutiveFailures: this.consecutiveFailures,
            },
            "Circuit breaker open after lock acquisition, skipping commit",
          );
          return {
            committed: false,
            status: emptyStatus,
            didRunGit: false as const,
          };
        }

        // Re-check deadline after lock acquisition: the call may have waited
        // in the mutex queue past its deadline.
        if (isDeadlineExpired(options?.deadlineMs)) {
          log.debug(
            { workspaceDir: this.workspaceDir },
            "Deadline expired after lock acquisition, skipping commit",
          );
          return {
            committed: false,
            status: emptyStatus,
            didRunGit: false as const,
          };
        }

        // A status read can fail transiently (e.g. an oversized working tree
        // or a momentary git error). Treat that as "no commit this tick"
        // rather than a hard failure: returning didRunGit=false leaves the
        // circuit breaker untouched so auto-commit/heartbeat keeps running
        // instead of tripping dead until restart.
        let status: GitStatus;
        try {
          status = await this.getStatusInternal();
        } catch (statusErr) {
          log.warn(
            { err: statusErr, workspaceDir: this.workspaceDir },
            "Skipping commit cycle: git status read failed",
          );
          return {
            committed: false,
            status: emptyStatus,
            didRunGit: false as const,
          };
        }
        if (status.clean) {
          return { committed: false, status, didRunGit: true as const };
        }

        const decision = decide(status);
        if (!decision) {
          return { committed: false, status, didRunGit: true as const };
        }

        // Check deadline before expensive git add/commit operations.
        if (isDeadlineExpired(options?.deadlineMs)) {
          log.debug(
            { workspaceDir: this.workspaceDir },
            "Deadline expired before git add/commit, skipping commit",
          );
          return { committed: false, status, didRunGit: true as const };
        }

        await this.stageAllLocked();

        // Verify something was actually staged. Another service instance
        // (or external process) could have committed between our status
        // check and the add, leaving the index clean.
        try {
          await this.execGit(["diff", "--cached", "--quiet"]);
          // Exit code 0 means nothing staged — nothing to commit
          return { committed: false, status, didRunGit: true as const };
        } catch (err) {
          // git diff --cached --quiet exits with code 1 when there are staged changes.
          // Any other error (timeout, permission, etc.) should be treated as a failure.
          const execErr = err as ExecError;
          if (execErr.code !== 1) {
            throw err;
          }
          // Exit code 1 = staged changes exist — proceed with commit
        }

        let fullMessage = decision.message;
        if (decision.metadata && Object.keys(decision.metadata).length > 0) {
          fullMessage +=
            "\n\n" +
            Object.entries(decision.metadata)
              .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
              .join("\n");
        }

        await this.execGit(this.buildSafeCommitArgs(["-m", fullMessage]));
        return { committed: true, status, didRunGit: true as const };
      });
      if (result.didRunGit) {
        this.recordSuccess();
      }
      return { committed: result.committed, status: result.status };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Get the current git status of the workspace.
   *
   * @returns Status information about staged, modified, and untracked files
   */
  async getStatus(): Promise<GitStatus> {
    await this.ensureInitialized();
    return this.mutex.withLock(() => this.getStatusInternal());
  }

  /**
   * Internal status implementation (must be called with lock held).
   */
  private async getStatusInternal(): Promise<GitStatus> {
    // Streamed via spawn (not execFile) so an oversized status from a bloated
    // working tree cannot exceed Node's default 1 MB maxBuffer and fail.
    // --untracked-files=all enumerates files inside untracked directories
    // instead of a "dir/" placeholder, so the per-file size filter below can
    // see them — otherwise a directory holding only oversized files would
    // keep the workspace dirty forever. -z delivers special-character paths
    // verbatim (unquoted) for the same reason.
    const { stdout } = await this.execGitStreaming([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "-z",
    ]);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const { status, path: file } of parsePorcelainZ(stdout)) {
      // First character is staged status, second is working tree status
      const stagedStatus = status[0];
      const workingStatus = status[1];

      if (stagedStatus !== " " && stagedStatus !== "?") {
        staged.push(file);
      }
      // Oversized files are invisible to auto-commit: they can never be
      // committed (stageAllLocked unstages them), so reporting them here
      // would keep the workspace permanently dirty and make every turn /
      // heartbeat cycle re-attempt a commit that stages nothing.
      if (workingStatus === "M" || workingStatus === "D") {
        if (!this.isOversized(file)) {
          modified.push(file);
        }
      }
      if (status === "??" && !this.isOversized(file)) {
        untracked.push(file);
      }
    }

    return {
      staged,
      modified,
      untracked,
      clean:
        staged.length === 0 && modified.length === 0 && untracked.length === 0,
    };
  }

  private maxFileSizeBytes(): number {
    return (
      getConfig().workspaceGit?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
    );
  }

  /**
   * Working-tree size check for a repo-relative path. Uses lstat so a
   * symlink is measured by the link itself, not its target. Missing or
   * unreadable paths (deletions, races) are treated as not oversized.
   */
  private isOversized(relPath: string): boolean {
    try {
      const stats = lstatSync(join(this.workspaceDir, relPath));
      return stats.isFile() && stats.size > this.maxFileSizeBytes();
    } catch {
      return false;
    }
  }

  /**
   * Resolve the base for staged-change comparisons: HEAD when it exists,
   * the empty tree on an unborn branch. Transient git errors propagate so
   * callers abort instead of diffing/resetting against the wrong base.
   */
  private async resolveStagedDiffBaseLocked(): Promise<string> {
    try {
      await this.execGit(["rev-parse", "--quiet", "--verify", "HEAD"]);
      return "HEAD";
    } catch (err) {
      if ((err as ExecError).code === 1) {
        return EMPTY_TREE_OID;
      }
      throw err;
    }
  }

  /**
   * Drop tracked files whose on-disk size exceeds
   * workspaceGit.maxFileSizeBytes from the index (working tree untouched) —
   * files committed before the size guard existed, or before a limit
   * decrease. Blobs referenced by older commits remain in .git. Like
   * {@link untrackIgnoredFilesLocked}, the staged deletions ride along with
   * the next commit and failures are logged, never blocking init. Must be
   * called with the mutex lock held.
   */
  private async untrackOversizedFilesLocked(): Promise<void> {
    try {
      const tracked = await this.execGitStreaming(["ls-files", "-z"]);
      const oversized = tracked.stdout
        .split("\0")
        .filter((p) => p.length > 0 && this.isOversized(p));
      if (oversized.length === 0) {
        return;
      }

      await this.execGitStreaming(
        [
          "rm",
          "--cached",
          "-q",
          "--ignore-unmatch",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { input: oversized.map((p) => `:(literal)${p}`).join("\0") },
      );

      for (const p of oversized) {
        this.warnedOversizedPaths.add(p);
      }
      log.warn(
        {
          workspaceDir: this.workspaceDir,
          files: oversized,
          maxFileSizeBytes: this.maxFileSizeBytes(),
        },
        "Untracked oversized files from workspace index",
      );
    } catch (err) {
      log.warn({ err }, "Failed to untrack oversized files");
    }
  }

  /**
   * Schedule a background history compaction attempt. The delay keeps the
   * run off the git mutex during boot, so foreground commits and status
   * reads are never queued behind a rewrite. When blobs exist but all
   * history is still within retention, the attempt reschedules itself for
   * when the oldest commit ages past the cutoff. Best-effort like the
   * untrack sweeps: failures are logged and never affect commits.
   */
  private scheduleHistoryCompaction(
    delayMs = HISTORY_COMPACTION_INITIAL_DELAY_MS,
  ): void {
    if (this.historyCompactionTimer) {
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        let retryAfterMs: number | undefined;
        try {
          const result = await this.compactHistoryNow();
          retryAfterMs = result.retryAfterMs;
        } catch (err) {
          log.warn(
            { err, workspaceDir: this.workspaceDir },
            "Workspace history compaction failed",
          );
        }
        this.historyCompactionTimer = null;
        if (retryAfterMs !== undefined) {
          this.scheduleHistoryCompaction(retryAfterMs);
        }
      })();
    }, delayMs);
    // Never keep the process alive just for maintenance.
    timer.unref?.();
    this.historyCompactionTimer = timer;
  }

  /**
   * Rewrite workspace history so blobs over workspaceGit.maxFileSizeBytes
   * stop occupying .git. Commits older than HISTORY_RETENTION_DAYS are
   * squashed into a single base commit whose tree is scrubbed of oversized
   * entries; younger commits are replayed verbatim (trees, messages,
   * authors, and dates preserved); reflogs are then expired and unreachable
   * objects pruned. Runs only when the object store actually contains an
   * oversized blob, so the steady state is a cheap detection scan.
   *
   * Oversized blobs still referenced by replayed recent commits survive
   * until those commits age past retention — the result carries
   * `retryAfterMs` so the background scheduler re-runs then, and bloat
   * disappears automatically within the retention window. The working
   * tree and index are never touched (the tip tree is reused unchanged).
   * Git notes attached to rewritten commits are orphaned; enrichment only
   * targets commits created after the rewrite, so this is cosmetic.
   */
  async compactHistoryNow(): Promise<{
    rewrote: boolean;
    squashedCommits: number;
    keptCommits: number;
    /** Set when blobs remain but history must first age past retention. */
    retryAfterMs?: number;
  }> {
    await this.ensureInitialized();
    return this.mutex.withLock(() => this.compactHistoryLocked());
  }

  /**
   * Whether any blob in the object store exceeds the size limit. Reads
   * object metadata only — no history walk.
   */
  private async objectStoreHasOversizedBlobLocked(
    limit: number,
  ): Promise<boolean> {
    const objects = await this.execGitStreaming(
      [
        "cat-file",
        "--batch-all-objects",
        "--unordered",
        "--batch-check=%(objecttype) %(objectsize)",
      ],
      { timeoutMs: HISTORY_COMPACTION_TIMEOUT_MS },
    );
    return objects.stdout.split("\n").some((line) => {
      const [type, size] = line.split(" ");
      return type === "blob" && Number(size) > limit;
    });
  }

  private async compactHistoryLocked(): Promise<{
    rewrote: boolean;
    squashedCommits: number;
    keptCommits: number;
    retryAfterMs?: number;
  }> {
    const noop = { rewrote: false, squashedCommits: 0, keptCommits: 0 };
    const limit = this.maxFileSizeBytes();

    // Any oversized blobs at all? Bounds the cost of every boot where there
    // is nothing to do.
    if (!(await this.objectStoreHasOversizedBlobLocked(limit))) {
      return noop;
    }

    // Only rewrite linear main history from its tip.
    const head = await this.execGit(["symbolic-ref", "--short", "HEAD"]);
    if (head.stdout.trim() !== "main") {
      return noop;
    }

    // %x1f field / %x1e record separators — %B is the raw multi-line body.
    const logOut = await this.execGitStreaming(
      [
        "log",
        "--first-parent",
        "--reverse",
        "--format=%H%x1f%T%x1f%ct%x1f%an%x1f%ae%x1f%aD%x1f%cn%x1f%ce%x1f%cD%x1f%B%x1e",
        "main",
      ],
      { timeoutMs: HISTORY_COMPACTION_TIMEOUT_MS },
    );
    const commits = logOut.stdout
      .split("\x1e")
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.includes("\x1f"))
      .map((record) => {
        const f = record.split("\x1f");
        return {
          sha: f[0] ?? "",
          tree: f[1] ?? "",
          committedAtSec: Number(f[2] ?? "0"),
          authorName: f[3] ?? "",
          authorEmail: f[4] ?? "",
          authorDate: f[5] ?? "",
          committerName: f[6] ?? "",
          committerEmail: f[7] ?? "",
          committerDate: f[8] ?? "",
          body: f[9] ?? "",
        };
      });
    if (commits.length === 0) {
      return noop;
    }

    // Squash a PREFIX of the chain so replay order stays consistent even if
    // commit timestamps are not monotonic.
    const cutoffSec =
      Math.floor(Date.now() / 1000) - HISTORY_RETENTION_DAYS * 86400;
    let splitIdx = commits.findIndex((c) => c.committedAtSec >= cutoffSec);
    if (splitIdx === -1) {
      splitIdx = commits.length;
    }
    if (splitIdx === 0) {
      // Blobs live only in commits still within retention. Report when the
      // oldest commit ages past the cutoff so the caller can retry then —
      // otherwise a long-running daemon would keep the bloat until restart.
      const oldestCommittedAtSec = commits[0]?.committedAtSec ?? cutoffSec;
      const oldestAgesOutMs =
        (oldestCommittedAtSec + HISTORY_RETENTION_DAYS * 86400) * 1000 -
        Date.now() +
        60_000;
      const retryAfterMs = Math.max(
        oldestAgesOutMs,
        HISTORY_COMPACTION_MIN_RETRY_MS,
      );
      log.debug(
        { workspaceDir: this.workspaceDir, retryAfterMs },
        "Oversized blobs present but all history is within retention",
      );
      return { ...noop, keptCommits: commits.length, retryAfterMs };
    }

    const kept = commits.slice(splitIdx);
    const boundary = commits[splitIdx - 1];
    if (!boundary) {
      return noop;
    }
    const identityEnv = (c: (typeof commits)[number]) => ({
      GIT_AUTHOR_NAME: c.authorName || DEFAULT_GIT_NAME,
      GIT_AUTHOR_EMAIL: c.authorEmail || DEFAULT_GIT_EMAIL,
      GIT_AUTHOR_DATE: c.authorDate,
      GIT_COMMITTER_NAME: c.committerName || DEFAULT_GIT_NAME,
      GIT_COMMITTER_EMAIL: c.committerEmail || DEFAULT_GIT_EMAIL,
      GIT_COMMITTER_DATE: c.committerDate,
    });

    const baseTree = await this.scrubTreeLocked(boundary.tree, limit);
    let newHead = (
      await this.execGit(
        [
          "commit-tree",
          baseTree,
          "-m",
          `Compacted workspace history (${splitIdx} commits squashed)`,
        ],
        { env: identityEnv(boundary) },
      )
    ).stdout.trim();
    for (const c of kept) {
      newHead = (
        await this.execGit(
          [
            "commit-tree",
            c.tree,
            "-p",
            newHead,
            "-m",
            c.body.trim() || "(no message)",
          ],
          { env: identityEnv(c) },
        )
      ).stdout.trim();
    }

    // Compare-and-swap against the tip we read, in case an external git
    // process moved main while we rewrote.
    const oldHead = commits[commits.length - 1]?.sha ?? "";
    await this.execGit(["update-ref", "refs/heads/main", newHead, oldHead]);
    await this.execGit(
      ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"],
      { timeoutMs: HISTORY_COMPACTION_TIMEOUT_MS },
    );
    await this.execGit(["gc", "--prune=now", "--quiet"], {
      timeoutMs: HISTORY_COMPACTION_TIMEOUT_MS,
    });

    // Blobs referenced by a replayed kept commit survive the prune (the
    // common case: a large file untracked only days ago). Request a retry
    // for when the oldest kept commit ages past retention, so they are
    // reclaimed without waiting for a daemon restart.
    let retryAfterMs: number | undefined;
    if (await this.objectStoreHasOversizedBlobLocked(limit)) {
      const oldestKeptSec =
        kept[0]?.committedAtSec ?? Math.floor(Date.now() / 1000);
      retryAfterMs = Math.max(
        (oldestKeptSec + HISTORY_RETENTION_DAYS * 86400) * 1000 -
          Date.now() +
          60_000,
        HISTORY_COMPACTION_MIN_RETRY_MS,
      );
    }

    log.info(
      {
        workspaceDir: this.workspaceDir,
        squashedCommits: splitIdx,
        keptCommits: kept.length,
        maxFileSizeBytes: limit,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
      "Compacted workspace git history",
    );
    return {
      rewrote: true,
      squashedCommits: splitIdx,
      keptCommits: kept.length,
      retryAfterMs,
    };
  }

  /**
   * Return a copy of `tree` with entries whose blob size exceeds the limit
   * removed, built in a temporary index so the real index is untouched.
   * Returns the original tree when nothing in it is oversized.
   */
  private async scrubTreeLocked(tree: string, limit: number): Promise<string> {
    const listing = await this.execGitStreaming(
      ["ls-tree", "-r", "-l", "-z", tree],
      {
        timeoutMs: HISTORY_COMPACTION_TIMEOUT_MS,
      },
    );
    const oversizedPaths: string[] = [];
    for (const entry of listing.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) {
        continue;
      }
      // "<mode> <type> <oid> <size>\t<path>" — size is right-aligned.
      const meta = entry.substring(0, tab).trim().split(/\s+/);
      if (meta[1] === "blob" && Number(meta[3]) > limit) {
        oversizedPaths.push(entry.substring(tab + 1));
      }
    }
    if (oversizedPaths.length === 0) {
      return tree;
    }

    const tmpIndex = join(this.workspaceDir, ".git", "vellum-compact-index");
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await this.execGit(["read-tree", tree], { env });
      await this.execGitStreaming(
        [
          "rm",
          "--cached",
          "-q",
          "--ignore-unmatch",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { input: oversizedPaths.map((p) => `:(literal)${p}`).join("\0"), env },
      );
      return (await this.execGit(["write-tree"], { env })).stdout.trim();
    } finally {
      try {
        unlinkSync(tmpIndex);
      } catch {
        // Never created, or already gone.
      }
    }
  }

  /**
   * Stage all workspace changes except files whose working-tree size exceeds
   * workspaceGit.maxFileSizeBytes. Oversized files stay on disk untouched —
   * they just never enter workspace history. Deletions always stage (they
   * shrink the repo). Must be called with the lock held.
   *
   * Oversized paths are excluded from the add pathspec up front so git never
   * hashes their blobs: an `add` of a multi-GB artifact would be slow enough
   * to trip interactiveGitTimeoutMs and would bloat .git/objects even if the
   * file were unstaged afterwards. A post-add scan then unstages any
   * oversized blob that reached the index anyway (e.g. staged by an external
   * `git add` before this ran).
   */
  private async stageAllLocked(): Promise<void> {
    // Streamed: output scales with the number of changed files.
    const changed = await this.execGitStreaming([
      "status",
      "--porcelain",
      "--untracked-files=all",
      "-z",
    ]);
    const oversized = new Set<string>();
    for (const { path } of parsePorcelainZ(changed.stdout)) {
      if (this.isOversized(path)) {
        oversized.add(path);
      }
    }

    if (oversized.size === 0) {
      await this.execGit(["add", "-A"]);
    } else {
      // Pathspecs via stdin to stay clear of OS argv limits; literal magic
      // so filenames containing glob characters are not pattern-matched.
      const pathspecs = [
        ".",
        ...[...oversized].map((p) => `:(exclude,literal)${p}`),
      ];
      await this.execGitStreaming(
        ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: pathspecs.join("\0") },
      );
    }

    const base = await this.resolveStagedDiffBaseLocked();
    // Everything but deletions — T covers a tracked symlink/submodule
    // replaced by a staged regular file, which ACMR alone would miss.
    const staged = await this.execGitStreaming([
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--diff-filter=ACMRT",
      base,
    ]);
    const stagedOversized = staged.stdout
      .split("\0")
      .filter((p) => p.length > 0 && this.isOversized(p));

    if (stagedOversized.length > 0) {
      // Literal pathspecs via stdin, mirroring the add above: a filename
      // containing glob characters must not unstage other matching paths.
      await this.execGitStreaming(
        ["reset", "-q", base, "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: stagedOversized.map((p) => `:(literal)${p}`).join("\0") },
      );
    }

    const excluded = [...new Set([...oversized, ...stagedOversized])];
    const newlyWarned = excluded.filter(
      (p) => !this.warnedOversizedPaths.has(p),
    );
    if (newlyWarned.length > 0) {
      for (const p of newlyWarned) {
        this.warnedOversizedPaths.add(p);
      }
      log.warn(
        {
          workspaceDir: this.workspaceDir,
          files: newlyWarned,
          maxFileSizeBytes: this.maxFileSizeBytes(),
        },
        "Excluded oversized files from workspace commit",
      );
    }
  }

  /**
   * Ensure .gitignore contains all required workspace exclusion rules.
   * Idempotent: checks for missing rules and only appends what's needed.
   * Must be called with the mutex lock held.
   */
  private ensureGitignoreRulesLocked(): void {
    const gitignorePath = join(this.workspaceDir, ".gitignore");
    if (existsSync(gitignorePath)) {
      let content = readFileSync(gitignorePath, "utf-8");

      // Migrate legacy broad ignore rule to selective data subdirectory rules.
      // This keeps user-tracked files under data/ visible to git.
      const lines = content.split("\n");
      const hadLegacyDataRule = lines.some((line) => line.trim() === "data/");
      if (hadLegacyDataRule) {
        content = lines.filter((line) => line.trim() !== "data/").join("\n");
        if (!content.endsWith("\n")) {
          content += "\n";
        }
      }

      // Exact line matching: a substring check would let an existing rule like
      // "plugins/*/node_modules/" mask the broader "node_modules/" rule.
      const existingLines = new Set(
        content.split("\n").map((line) => line.trim()),
      );
      const missingRules = WORKSPACE_GITIGNORE_RULES.filter(
        (rule) => !existingLines.has(rule),
      );
      if (hadLegacyDataRule || missingRules.length > 0) {
        let updated = content;
        if (missingRules.length > 0) {
          // Negation rules must trail every Vellum rule (last matching
          // pattern wins), so pull existing ones out and re-append them
          // after the additions instead of leaving them mid-file.
          const negationRules = WORKSPACE_GITIGNORE_RULES.filter((rule) =>
            rule.startsWith("!"),
          );
          const negationSet = new Set(negationRules);
          updated = updated
            .split("\n")
            .filter((line) => !negationSet.has(line.trim()))
            .join("\n");
          if (!updated.endsWith("\n")) {
            updated += "\n";
          }
          const additions = [
            ...missingRules.filter((rule) => !rule.startsWith("!")),
            ...negationRules,
          ];
          updated +=
            "# Vellum runtime state (auto-added)\n" +
            additions.join("\n") +
            "\n";
        }
        writeFileSync(gitignorePath, updated, "utf-8");
      }
    } else {
      const gitignore =
        "# Runtime state - excluded from git tracking\n" +
        WORKSPACE_GITIGNORE_RULES.join("\n") +
        "\n";
      writeFileSync(gitignorePath, gitignore, "utf-8");
    }
  }

  /**
   * Drop tracked files matched by the Vellum-managed ignore rules from the
   * index (working tree untouched). Ignore rules only affect untracked
   * paths, so committed runtime state (e.g. embedding-models/) stays in the
   * index — and churns every commit — until explicitly removed here. The
   * staged deletions ride along with the next commit. Best-effort: failures
   * are logged, never block init. Must be called with the mutex lock held.
   *
   * Deliberately matches against the Vellum-managed rules only — not the
   * workspace .gitignore (which may carry user-authored rules whose matches
   * are force-added on purpose) and not --exclude-standard (the user's
   * global/local exclude files). The rules are passed via a temp file under
   * .git so gitignore semantics, including negation order, are preserved.
   */
  private async untrackIgnoredFilesLocked(): Promise<void> {
    const rulesPath = join(this.workspaceDir, ".git", "vellum-untrack-rules");
    try {
      writeFileSync(
        rulesPath,
        WORKSPACE_GITIGNORE_RULES.join("\n") + "\n",
        "utf-8",
      );
      const { stdout } = await this.execGitStreaming([
        "ls-files",
        "-z",
        "--cached",
        "--ignored",
        `--exclude-from=${rulesPath}`,
      ]);
      const files = stdout.split("\0").filter(Boolean);
      if (files.length === 0) {
        return;
      }
      // Chunked to stay under OS argv limits on bloated workspaces.
      const chunkSize = 200;
      for (let i = 0; i < files.length; i += chunkSize) {
        await this.execGit([
          "rm",
          "--cached",
          "-r",
          "-q",
          "--ignore-unmatch",
          "--",
          ...files.slice(i, i + chunkSize),
        ]);
      }
      log.info(
        { fileCount: files.length },
        "Untracked newly ignored files from workspace index",
      );
    } catch (err) {
      log.warn({ err }, "Failed to untrack newly ignored files");
    } finally {
      try {
        unlinkSync(rulesPath);
      } catch {
        // Never created, or already gone.
      }
    }
  }

  /**
   * Ensure local git identity is configured for automated commits.
   * Idempotent: git config set is a no-op if the value is already correct.
   * Must be called with the mutex lock held.
   */
  private async ensureCommitIdentityLocked(): Promise<void> {
    const gitName = process.env.ASSISTANT_GIT_USER_NAME || DEFAULT_GIT_NAME;
    const gitEmail = process.env.ASSISTANT_GIT_USER_EMAIL || DEFAULT_GIT_EMAIL;
    await this.execGit(["config", "user.name", gitName]);
    await this.execGit(["config", "user.email", gitEmail]);
  }

  /**
   * Ensure workspace branch guard hook is present.
   * Must be called with the mutex lock held.
   */
  private ensureBranchGuardHookLocked(): void {
    const hooksDir = join(this.workspaceDir, ".githooks");
    const hookPath = join(hooksDir, "reference-transaction");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath, WORKSPACE_BRANCH_GUARD_HOOK, "utf-8");
    chmodSync(hookPath, 0o755);
  }

  /**
   * Ensure workspace git uses the branch guard hook path.
   * Must be called with the mutex lock held.
   */
  private async ensureBranchGuardConfigLocked(): Promise<void> {
    await this.execGit(["config", "core.hooksPath", ".githooks"]);
  }

  /**
   * Ensure the workspace repo is on the `main` branch.
   * If on a different branch or in detached HEAD state, switches to main
   * (creating it if it doesn't exist).
   * Must be called with the mutex lock held.
   */
  private async ensureOnMainLocked(): Promise<void> {
    let currentBranch: string | null = null;
    try {
      const { stdout } = await this.execGit([
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);
      currentBranch = stdout.trim();
    } catch {
      // symbolic-ref fails in detached HEAD state
      currentBranch = null;
    }

    if (currentBranch === "main") {
      return;
    }

    const state =
      currentBranch == null ? "detached HEAD" : `branch '${currentBranch}'`;
    log.warn(
      { workspaceDir: this.workspaceDir, currentBranch },
      `Workspace repo is on ${state}; auto-switching to main`,
    );

    // Try switching to existing main branch first.
    // If the switch fails, distinguish "main doesn't exist" from
    // "local changes would be overwritten" to pick the right recovery.
    try {
      await this.execGit(["switch", "main"]);
    } catch {
      // Check whether `main` already exists as a branch.
      let mainExists = false;
      try {
        await this.execGit(["rev-parse", "--verify", "refs/heads/main"]);
        mainExists = true;
      } catch {
        // main branch does not exist
      }

      if (mainExists) {
        // `main` exists but switch failed — likely due to uncommitted
        // local changes that would be overwritten. Discard them so we
        // can land on main.
        await this.execGit(["switch", "main", "--discard-changes"]);
      } else {
        // `main` doesn't exist yet — create it.
        await this.execGit(["switch", "-c", "main"]);
      }
    }
  }

  /**
   * Execute a git command in the workspace directory.
   * Uses the configurable interactiveGitTimeoutMs (default 10 000 ms) to
   * prevent hung operations (e.g. stale git lock files). The timeout is
   * intentionally short for interactive workspace operations — background
   * enrichment jobs use their own dedicated timeout.
   */
  private async execGit(
    args: string[],
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const config = getConfig();
    const timeoutMs =
      options?.timeoutMs ??
      config.workspaceGit?.interactiveGitTimeoutMs ??
      10_000;
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.workspaceDir,
        encoding: "utf-8",
        timeout: timeoutMs,
        env: { ...cleanGitEnv(this.workspaceDir), ...options?.env },
        signal: options?.signal,
      });
      return { stdout, stderr };
    } catch (err) {
      const gitErr = err as ExecError & { stdout?: string; stderr?: string };
      throw this.enhanceGitError(args, {
        message: gitErr.message,
        stderr: gitErr.stderr,
        code: gitErr.code,
        killed: gitErr.killed,
        signal: gitErr.signal,
      });
    }
  }

  /**
   * Execute a git command, streaming stdout/stderr into buffers via `spawn`.
   *
   * Unlike {@link execGit} (which uses `execFile` with Node's 1 MB default
   * `maxBuffer`), this has no fixed output ceiling — so commands whose output
   * scales with working-tree size (`git status --porcelain` over a bloated
   * workspace) cannot fail with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. Used for
   * read paths where output is unbounded; errors are enhanced identically to
   * {@link execGit} so callers can still distinguish timeouts and permissions.
   * `options.input` is written to the child's stdin, which is closed either
   * way so commands reading stdin to EOF (`--pathspec-from-file=-`) terminate.
   */
  private execGitStreaming(
    args: string[],
    options?: {
      signal?: AbortSignal;
      input?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const config = getConfig();
    const timeoutMs =
      options?.timeoutMs ??
      config.workspaceGit?.interactiveGitTimeoutMs ??
      10_000;
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.workspaceDir,
        env: { ...cleanGitEnv(this.workspaceDir), ...options?.env },
        signal: options?.signal,
      });

      // Swallow EPIPE from a child that exits without reading stdin; the
      // failure still surfaces through the close/error handlers below.
      child.stdin?.on("error", () => {});
      child.stdin?.end(options?.input ?? "");

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err: ExecError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          this.enhanceGitError(args, {
            message: err.message,
            stderr: Buffer.concat(stderrChunks).toString("utf-8"),
            code: err.code,
            killed: err.killed,
            signal: err.signal,
          }),
        );
      });

      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const stderr = Buffer.concat(stderrChunks).toString("utf-8");

          if (code === 0 && !timedOut) {
            resolve({ stdout, stderr });
            return;
          }

          reject(
            this.enhanceGitError(args, {
              message: timedOut
                ? `git ${args.join(" ")} timed out after ${timeoutMs}ms`
                : `git ${args.join(" ")} exited with code ${code}`,
              stderr,
              code: timedOut ? undefined : (code ?? undefined),
              killed: timedOut,
              signal: signal ?? (timedOut ? "SIGTERM" : undefined),
            }),
          );
        },
      );
    });
  }

  /**
   * Build a descriptive Error for a failed git command, preserving the
   * properties callers use to distinguish transient failures (timeouts,
   * permissions, missing binary) from genuine corruption.
   */
  private enhanceGitError(
    args: string[],
    raw: {
      message: string;
      stderr?: string;
      code?: string | number;
      killed?: boolean;
      signal?: string;
    },
  ): ExecError {
    const isPermissionError =
      raw.code === "EACCES" || raw.stderr?.includes("Permission denied");
    const prefix = isPermissionError
      ? "Git permission error"
      : "Git command failed";
    const enhanced = new Error(
      `${prefix}: git ${args.join(" ")}\n` +
        `Error: ${raw.message}\n` +
        `Stderr: ${raw.stderr || ""}`,
    ) as ExecError;
    enhanced.killed = raw.killed;
    enhanced.signal = raw.signal;
    enhanced.code = raw.code;
    return enhanced;
  }

  /**
   * Build commit args that disable all git hook execution.
   *
   * Workspace contents are model-writable, so hooks in `.git/hooks` (or via
   * `core.hooksPath`) are untrusted. Auto-commit paths must not execute them.
   */
  private buildSafeCommitArgs(args: string[]): string[] {
    return ["-c", "core.hooksPath=/dev/null", "commit", "--no-verify", ...args];
  }

  /**
   * Run an arbitrary read-only git command in the workspace directory.
   * Uses the same clean env and timeout as other git operations.
   * Does NOT acquire the mutex — callers must ensure they are not
   * writing to the repo concurrently (or accept eventual-consistency).
   */
  async runReadOnlyGit(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    await this.ensureInitialized();
    return this.execGit(args);
  }

  /**
   * Run a sequence of git commands atomically under the workspace mutex.
   * Use this for write operations that need serialization with other
   * git mutations (e.g. checkout + commit).
   */
  async runWithMutex(
    fn: (
      exec: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
    ) => Promise<void>,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.mutex.withLock(async () => {
      this.cleanStaleLockFile();
      await fn((args) => {
        // Intercept commit commands to enforce hook hardening.
        if (args[0] === "commit") {
          return this.execGit(this.buildSafeCommitArgs(args.slice(1)));
        }
        return this.execGit(args);
      });
    });
  }

  /**
   * Get the commit hash of the current HEAD.
   * This is a lightweight read-only operation that does not require the mutex.
   */
  async getHeadHash(): Promise<string> {
    const { stdout } = await this.execGit(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /**
   * Write a git note to a specific commit.
   * Uses the 'vellum' notes ref to avoid conflicts with default notes.
   *
   * Retries once on `index.lock` errors — `git notes add` briefly holds
   * a ref lock that can collide with concurrent git operations (e.g. a
   * heartbeat commit racing with fire-and-forget enrichment).
   */
  async writeNote(
    commitHash: string,
    noteContent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutex.withLock(async () => {
      const args = [
        "notes",
        "--ref=vellum",
        "add",
        "-f",
        "-m",
        noteContent,
        commitHash,
      ];
      try {
        await this.execGit(args, { signal });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!msg.includes("index.lock") && !msg.includes("Unable to create")) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 50));
        await this.execGit(args, { signal });
      }
    });
  }

  /**
   * Check if the workspace has a git repository initialized.
   * This is a non-blocking check that doesn't trigger initialization.
   */
  isInitialized(): boolean {
    return existsSync(join(this.workspaceDir, ".git"));
  }

  /**
   * Get the workspace directory path.
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
}

/**
 * Check whether a deadline has expired.
 * Returns true when `deadlineMs` is provided and `Date.now()` has reached or passed it.
 */
export function isDeadlineExpired(deadlineMs?: number): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

/**
 * Singleton registry for workspace git services.
 * Ensures one service instance per workspace directory.
 */
const serviceRegistry = new Map<string, WorkspaceGitService>();

/**
 * Get or create a git service for the specified workspace directory.
 *
 * @param workspaceDir - Absolute path to workspace directory
 * @returns WorkspaceGitService instance for the workspace
 */
export function getWorkspaceGitService(
  workspaceDir: string,
): WorkspaceGitService {
  let service = serviceRegistry.get(workspaceDir);
  if (!service) {
    service = new WorkspaceGitService(workspaceDir);
    serviceRegistry.set(workspaceDir, service);
  }
  return service;
}

/**
 * Returns all currently registered WorkspaceGitService instances.
 * Used by the heartbeat service to check all tracked workspaces for uncommitted changes.
 */
export function getAllWorkspaceGitServices(): ReadonlyMap<
  string,
  WorkspaceGitService
> {
  return serviceRegistry;
}

/**
 * @internal Test-only: clear the service registry
 */
export function _resetGitServiceRegistry(): void {
  serviceRegistry.clear();
}

/**
 * @internal Test-only: reset circuit breaker state for a service instance
 */
export function _resetBreaker(service: WorkspaceGitService): void {
  (
    service as unknown as {
      consecutiveFailures: number;
    }
  ).consecutiveFailures = 0;
  (
    service as unknown as {
      nextAllowedAttemptMs: number;
    }
  ).nextAllowedAttemptMs = 0;
}

/**
 * @internal Test-only: get consecutive failure count
 */
export function _getConsecutiveFailures(service: WorkspaceGitService): number {
  return (service as unknown as { consecutiveFailures: number })
    .consecutiveFailures;
}

/**
 * @internal Test-only: reset init circuit breaker state for a service instance
 */
export function _resetInitBreaker(service: WorkspaceGitService): void {
  (
    service as unknown as {
      initConsecutiveFailures: number;
    }
  ).initConsecutiveFailures = 0;
  (
    service as unknown as {
      initNextAllowedAttemptMs: number;
    }
  ).initNextAllowedAttemptMs = 0;
}

/**
 * @internal Test-only: get init consecutive failure count
 */
export function _getInitConsecutiveFailures(
  service: WorkspaceGitService,
): number {
  return (service as unknown as { initConsecutiveFailures: number })
    .initConsecutiveFailures;
}
