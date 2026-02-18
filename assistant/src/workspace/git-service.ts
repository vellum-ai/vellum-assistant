import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../util/logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('workspace-git');

/**
 * Patterns excluded from workspace git tracking.
 * These are written to .gitignore on init and appended to existing .gitignore files.
 */
const WORKSPACE_GITIGNORE_RULES = [
  'data/',
  'logs/',
  '*.log',
  '*.sock',
  '*.pid',
  '*.sqlite',
  '*.sqlite-journal',
  '*.sqlite-wal',
  '*.sqlite-shm',
  '*.db',
  '*.db-journal',
  '*.db-wal',
  '*.db-shm',
  'vellum.sock',
  'vellum.pid',
  'session-token',
  'http-token',
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
  private initPromise: Promise<void> | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.mutex = new Mutex();
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
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = this.mutex.withLock(async () => {
      // Double-check after acquiring lock
      if (this.initialized) {
        return;
      }

      const gitDir = join(this.workspaceDir, '.git');

      if (existsSync(gitDir)) {
        // Validate existing repo is not corrupted before marking as ready.
        // A corrupted .git directory (e.g. missing HEAD) would cause all
        // subsequent git operations to fail with confusing errors.
        try {
          await this.execGit(['rev-parse', '--git-dir']);
        } catch (err: unknown) {
          // Distinguish transient failures from genuine corruption.
          // Transient errors (timeouts, permissions, missing git binary)
          // should NOT destroy .git — they will resolve on retry via
          // the initPromise clearing logic.
          const errMsg = err instanceof Error ? err.message : String(err);
          const execErr = err as ExecError;
          const isTimeout = execErr.killed === true
            || execErr.signal === 'SIGTERM'
            || errMsg.includes('SIGTERM')
            || errMsg.includes('timed out');
          const isPermission = execErr.code === 'EACCES'
            || errMsg.includes('EACCES')
            || errMsg.toLowerCase().includes('permission denied');
          const isMissingBinary = execErr.code === 'ENOENT'
            || errMsg.includes('ENOENT');

          if (isTimeout || isPermission || isMissingBinary) {
            // Re-throw so initialization fails gracefully without
            // destroying valid git history.
            throw err;
          }

          // Genuine corruption (e.g. missing HEAD, broken refs) —
          // remove corrupted .git and fall through to full init below.
          log.warn(
            { workspaceDir: this.workspaceDir, err: errMsg },
            'Corrupted .git directory detected; reinitializing',
          );
          const { rmSync } = await import('node:fs');
          rmSync(gitDir, { recursive: true, force: true });
        }

        if (existsSync(gitDir)) {
          // .git exists and passed the corruption check, but we still
          // need to verify that at least one commit exists. A partial
          // init (e.g. git init succeeded but the initial commit failed)
          // leaves .git present with an undefined HEAD. In that case,
          // fall through to the initial commit logic below.
          try {
            await this.execGit(['rev-parse', 'HEAD']);
            // HEAD resolves — repo is fully initialized
            this.initialized = true;
            return;
          } catch (err: unknown) {
            // Distinguish transient failures from genuine "no commits".
            // Transient errors (timeouts, permissions, missing git binary)
            // should NOT fall through to re-initialization — they will
            // resolve on retry via the initPromise clearing logic.
            const errMsg = err instanceof Error ? err.message : String(err);
            const execErr = err as ExecError;
            const isTimeout = execErr.killed === true
              || execErr.signal === 'SIGTERM'
              || errMsg.includes('SIGTERM')
              || errMsg.includes('timed out');
            const isPermission = execErr.code === 'EACCES'
              || errMsg.includes('EACCES')
              || errMsg.toLowerCase().includes('permission denied');
            const isMissingBinary = execErr.code === 'ENOENT'
              || errMsg.includes('ENOENT');

            if (isTimeout || isPermission || isMissingBinary) {
              throw err;
            }
            // Genuine "no commits" (unborn HEAD) — fall through to
            // create the initial commit.
          }
        }
        // Otherwise fall through to reinitialize / create initial commit
      }

      // Initialize new git repository
      await this.execGit(['init', '-b', 'main']);

      // Ensure .gitignore contains runtime exclusions.
      // Preserve any existing rules the workspace already had.
      const gitignorePath = join(this.workspaceDir, '.gitignore');
      if (existsSync(gitignorePath)) {
        const existing = readFileSync(gitignorePath, 'utf-8');
        const missingRules = WORKSPACE_GITIGNORE_RULES.filter(rule => !existing.includes(rule));
        if (missingRules.length > 0) {
          const section = '\n# Vellum runtime state (auto-added)\n' + missingRules.join('\n') + '\n';
          writeFileSync(gitignorePath, existing + section, 'utf-8');
        }
      } else {
        const gitignore = '# Runtime state - excluded from git tracking\n' + WORKSPACE_GITIGNORE_RULES.join('\n') + '\n';
        writeFileSync(gitignorePath, gitignore, 'utf-8');
      }

      // Set git identity for automated commits
      await this.execGit(['config', 'user.name', 'Vellum Assistant']);
      await this.execGit(['config', 'user.email', 'assistant@vellum.ai']);

      // Create initial commit synchronously within the lock to prevent
      // races with the first commitChanges() call. Without this, the
      // initial commit could run concurrently and consume edits meant
      // for the first user-requested commit.
      const status = await this.getStatusInternal();
      const hasExistingFiles = status.untracked.length > 1 || // More than just .gitignore
        status.untracked.some(f => f !== '.gitignore');

      await this.execGit(['add', '-A']);

      const message = hasExistingFiles
        ? 'Initial commit: migrated existing workspace'
        : 'Initial commit: new workspace';

      await this.execGit(['commit', '-m', message, '--allow-empty']);

      this.initialized = true;
    });

    // If initialization fails, clear the cached promise so subsequent
    // calls can retry instead of permanently returning the rejected promise.
    this.initPromise.catch(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  /**
   * Commit all changes in the workspace.
   *
   * @param message - Commit message describing the changes
   * @param metadata - Optional metadata (currently stored in commit message)
   */
  async commitChanges(message: string, metadata?: GitCommitMetadata): Promise<void> {
    await this.ensureInitialized();

    await this.mutex.withLock(async () => {
      // Stage all changes
      await this.execGit(['add', '-A']);

      // Build commit message with metadata if provided
      let fullMessage = message;
      if (metadata && Object.keys(metadata).length > 0) {
        fullMessage += '\n\n' + Object.entries(metadata)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
      }

      // Commit (will succeed even if no changes)
      await this.execGit(['commit', '-m', fullMessage, '--allow-empty']);
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
   * @returns Whether a commit was created and the status at check time.
   */
  async commitIfDirty(
    decide: (status: GitStatus) => { message: string; metadata?: GitCommitMetadata } | null,
  ): Promise<{ committed: boolean; status: GitStatus }> {
    await this.ensureInitialized();

    return this.mutex.withLock(async () => {
      const status = await this.getStatusInternal();
      if (status.clean) {
        return { committed: false, status };
      }

      const decision = decide(status);
      if (!decision) {
        return { committed: false, status };
      }

      await this.execGit(['add', '-A']);

      // Verify something was actually staged. Another service instance
      // (or external process) could have committed between our status
      // check and the add, leaving the index clean.
      try {
        await this.execGit(['diff', '--cached', '--quiet']);
        // Exit code 0 means nothing staged — nothing to commit
        return { committed: false, status };
      } catch {
        // Exit code 1 means there ARE staged changes — proceed
      }

      let fullMessage = decision.message;
      if (decision.metadata && Object.keys(decision.metadata).length > 0) {
        fullMessage += '\n\n' + Object.entries(decision.metadata)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
      }

      await this.execGit(['commit', '-m', fullMessage]);
      return { committed: true, status };
    });
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
    const { stdout } = await this.execGit(['status', '--porcelain']);

    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];

    for (const line of stdout.split('\n')) {
      if (!line) continue;

      const status = line.substring(0, 2);
      const file = line.substring(3);

      // First character is staged status, second is working tree status
      const stagedStatus = status[0];
      const workingStatus = status[1];

      if (stagedStatus !== ' ' && stagedStatus !== '?') {
        staged.push(file);
      }
      if (workingStatus === 'M' || workingStatus === 'D') {
        modified.push(file);
      }
      if (status === '??') {
        untracked.push(file);
      }
    }

    return {
      staged,
      modified,
      untracked,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
    };
  }

  /**
   * Execute a git command in the workspace directory.
   * Includes a 30-second timeout to prevent hung operations
   * (e.g. stale git lock files).
   */
  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
        timeout: 30_000,
      });
      return { stdout, stderr };
    } catch (err) {
      // Enhance error with git command details, preserving properties
      // needed to distinguish transient failures from corruption.
      const gitErr = err as Error & {
        stdout?: string; stderr?: string;
        code?: string; killed?: boolean; signal?: string;
      };
      const isPermissionError = gitErr.code === 'EACCES' || gitErr.stderr?.includes('Permission denied');
      const prefix = isPermissionError ? 'Git permission error' : 'Git command failed';
      const enhanced = new Error(
        `${prefix}: git ${args.join(' ')}\n` +
        `Error: ${gitErr.message}\n` +
        `Stderr: ${gitErr.stderr || ''}`,
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
   * Check if the workspace has a git repository initialized.
   * This is a non-blocking check that doesn't trigger initialization.
   */
  isInitialized(): boolean {
    return existsSync(join(this.workspaceDir, '.git'));
  }

  /**
   * Get the workspace directory path.
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
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
export function getWorkspaceGitService(workspaceDir: string): WorkspaceGitService {
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
export function getAllWorkspaceGitServices(): ReadonlyMap<string, WorkspaceGitService> {
  return serviceRegistry;
}

/**
 * @internal Test-only: clear the service registry
 */
export function _resetGitServiceRegistry(): void {
  serviceRegistry.clear();
}
