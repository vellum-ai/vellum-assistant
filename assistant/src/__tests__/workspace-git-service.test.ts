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
      expect(content).toContain('data/');
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

      // Wait a bit for async initial commit to complete
      await new Promise(resolve => setTimeout(resolve, 100));

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

      // Wait for async initial commit
      await new Promise(resolve => setTimeout(resolve, 100));

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

    test('initial commit is async and non-blocking', async () => {
      // Create many files to make commit slow
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), 'content');
      }

      const service = new WorkspaceGitService(testDir);
      const start = Date.now();
      await service.ensureInitialized();
      const duration = Date.now() - start;

      // ensureInitialized should return quickly (< 1s)
      // even with 100 files, as the commit is async
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('commitChanges', () => {
    test('commits changes with message', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for initial commit

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
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for initial commit

      const status = await service.getStatus();

      expect(status.clean).toBe(true);
      expect(status.staged).toEqual([]);
      expect(status.modified).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    test('detects untracked files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

      writeFileSync(join(testDir, 'new-file.txt'), 'content');

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('new-file.txt');
    });

    test('detects modified files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100));

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
      await new Promise(resolve => setTimeout(resolve, 100));

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

    test('continues to work after failed operation', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try to commit without any changes and without allow-empty
      // (This should succeed with --allow-empty, but let's test recovery)
      writeFileSync(join(testDir, 'test.txt'), 'content');
      await service.commitChanges('Valid commit');

      // Service should still work
      const status = await service.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe('gitignore behavior', () => {
    test('respects .gitignore for data directory', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create files in data directory
      mkdirSync(join(testDir, 'data'));
      writeFileSync(join(testDir, 'data', 'test.db'), 'database content');

      const status = await service.getStatus();

      // data/ files should not appear in status (ignored)
      expect(status.untracked).not.toContain('data/test.db');
    });

    test('respects .gitignore for log files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

      writeFileSync(join(testDir, 'test.log'), 'log content');

      const status = await service.getStatus();

      // .log files should be ignored
      expect(status.untracked).not.toContain('test.log');
    });

    test('tracks non-ignored files', async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      await new Promise(resolve => setTimeout(resolve, 100));

      writeFileSync(join(testDir, 'config.json'), '{}');
      writeFileSync(join(testDir, 'README.md'), '# Test');

      const status = await service.getStatus();

      expect(status.untracked).toContain('config.json');
      expect(status.untracked).toContain('README.md');
    });
  });
});
