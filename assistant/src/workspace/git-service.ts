import { existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
 * - Async initial commit to avoid blocking on large workspaces
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
   * 4. Stage all files
   * 5. Create initial commit (async, returns immediately)
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
        // Already initialized by another process or previous run
        this.initialized = true;
        return;
      }

      // Initialize new git repository
      await this.execGit(['init', '-b', 'main']);

      // Create .gitignore
      const gitignore = [
        '# Runtime state - excluded from git tracking',
        'data/',
        'logs/',
        '*.log',
        '*.sock',
        '*.pid',
        'vellum.sock',
        'vellum.pid',
        'session-token',
        'http-token',
        '',
      ].join('\n');

      const gitignorePath = join(this.workspaceDir, '.gitignore');
      writeFileSync(gitignorePath, gitignore, 'utf-8');

      // Set git identity for automated commits
      await this.execGit(['config', 'user.name', 'Vellum Assistant']);
      await this.execGit(['config', 'user.email', 'assistant@vellum.ai']);

      this.initialized = true;

      // Create initial commit asynchronously to avoid blocking
      // This runs in the background after ensureInitialized returns
      this.createInitialCommitAsync().catch(() => {
        // Silently ignore errors - repo is still usable
        // (errors expected during tests when directories are cleaned up)
      });
    });

    return this.initPromise;
  }

  /**
   * Create the initial commit asynchronously.
   * Determines if this is a new or migrated workspace and commits accordingly.
   */
  private async createInitialCommitAsync(): Promise<void> {
    await this.mutex.withLock(async () => {
      // Check if workspace directory still exists (may have been deleted in tests)
      if (!existsSync(this.workspaceDir)) {
        return;
      }

      // Check if there are any existing files (excluding .git and .gitignore)
      const status = await this.getStatusInternal();
      const hasExistingFiles = status.untracked.length > 1 || // More than just .gitignore
        status.untracked.some(f => f !== '.gitignore');

      // Stage all files
      await this.execGit(['add', '-A']);

      // Create initial commit with appropriate message
      const message = hasExistingFiles
        ? 'Initial commit: migrated existing workspace'
        : 'Initial commit: new workspace';

      await this.execGit(['commit', '-m', message, '--allow-empty']);
    });
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
   */
  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd: this.workspaceDir,
        encoding: 'utf-8',
      });
      return { stdout, stderr };
    } catch (err) {
      // Enhance error with git command details
      const gitErr = err as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Git command failed: git ${args.join(' ')}\n` +
        `Error: ${gitErr.message}\n` +
        `Stderr: ${gitErr.stderr || ''}`,
      );
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
 * @internal Test-only: clear the service registry
 */
export function _resetGitServiceRegistry(): void {
  serviceRegistry.clear();
}
