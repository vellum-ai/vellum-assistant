import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  WorkspaceGitService,
  getWorkspaceGitService,
  _resetGitServiceRegistry,
} from '../workspace/git-service.js';

describe('WorkspaceGitService', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(tmpdir(), `vellum-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('lazy initialization', () => {
    test('initializes git repo on first ensureInitialized call', async () => {
      const service = new WorkspaceGitService(testDir);

      expect(service.isInitialized()).toBe(false);

      await service.ensureInitialized();

      expect(service.isInitialized()).toBe(true);
      expect(existsSync(join(testDir, '.git'))).toBe(true);
    });

    test('creates .gitignore with proper exclusions', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const gitignorePath = join(testDir, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);

      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('data/db/');
      expect(content).toContain('data/qdrant/');
      expect(content).toContain('data/ipc-blobs/');
      expect(content).toContain('*.log');
      expect(content).toContain('*.sock');
      expect(content).toContain('*.pid');
      expect(content).toContain('vellum.sock');
      expect(content).toContain('session-token');
    });

    test('sets git identity correctly', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const userName = execFileSync('git', ['config', 'user.name'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      const userEmail = execFileSync('git', ['config', 'user.email'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();

      expect(userName).toBe('Vellum Assistant');
      expect(userEmail).toBe('assistant@vellum.ai');
    });

    test('multiple ensureInitialized calls are idempotent', async () => {
      const service = new WorkspaceGitService(testDir);

      await service.ensureInitialized();
      await service.ensureInitialized();
      await service.ensureInitialized();

      expect(service.isInitialized()).toBe(true);
    });

    test('handles concurrent ensureInitialized calls', async () => {
      const service = new WorkspaceGitService(testDir);

      // Start multiple initialization calls concurrently
      const promises = [
        service.ensureInitialized(),
        service.ensureInitialized(),
        service.ensureInitialized(),
      ];

      await Promise.all(promises);

      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('initial commit', () => {
    test('creates initial commit for new empty workspace', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const log = execFileSync('git', ['log', '--oneline'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(log).toContain('Initial commit: new workspace');
    });

    test('creates initial commit for existing workspace with files', async () => {
      // Create some files before initializing git
      writeFileSync(join(testDir, 'README.md'), '# Test\n');
      writeFileSync(join(testDir, 'config.json'), '{}');
      mkdirSync(join(testDir, 'subdir'));
      writeFileSync(join(testDir, 'subdir', 'file.txt'), 'content');

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const log = execFileSync('git', ['log', '--oneline'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(log).toContain('Initial commit: migrated existing workspace');

      // Verify files were committed
      const files = execFileSync('git', ['ls-files'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim().split('\n');

      expect(files).toContain('.gitignore');
      expect(files).toContain('README.md');
      expect(files).toContain('config.json');
      expect(files).toContain('subdir/file.txt');
    });

    test('initial commit completes within ensureInitialized', async () => {
      // Create some files before initializing git
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), 'content');
      }

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Initial commit should already be done - no need to wait
      const log = execFileSync('git', ['log', '--oneline'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(log).toContain('Initial commit: migrated existing workspace');
    });

    test('initial commit does not race with first commitChanges', async () => {
      // Pre-populate workspace with files (simulating a migrated workspace)
      writeFileSync(join(testDir, 'existing.txt'), 'pre-existing content');

      const service = new WorkspaceGitService(testDir);

      // Initialize - the initial commit now happens synchronously within
      // ensureInitialized, so it completes before we can write new files.
      await service.ensureInitialized();

      // Now write a file AFTER init and commit it
      writeFileSync(join(testDir, 'user-edit.txt'), 'user content');
      await service.commitChanges('User turn 1');

      // The user's commit (HEAD) should contain user-edit.txt
      const userCommitFiles = execFileSync(
        'git', ['diff', '--name-only', 'HEAD~1', 'HEAD'],
        { cwd: testDir, encoding: 'utf-8' },
      ).trim();

      expect(userCommitFiles).toContain('user-edit.txt');
      // user-edit.txt should NOT appear in the initial commit
      expect(userCommitFiles).not.toContain('existing.txt');

      // The initial commit (HEAD~1) should contain existing.txt and .gitignore
      const initialCommitFiles = execFileSync(
        'git', ['show', '--name-only', '--pretty=format:', 'HEAD~1'],
        { cwd: testDir, encoding: 'utf-8' },
      ).trim();

      expect(initialCommitFiles).toContain('existing.txt');
      expect(initialCommitFiles).toContain('.gitignore');
      // The initial commit should NOT contain user-edit.txt
      expect(initialCommitFiles).not.toContain('user-edit.txt');
    });
  });

  describe('commitChanges', () => {
    test('commits changes with message', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'test.txt'), 'hello world');
      await service.commitChanges('Add test file');

      const log = execFileSync('git', ['log', '--oneline', '-n', '1'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(log).toContain('Add test file');
    });

    test('commits with metadata', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'test.txt'), 'content');
      await service.commitChanges('Add file', {
        sessionId: 'session-123',
        timestamp: 1234567890,
        author: 'user@example.com',
      });

      const message = execFileSync('git', ['log', '-1', '--pretty=%B'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(message).toContain('Add file');
      expect(message).toContain('sessionId: "session-123"');
      expect(message).toContain('timestamp: 1234567890');
      expect(message).toContain('author: "user@example.com"');
    });

    test('commits multiple files at once', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'file1.txt'), 'content1');
      writeFileSync(join(testDir, 'file2.txt'), 'content2');
      writeFileSync(join(testDir, 'file3.txt'), 'content3');

      await service.commitChanges('Add multiple files');

      const files = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim().split('\n');

      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
      expect(files).toContain('file3.txt');
    });

    test('allows empty commits', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Commit without any changes
      await service.commitChanges('Empty commit for checkpoint');

      const log = execFileSync('git', ['log', '--oneline', '-n', '1'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      expect(log).toContain('Empty commit for checkpoint');
    });
  });

  describe('getStatus', () => {
    test('returns clean status for new workspace', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const status = await service.getStatus();

      expect(status.clean).toBe(true);
      expect(status.staged).toEqual([]);
      expect(status.modified).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    test('detects untracked files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'new-file.txt'), 'content');

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('new-file.txt');
    });

    test('detects modified files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'file.txt'), 'original');
      await service.commitChanges('Add file');

      writeFileSync(join(testDir, 'file.txt'), 'modified');

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.modified).toContain('file.txt');
    });

    test('detects staged files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'file.txt'), 'content');

      // Manually stage the file
      execFileSync('git', ['add', 'file.txt'], { cwd: testDir });

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.staged).toContain('file.txt');
    });
  });

  describe('mutex locking', () => {
    test('serializes concurrent commit operations', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Start multiple concurrent commits
      const commits = [];
      for (let i = 0; i < 10; i++) {
        commits.push(
          (async () => {
            writeFileSync(join(testDir, `file${i}.txt`), `content ${i}`);
            await service.commitChanges(`Add file ${i}`);
          })(),
        );
      }

      await Promise.all(commits);

      // All commits should have succeeded
      const log = execFileSync('git', ['log', '--oneline'], {
        cwd: testDir,
        encoding: 'utf-8',
      });

      for (let i = 0; i < 10; i++) {
        expect(log).toContain(`Add file ${i}`);
      }

      // Count commits (excluding initial commit)
      const commitCount = log.trim().split('\n').length;
      expect(commitCount).toBe(11); // 10 + 1 initial
    });

    test('serializes concurrent status checks', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Start multiple concurrent status checks
      const checks = [];
      for (let i = 0; i < 20; i++) {
        checks.push(service.getStatus());
      }

      const results = await Promise.all(checks);

      // All should succeed and return consistent results
      for (const status of results) {
        expect(status).toBeDefined();
        expect(status.clean).toBe(true);
      }
    });
  });

  describe('getWorkspaceGitService singleton', () => {
    test('returns same instance for same workspace', () => {
      const service1 = getWorkspaceGitService(testDir);
      const service2 = getWorkspaceGitService(testDir);

      expect(service1).toBe(service2);
    });

    test('returns different instances for different workspaces', () => {
      const testDir2 = join(tmpdir(), `vellum-test-${Date.now()}-other`);
      mkdirSync(testDir2, { recursive: true });

      try {
        const service1 = getWorkspaceGitService(testDir);
        const service2 = getWorkspaceGitService(testDir2);

        expect(service1).not.toBe(service2);
        expect(service1.getWorkspaceDir()).toBe(testDir);
        expect(service2.getWorkspaceDir()).toBe(testDir2);
      } finally {
        rmSync(testDir2, { recursive: true, force: true });
      }
    });
  });

  describe('error handling', () => {
    test('handles invalid workspace directory', async () => {
      const invalidDir = '/nonexistent/path/that/does/not/exist';
      const service = new WorkspaceGitService(invalidDir);

      await expect(service.ensureInitialized()).rejects.toThrow();
    });

    test('failed initialization can be retried', async () => {
      // Create a service pointing to a directory that doesn't exist yet
      const retryDir = join(tmpdir(), `vellum-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const service = new WorkspaceGitService(retryDir);

      // First attempt: directory doesn't exist, should fail
      await expect(service.ensureInitialized()).rejects.toThrow();

      // Create the directory so the retry can succeed
      mkdirSync(retryDir, { recursive: true });

      try {
        // Second attempt: directory now exists, should succeed because
        // the .catch handler cleared initPromise after the first failure
        await service.ensureInitialized();
        expect(service.isInitialized()).toBe(true);

        // Verify the repo was actually initialized
        const log = execFileSync('git', ['log', '--oneline'], {
          cwd: retryDir,
          encoding: 'utf-8',
        });
        expect(log).toContain('Initial commit');
      } finally {
        rmSync(retryDir, { recursive: true, force: true });
      }
    });

    test('continues to work after failed operation', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Try to commit without any changes and without allow-empty
      // (This should succeed with --allow-empty, but let's test recovery)
      writeFileSync(join(testDir, 'test.txt'), 'content');
      await service.commitChanges('Valid commit');

      // Service should still work
      const status = await service.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe('existing repo normalization', () => {
    test('existing repo on feature branch auto-switches to main on init', async () => {
      // Set up a pre-existing git repo on a feature branch
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });
      execFileSync('git', ['checkout', '-b', 'feature-branch'], { cwd: testDir });

      // Verify we're on feature-branch
      const branchBefore = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branchBefore).toBe('feature-branch');

      // Initialize the service — should auto-switch to main
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branchAfter).toBe('main');
    });

    test('detached HEAD recovers to main on init', async () => {
      // Set up a pre-existing git repo then detach HEAD
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });
      // Detach HEAD by checking out the commit hash
      const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      execFileSync('git', ['checkout', commitHash], { cwd: testDir });

      // Verify we're in detached HEAD
      let isDetached = false;
      try {
        execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: testDir });
      } catch {
        isDetached = true;
      }
      expect(isDetached).toBe(true);

      // Initialize the service — should recover to main
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branchAfter).toBe('main');
    });

    test('existing repo on feature branch with dirty working tree switches to main', async () => {
      // Set up a pre-existing git repo on a feature branch with uncommitted changes.
      // This exercises the --discard-changes fallback in ensureOnMainLocked().
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'original content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });
      execFileSync('git', ['checkout', '-b', 'feature-branch'], { cwd: testDir });

      // Create uncommitted changes that would block a normal `git switch main`
      writeFileSync(join(testDir, 'file.txt'), 'modified on feature branch');

      // Verify we're on feature-branch with dirty working tree
      const branchBefore = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branchBefore).toBe('feature-branch');
      const statusBefore = execFileSync('git', ['status', '--porcelain'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(statusBefore).toContain('file.txt');

      // Initialize the service — should auto-switch to main despite dirty tree
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branchAfter).toBe('main');
    });

    test('existing repo gets .gitignore rules appended on init', async () => {
      // Set up a pre-existing git repo without our gitignore rules
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
      writeFileSync(join(testDir, '.gitignore'), 'node_modules/\n');
      writeFileSync(join(testDir, 'file.txt'), 'content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });

      // Verify .gitignore does NOT have our rules yet
      const contentBefore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(contentBefore).not.toContain('data/db/');
      expect(contentBefore).not.toContain('vellum.sock');

      // Initialize the service — should append rules
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const contentAfter = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(contentAfter).toContain('node_modules/');  // original rule preserved
      expect(contentAfter).toContain('data/db/');
      expect(contentAfter).toContain('data/qdrant/');
      expect(contentAfter).toContain('data/ipc-blobs/');
      expect(contentAfter).toContain('*.log');
      expect(contentAfter).toContain('vellum.sock');
      expect(contentAfter).toContain('session-token');
    });

    test('existing repo gets local identity set on init', async () => {
      // Set up a pre-existing git repo with a different identity
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Old Name'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'old@example.com'], { cwd: testDir });
      writeFileSync(join(testDir, 'file.txt'), 'content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });

      // Initialize the service — should set identity
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const userName = execFileSync('git', ['config', 'user.name'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      const userEmail = execFileSync('git', ['config', 'user.email'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();

      expect(userName).toBe('Vellum Assistant');
      expect(userEmail).toBe('assistant@vellum.ai');
    });

    test('existing repo with correct config is idempotent', async () => {
      // Set up a repo that already has everything configured correctly
      execFileSync('git', ['init', '-b', 'main'], { cwd: testDir });
      execFileSync('git', ['config', 'user.name', 'Vellum Assistant'], { cwd: testDir });
      execFileSync('git', ['config', 'user.email', 'assistant@vellum.ai'], { cwd: testDir });
      const gitignoreContent = '# Runtime state - excluded from git tracking\ndata/db/\ndata/qdrant/\ndata/ipc-blobs/\nlogs/\n*.log\n*.sock\n*.pid\n*.sqlite\n*.sqlite-journal\n*.sqlite-wal\n*.sqlite-shm\n*.db\n*.db-journal\n*.db-wal\n*.db-shm\nvellum.sock\nvellum.pid\nsession-token\nhttp-token\n';
      writeFileSync(join(testDir, '.gitignore'), gitignoreContent);
      writeFileSync(join(testDir, 'file.txt'), 'content');
      execFileSync('git', ['add', '-A'], { cwd: testDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: testDir });

      const gitignoreBefore = readFileSync(join(testDir, '.gitignore'), 'utf-8');

      // Initialize the service — should be a no-op
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Verify nothing changed
      const gitignoreAfter = readFileSync(join(testDir, '.gitignore'), 'utf-8');
      expect(gitignoreAfter).toBe(gitignoreBefore);

      const userName = execFileSync('git', ['config', 'user.name'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(userName).toBe('Vellum Assistant');

      const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(branch).toBe('main');

      // No errors, no duplicate rules
      const ruleCount = (gitignoreAfter.match(/data\/db\//g) || []).length;
      expect(ruleCount).toBe(1);
    });
  });

  describe('gitignore behavior', () => {
    test('ignores data/db/ but tracks other data/ subdirectories', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Create files in ignored data subdirectories
      mkdirSync(join(testDir, 'data', 'db'), { recursive: true });
      writeFileSync(join(testDir, 'data', 'db', 'conversations.sqlite'), 'db content');
      mkdirSync(join(testDir, 'data', 'qdrant'), { recursive: true });
      writeFileSync(join(testDir, 'data', 'qdrant', 'index.bin'), 'qdrant content');
      mkdirSync(join(testDir, 'data', 'ipc-blobs'), { recursive: true });
      writeFileSync(join(testDir, 'data', 'ipc-blobs', 'blob1'), 'ipc content');

      // Create files in tracked data subdirectories
      mkdirSync(join(testDir, 'data', 'memory'), { recursive: true });
      writeFileSync(join(testDir, 'data', 'memory', 'index.json'), '{}');
      mkdirSync(join(testDir, 'data', 'apps'), { recursive: true });
      writeFileSync(join(testDir, 'data', 'apps', 'state.json'), '{}');

      // Commit all changes, then verify what was included
      await service.commitChanges('test commit');

      const committedFiles = execFileSync(
        'git', ['diff', '--name-only', 'HEAD~1', 'HEAD'],
        { cwd: testDir, encoding: 'utf-8' },
      ).trim();

      // Ignored subdirectories should NOT be in the commit
      expect(committedFiles).not.toContain('data/db/');
      expect(committedFiles).not.toContain('data/qdrant/');
      expect(committedFiles).not.toContain('data/ipc-blobs/');

      // Tracked subdirectories SHOULD be in the commit
      expect(committedFiles).toContain('data/memory/index.json');
      expect(committedFiles).toContain('data/apps/state.json');
    });

    test('respects .gitignore for log files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'test.log'), 'log content');

      const status = await service.getStatus();

      // .log files should be ignored
      expect(status.untracked).not.toContain('test.log');
    });

    test('tracks non-ignored files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, 'config.json'), '{}');
      writeFileSync(join(testDir, 'README.md'), '# Test');

      const status = await service.getStatus();

      expect(status.untracked).toContain('config.json');
      expect(status.untracked).toContain('README.md');
    });
  });
});
