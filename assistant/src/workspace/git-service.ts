import { execFile } from "node:child_process";
import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
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
  "data/db/",
  "data/qdrant/",
  "logs/",
  "*.log",
  "*.sock",
  "*.pid",
  "*.sqlite",
  "*.sqlite-journal",
  "*.sqlite-wal",
  "*.sqlite-shm",
  "*.db",
  "*.db-journal",
  "*.db-wal",
  "*.db-shm",
  "vellum.pid",
  "session-token",
];

/** Properties added by Node's child_process errors. */
interface ExecError extends Error {
  killed?: boolean;
  signal?: string;
  code?: string | number;
}

/**
 * Simple mutex implementation for per-workspace git operation serialization.
 * Prevents concurrent git operations from corrupting the repository state.
 */
class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    // Wait for the lock to be released
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Execute a function while holding the lock.
   * Automatically releases the lock when done, even if the function throws.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
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

  /** Age threshold (ms) beyond which an index.lock is considered stale. */
  private static readonly LOCK_STALE_THRESHOLD_MS = 30_000;

  /**
   * Remove `.git/index.lock` only if it is stale — older than
   * {@link LOCK_STALE_THRESHOLD_MS}. A recently-created lock may belong to a
   * concurrent git process outside our mutex (e.g. a user-initiated CLI
   * command), so we leave it alone.
   */
  private cleanStaleLockFile(): void {
    const lockPath = join(this.workspaceDir, ".git", "index.lock");
    try {
      const stat = statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < GitService.LOCK_STALE_THRESHOLD_MS) {
        log.debug(
          `index.lock exists but is only ${Math.round(ageMs / 1000)}s old — leaving it`,
        );
        return;
      }
      unlinkSync(lockPath);
      log.debug(`Removed stale index.lock (${Math.round(ageMs / 1000)}s old)`);
    } catch {
      // File doesn't exist or can't be stat'd/removed — move on.
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
                this.ensureGitignoreRulesLocked();
                await this.ensureCommitIdentityLocked();
                await this.ensureOnMainLocked();
                this.initialized = true;
                this.recordInitSuccess();
                return;
              }
            }
            // Otherwise fall through to reinitialize / create initial commit
          }

          // Initialize new git repository
          await this.execGit(["init", "-b", "main"]);

          // Run normalization (gitignore + identity + branch enforcement).
          // For fresh `git init -b main` the branch is already main, but
          // in the corruption-recovery path we fall through here after
          // removing .git, so branch enforcement is still useful.
          this.ensureGitignoreRulesLocked();
          await this.ensureCommitIdentityLocked();
          await this.ensureOnMainLocked();

          // Create initial commit synchronously within the lock to prevent
          // races with the first commitChanges() call. Without this, the
          // initial commit could run concurrently and consume edits meant
          // for the first user-requested commit.
          const status = await this.getStatusInternal();
          const hasExistingFiles =
            status.untracked.length > 1 || // More than just .gitignore
            status.untracked.some((f) => f !== ".gitignore");

          await this.execGit(["add", "-A"]);

          const message = hasExistingFiles
            ? "Initial commit: migrated existing workspace"
            : "Initial commit: new workspace";

          await this.execGit(["commit", "-m", message, "--allow-empty"]);

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

      // Stage all changes
      await this.execGit(["add", "-A"]);

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
      await this.execGit(["commit", "-m", fullMessage, "--allow-empty"]);
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

        const status = await this.getStatusInternal();
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

        await this.execGit(["add", "-A"]);

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

        await this.execGit(["commit", "-m", fullMessage]);
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
    const { stdout } = await this.execGit(["status", "--porcelain"]);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of stdout.split("\n")) {
      if (!line) continue;

      const status = line.substring(0, 2);
      const file = line.substring(3);

      // First character is staged status, second is working tree status
      const stagedStatus = status[0];
      const workingStatus = status[1];

      if (stagedStatus !== " " && stagedStatus !== "?") {
        staged.push(file);
      }
      if (workingStatus === "M" || workingStatus === "D") {
        modified.push(file);
      }
      if (status === "??") {
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
      const hadLegacyHttpToken = lines.some(
        (line) => line.trim() === "http-token",
      );
      if (hadLegacyDataRule || hadLegacyHttpToken) {
        content = lines
          .filter(
            (line) => line.trim() !== "data/" && line.trim() !== "http-token",
          )
          .join("\n");
        if (!content.endsWith("\n")) {
          content += "\n";
        }
      }

      const missingRules = WORKSPACE_GITIGNORE_RULES.filter(
        (rule) => !content.includes(rule),
      );
      if (hadLegacyDataRule || hadLegacyHttpToken || missingRules.length > 0) {
        let updated = content;
        if (missingRules.length > 0) {
          if (!updated.endsWith("\n")) {
            updated += "\n";
          }
          updated +=
            "# Vellum runtime state (auto-added)\n" +
            missingRules.join("\n") +
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
   * Ensure local git identity is configured for automated commits.
   * Idempotent: git config set is a no-op if the value is already correct.
   * Must be called with the mutex lock held.
   */
  private async ensureCommitIdentityLocked(): Promise<void> {
    await this.execGit(["config", "user.name", "Vellum Assistant"]);
    await this.execGit(["config", "user.email", "assistant@vellum.ai"]);
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
    options?: { signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    const config = getConfig();
    const timeoutMs = config.workspaceGit?.interactiveGitTimeoutMs ?? 10_000;
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.workspaceDir,
        encoding: "utf-8",
        timeout: timeoutMs,
        env: cleanGitEnv(this.workspaceDir),
        signal: options?.signal,
      });
      return { stdout, stderr };
    } catch (err) {
      // Enhance error with git command details, preserving properties
      // needed to distinguish transient failures from corruption.
      const gitErr = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: string;
        killed?: boolean;
        signal?: string;
      };
      const isPermissionError =
        gitErr.code === "EACCES" ||
        gitErr.stderr?.includes("Permission denied");
      const prefix = isPermissionError
        ? "Git permission error"
        : "Git command failed";
      const enhanced = new Error(
        `${prefix}: git ${args.join(" ")}\n` +
          `Error: ${gitErr.message}\n` +
          `Stderr: ${gitErr.stderr || ""}`,
      );
      // Preserve properties so callers can detect timeouts, permission
      // errors, and missing-binary failures without parsing the message.
      (enhanced as ExecError).killed = gitErr.killed;
      (enhanced as ExecError).signal = gitErr.signal;
      (enhanced as ExecError).code = gitErr.code;
      throw enhanced;
    }
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
      await fn((args) => this.execGit(args));
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
   */
  async writeNote(
    commitHash: string,
    noteContent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.mutex.withLock(async () => {
      await this.execGit(
        ["notes", "--ref=vellum", "add", "-f", "-m", noteContent, commitHash],
        { signal },
      );
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
