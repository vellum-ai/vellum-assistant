import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _getConsecutiveFailures,
  _getInitConsecutiveFailures,
  _resetBreaker,
  _resetGitServiceRegistry,
  _resetInitBreaker,
  getWorkspaceGitService,
  isDeadlineExpired,
  WorkspaceGitService,
} from "../workspace/git-service.js";

describe("WorkspaceGitService", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(
      tmpdir(),
      `vellum-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("lazy initialization", () => {
    test("initializes git repo on first ensureInitialized call", async () => {
      const service = new WorkspaceGitService(testDir);

      expect(service.isInitialized()).toBe(false);

      await service.ensureInitialized();

      expect(service.isInitialized()).toBe(true);
      expect(existsSync(join(testDir, ".git"))).toBe(true);
    });

    test("creates .gitignore with proper exclusions", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const gitignorePath = join(testDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);

      const content = readFileSync(gitignorePath, "utf-8");
      expect(content).toContain("data/db/");
      expect(content).toContain("data/qdrant/");
      expect(content).toContain("*.log");
      expect(content).toContain("*.sock");
      expect(content).toContain("*.pid");
      expect(content).toContain("session-token");
      expect(content).toContain("node_modules/");
      expect(content).toContain("/embedding-models/");
      expect(content).toContain(".DS_Store");
      expect(content).toContain("*.png");
      expect(content).toContain("*.jsonl");
      expect(content).toContain("!conversations/**");
    });

    test("sets git identity correctly", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const userName = execFileSync("git", ["config", "user.name"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      const userEmail = execFileSync("git", ["config", "user.email"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();

      expect(userName).toBe("Vellum Assistant");
      expect(userEmail).toBe("assistant@vellum.ai");
    });

    test("installs branch guard hook that blocks non-main branches", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(hooksPath).toBe(".githooks");

      const hookPath = join(testDir, ".githooks", "reference-transaction");
      expect(existsSync(hookPath)).toBe(true);
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);

      const hookContent = readFileSync(hookPath, "utf-8");
      expect(hookContent).toContain(
        "assistant workspace git branches are disabled",
      );

      expect(() =>
        execFileSync("git", ["branch", "apollo/test-branch"], {
          cwd: testDir,
          encoding: "utf-8",
        }),
      ).toThrow(/assistant workspace git branches are disabled/);
    });

    test("branch guard allows deleting old non-main branches", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "branch", "old-branch"],
        {
          cwd: testDir,
        },
      );

      execFileSync("git", ["branch", "-D", "old-branch"], { cwd: testDir });

      const branches = execFileSync(
        "git",
        ["branch", "--format=%(refname:short)"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      );
      expect(branches).not.toContain("old-branch");
    });

    test("multiple ensureInitialized calls are idempotent", async () => {
      const service = new WorkspaceGitService(testDir);

      await service.ensureInitialized();
      await service.ensureInitialized();
      await service.ensureInitialized();

      expect(service.isInitialized()).toBe(true);
    });

    test("handles concurrent ensureInitialized calls", async () => {
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

  describe("initial commit", () => {
    test("creates initial commit for new empty workspace", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(log).toContain("Initial commit: new workspace");
    });

    test("creates initial commit for existing workspace with files", async () => {
      // Create some files before initializing git
      writeFileSync(join(testDir, "README.md"), "# Test\n");
      writeFileSync(join(testDir, "config.json"), "{}");
      mkdirSync(join(testDir, "subdir"));
      writeFileSync(join(testDir, "subdir", "file.txt"), "content");

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(log).toContain("Initial commit: migrated existing workspace");

      // Verify files were committed
      const files = execFileSync("git", ["ls-files"], {
        cwd: testDir,
        encoding: "utf-8",
      })
        .trim()
        .split("\n");

      expect(files).toContain(".gitignore");
      expect(files).toContain("README.md");
      expect(files).toContain("config.json");
      expect(files).toContain("subdir/file.txt");
    });

    test("initial commit completes within ensureInitialized", async () => {
      // Create some files before initializing git
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), "content");
      }

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Initial commit should already be done - no need to wait
      const log = execFileSync("git", ["log", "--oneline"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(log).toContain("Initial commit: migrated existing workspace");
    });

    test("initial commit does not race with first commitChanges", async () => {
      // Pre-populate workspace with files (simulating a migrated workspace)
      writeFileSync(join(testDir, "existing.txt"), "pre-existing content");

      const service = new WorkspaceGitService(testDir);

      // Initialize - the initial commit now happens synchronously within
      // ensureInitialized, so it completes before we can write new files.
      await service.ensureInitialized();

      // Now write a file AFTER init and commit it
      writeFileSync(join(testDir, "user-edit.txt"), "user content");
      await service.commitChanges("User turn 1");

      // The user's commit (HEAD) should contain user-edit.txt
      const userCommitFiles = execFileSync(
        "git",
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        { cwd: testDir, encoding: "utf-8" },
      ).trim();

      expect(userCommitFiles).toContain("user-edit.txt");
      // user-edit.txt should NOT appear in the initial commit
      expect(userCommitFiles).not.toContain("existing.txt");

      // The initial commit (HEAD~1) should contain existing.txt and .gitignore
      const initialCommitFiles = execFileSync(
        "git",
        ["show", "--name-only", "--pretty=format:", "HEAD~1"],
        { cwd: testDir, encoding: "utf-8" },
      ).trim();

      expect(initialCommitFiles).toContain("existing.txt");
      expect(initialCommitFiles).toContain(".gitignore");
      // The initial commit should NOT contain user-edit.txt
      expect(initialCommitFiles).not.toContain("user-edit.txt");
    });
  });

  describe("commitChanges", () => {
    test("commits changes with message", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "hello world");
      await service.commitChanges("Add test file");

      const log = execFileSync("git", ["log", "--oneline", "-n", "1"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(log).toContain("Add test file");
    });

    test("commits with metadata", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");
      await service.commitChanges("Add file", {
        conversationId: "session-123",
        timestamp: 1234567890,
        author: "user@example.com",
      });

      const message = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(message).toContain("Add file");
      expect(message).toContain('conversationId: "session-123"');
      expect(message).toContain("timestamp: 1234567890");
      expect(message).toContain('author: "user@example.com"');
    });

    test("commits multiple files at once", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "file1.txt"), "content1");
      writeFileSync(join(testDir, "file2.txt"), "content2");
      writeFileSync(join(testDir, "file3.txt"), "content3");

      await service.commitChanges("Add multiple files");

      const files = execFileSync(
        "git",
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      )
        .trim()
        .split("\n");

      expect(files).toContain("file1.txt");
      expect(files).toContain("file2.txt");
      expect(files).toContain("file3.txt");
    });

    test("allows empty commits", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Commit without any changes
      await service.commitChanges("Empty commit for checkpoint");

      const log = execFileSync("git", ["log", "--oneline", "-n", "1"], {
        cwd: testDir,
        encoding: "utf-8",
      });

      expect(log).toContain("Empty commit for checkpoint");
    });
  });

  describe("getStatus", () => {
    test("returns clean status for new workspace", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const status = await service.getStatus();

      expect(status.clean).toBe(true);
      expect(status.staged).toEqual([]);
      expect(status.modified).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    test("detects untracked files", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "new-file.txt"), "content");

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.untracked).toContain("new-file.txt");
    });

    test("detects modified files", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "file.txt"), "original");
      await service.commitChanges("Add file");

      writeFileSync(join(testDir, "file.txt"), "modified");

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.modified).toContain("file.txt");
    });

    test("detects staged files", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "file.txt"), "content");

      // Manually stage the file
      execFileSync("git", ["add", "file.txt"], { cwd: testDir });

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.staged).toContain("file.txt");
    });

    test("tolerates porcelain output larger than 1 MB without throwing", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // git status --porcelain prints one line per untracked entry. Enough
      // long-named entries push the output well past Node's 1 MB execFile
      // maxBuffer; the streamed read must handle it without surfacing
      // ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Files live in the (tracked) root
      // so git reports them individually instead of collapsing a dir.
      const fileCount = 6000;
      const pad = "a".repeat(200);
      for (let i = 0; i < fileCount; i++) {
        writeFileSync(
          join(testDir, `f${String(i).padStart(6, "0")}-${pad}`),
          "",
        );
      }

      const status = await service.getStatus();

      expect(status.clean).toBe(false);
      expect(status.untracked.length).toBe(fileCount);
    });
  });

  describe("mutex locking", () => {
    test("serializes concurrent commit operations", async () => {
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

      // Read through the service so GIT_* vars set by CI runners are stripped
      // (matches the env used for the commits themselves).
      const { stdout: log } = await service.runReadOnlyGit([
        "log",
        "--oneline",
      ]);

      for (let i = 0; i < 10; i++) {
        expect(log).toContain(`Add file ${i}`);
      }

      // Count commits (excluding initial commit)
      const commitCount = log.trim().split("\n").length;
      expect(commitCount).toBe(11); // 10 + 1 initial
    });

    test("serializes concurrent status checks", async () => {
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

  describe("getWorkspaceGitService singleton", () => {
    test("returns same instance for same workspace", () => {
      const service1 = getWorkspaceGitService(testDir);
      const service2 = getWorkspaceGitService(testDir);

      expect(service1).toBe(service2);
    });

    test("returns different instances for different workspaces", () => {
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

  describe("error handling", () => {
    test("handles invalid workspace directory", async () => {
      const invalidDir = "/nonexistent/path/that/does/not/exist";
      const service = new WorkspaceGitService(invalidDir);

      await expect(service.ensureInitialized()).rejects.toThrow();
    });

    test("failed initialization can be retried", async () => {
      // Create a service pointing to a directory that doesn't exist yet
      const retryDir = join(
        tmpdir(),
        `vellum-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
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
        const log = execFileSync("git", ["log", "--oneline"], {
          cwd: retryDir,
          encoding: "utf-8",
        });
        expect(log).toContain("Initial commit");
      } finally {
        rmSync(retryDir, { recursive: true, force: true });
      }
    });

    test("continues to work after failed operation", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Try to commit without any changes and without allow-empty
      // (This should succeed with --allow-empty, but let's test recovery)
      writeFileSync(join(testDir, "test.txt"), "content");
      await service.commitChanges("Valid commit");

      // Service should still work
      const status = await service.getStatus();
      expect(status).toBeDefined();
    });
  });

  describe("existing repo normalization", () => {
    test("existing repo on feature branch auto-switches to main on init", async () => {
      // Set up a pre-existing git repo on a feature branch
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });
      execFileSync("git", ["checkout", "-b", "feature-branch"], {
        cwd: testDir,
      });

      // Verify we're on feature-branch
      const branchBefore = execFileSync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      ).trim();
      expect(branchBefore).toBe("feature-branch");

      // Initialize the service — should auto-switch to main
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      ).trim();
      expect(branchAfter).toBe("main");
    });

    test("detached HEAD recovers to main on init", async () => {
      // Set up a pre-existing git repo then detach HEAD
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });
      // Detach HEAD by checking out the commit hash
      const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      execFileSync("git", ["checkout", commitHash], { cwd: testDir });

      // Verify we're in detached HEAD
      let isDetached = false;
      try {
        execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: testDir,
        });
      } catch {
        isDetached = true;
      }
      expect(isDetached).toBe(true);

      // Initialize the service — should recover to main
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      ).trim();
      expect(branchAfter).toBe("main");
    });

    test("existing repo on feature branch with dirty working tree switches to main", async () => {
      // Set up a pre-existing git repo on a feature branch with uncommitted changes.
      // This exercises the --discard-changes fallback in ensureOnMainLocked().
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "file.txt"), "original content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });
      execFileSync("git", ["checkout", "-b", "feature-branch"], {
        cwd: testDir,
      });

      // Create uncommitted changes that would block a normal `git switch main`
      writeFileSync(join(testDir, "file.txt"), "modified on feature branch");

      // Verify we're on feature-branch with dirty working tree
      const branchBefore = execFileSync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      ).trim();
      expect(branchBefore).toBe("feature-branch");
      const statusBefore = execFileSync("git", ["status", "--porcelain"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(statusBefore).toContain("file.txt");

      // Initialize the service — should auto-switch to main despite dirty tree
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const branchAfter = execFileSync(
        "git",
        ["symbolic-ref", "--short", "HEAD"],
        {
          cwd: testDir,
          encoding: "utf-8",
        },
      ).trim();
      expect(branchAfter).toBe("main");
    });

    test("gitignore rules and untracking apply to main after a branch switch", async () => {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      // main: committed runtime junk and a .gitignore without Vellum rules
      writeFileSync(join(testDir, ".gitignore"), "main-rule\n");
      mkdirSync(join(testDir, "embedding-models"), { recursive: true });
      writeFileSync(join(testDir, "embedding-models", "model.bin"), "weights");
      writeFileSync(join(testDir, "notes.md"), "keep me");
      execFileSync("git", ["add", "-A", "-f"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });
      // Checked out on a branch whose .gitignore differs from main's
      execFileSync("git", ["checkout", "-b", "legacy"], { cwd: testDir });
      writeFileSync(join(testDir, ".gitignore"), "legacy-rule\n");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "legacy rule"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Landed on main with the Vellum rules applied to MAIN's .gitignore
      const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(branch).toBe("main");
      const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(content).toContain("main-rule");
      expect(content).toContain("data/db/");

      // Untracking ran against main's index
      const tracked = execFileSync("git", ["ls-files"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(tracked).not.toContain("embedding-models/model.bin");
      expect(tracked).toContain("notes.md");
    });

    test("existing repo gets .gitignore rules appended on init", async () => {
      // Set up a pre-existing git repo without our gitignore rules
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, ".gitignore"), "node_modules/\n");
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      // Verify .gitignore does NOT have our rules yet
      const contentBefore = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(contentBefore).not.toContain("data/db/");

      // Initialize the service — should append rules
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const contentAfter = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(contentAfter).toContain("node_modules/"); // original rule preserved
      expect(contentAfter).toContain("data/db/");
      expect(contentAfter).toContain("data/qdrant/");
      expect(contentAfter).toContain("*.log");
      expect(contentAfter).toContain("*.sock");
      expect(contentAfter).toContain("session-token");
    });

    test("existing repo with committed runtime state gets it untracked on init", async () => {
      // Repo that committed runtime state before the ignore rule existed
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      mkdirSync(join(testDir, "embedding-models"), { recursive: true });
      writeFileSync(join(testDir, "embedding-models", "model.bin"), "weights");
      writeFileSync(join(testDir, "notes.md"), "keep me");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Now-ignored path is dropped from the index; tracked files survive.
      const tracked = execFileSync("git", ["ls-files"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(tracked).not.toContain("embedding-models/model.bin");
      expect(tracked).toContain("notes.md");

      // Working tree is untouched — only the index entry is removed.
      expect(existsSync(join(testDir, "embedding-models", "model.bin"))).toBe(
        true,
      );

      // The staged deletion rides along with the next commit and the file
      // is not re-added despite `git add -A`.
      await service.commitChanges("next turn");
      const headFiles = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", "HEAD"],
        { cwd: testDir, encoding: "utf-8" },
      );
      expect(headFiles).not.toContain("embedding-models/model.bin");
      expect(headFiles).toContain("notes.md");
    });

    test("partial init with staged now-ignored files drops them from the initial commit", async () => {
      // Interrupted previous init: `.git` exists with staged files, no commit
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      mkdirSync(join(testDir, "embedding-models"), { recursive: true });
      writeFileSync(join(testDir, "embedding-models", "model.bin"), "weights");
      writeFileSync(join(testDir, "notes.md"), "keep me");
      execFileSync("git", ["add", "-A"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const headFiles = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", "HEAD"],
        { cwd: testDir, encoding: "utf-8" },
      );
      expect(headFiles).not.toContain("embedding-models/model.bin");
      expect(headFiles).toContain("notes.md");
    });

    test("untracking is limited to Vellum rules and keeps avatar/sounds state", async () => {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      // Canonical user state that matches the media extension rules
      mkdirSync(join(testDir, "data", "avatar"), { recursive: true });
      writeFileSync(join(testDir, "data", "avatar", "avatar-image.png"), "img");
      mkdirSync(join(testDir, "data", "sounds"), { recursive: true });
      writeFileSync(join(testDir, "data", "sounds", "ding.mp3"), "snd");
      mkdirSync(join(testDir, "data", "apps", "my-app", "dist"), {
        recursive: true,
      });
      writeFileSync(join(testDir, "data", "apps", "my-app", "icon.png"), "ic");
      writeFileSync(
        join(testDir, "data", "apps", "my-app", "dist", "bundle.png"),
        "junk",
      );
      // Conversation disk views survive the *.jsonl rule
      mkdirSync(join(testDir, "conversations", "conv-1"), { recursive: true });
      writeFileSync(
        join(testDir, "conversations", "conv-1", "messages.jsonl"),
        "{}",
      );
      // Media junk elsewhere that should be untracked
      mkdirSync(join(testDir, "pkb"), { recursive: true });
      writeFileSync(join(testDir, "pkb", "photo.png"), "junk");
      // Tracked file matching only the user's repo-local exclude file — the
      // untrack step must not consult it.
      writeFileSync(join(testDir, "fixture-keep.md"), "keep");
      writeFileSync(
        join(testDir, ".git", "info", "exclude"),
        "fixture-keep.md\n",
      );
      // Force-added despite a user-authored .gitignore rule — the untrack
      // step matches Vellum-managed rules only, so it must stay tracked.
      writeFileSync(join(testDir, ".gitignore"), "user-secret.md\n");
      writeFileSync(join(testDir, "user-secret.md"), "keep");
      execFileSync("git", ["add", "-A", "-f"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const tracked = execFileSync("git", ["ls-files"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(tracked).toContain("data/avatar/avatar-image.png");
      expect(tracked).toContain("data/sounds/ding.mp3");
      expect(tracked).toContain("data/apps/my-app/icon.png");
      expect(tracked).toContain("conversations/conv-1/messages.jsonl");
      expect(tracked).toContain("fixture-keep.md");
      expect(tracked).toContain("user-secret.md");
      expect(tracked).not.toContain("pkb/photo.png");
      // The icon negation must not drag dist/ back in
      expect(tracked).not.toContain("data/apps/my-app/dist/bundle.png");
    });

    test("appending rules keeps negations last even when already present mid-file", async () => {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      // Negation already present BEFORE the extension rules get appended —
      // if it stayed there, a later *.png would win and re-ignore the avatar.
      writeFileSync(
        join(testDir, ".gitignore"),
        "!data/avatar/**\nnode_modules/\n",
      );
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const content = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(content.lastIndexOf("!data/avatar/**")).toBeGreaterThan(
        content.indexOf("*.png"),
      );

      // Effective behavior: the avatar path is not ignored (check-ignore
      // exits 1 → throws), media elsewhere is (exits 0).
      expect(() =>
        execFileSync(
          "git",
          ["check-ignore", "-q", "data/avatar/avatar-image.png"],
          { cwd: testDir },
        ),
      ).toThrow();
      execFileSync("git", ["check-ignore", "-q", "pkb/photo.png"], {
        cwd: testDir,
      });
    });

    test("existing repo with old data/ rule gets it replaced with selective rules", async () => {
      // Set up a pre-existing git repo with the OLD broad data/ rule
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      const oldGitignore =
        "# Runtime state - excluded from git tracking\ndata/\nlogs/\n*.log\n*.sock\n*.pid\n*.sqlite\n*.sqlite-journal\n*.sqlite-wal\n*.sqlite-shm\n*.db\n*.db-journal\n*.db-wal\n*.db-shm\nvellum.pid\nsession-token\n";
      writeFileSync(join(testDir, ".gitignore"), oldGitignore);
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      // Verify the old broad rule is present
      const contentBefore = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(contentBefore).toContain("data/\n");

      // Initialize the service — should migrate the gitignore
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const contentAfter = readFileSync(join(testDir, ".gitignore"), "utf-8");

      // Old broad rule should be removed
      expect(contentAfter).not.toMatch(/^data\/$/m);

      // New selective rules should be present
      expect(contentAfter).toContain("data/db/");
      expect(contentAfter).toContain("data/qdrant/");

      // Other existing rules should be preserved
      expect(contentAfter).toContain("logs/");
      expect(contentAfter).toContain("*.log");
      expect(contentAfter).toContain("*.sock");
    });

    test("existing repo gets local identity set on init", async () => {
      // Set up a pre-existing git repo with a different identity
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Old Name"], {
        cwd: testDir,
      });
      execFileSync("git", ["config", "user.email", "old@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      // Initialize the service — should set identity
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const userName = execFileSync("git", ["config", "user.name"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      const userEmail = execFileSync("git", ["config", "user.email"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();

      expect(userName).toBe("Vellum Assistant");
      expect(userEmail).toBe("assistant@vellum.ai");
    });

    test("existing repo gets branch guard installed on init", async () => {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const hooksPath = execFileSync("git", ["config", "core.hooksPath"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(hooksPath).toBe(".githooks");
      expect(
        existsSync(join(testDir, ".githooks", "reference-transaction")),
      ).toBe(true);

      expect(() =>
        execFileSync("git", ["branch", "feature-after-init"], {
          cwd: testDir,
          encoding: "utf-8",
        }),
      ).toThrow(/assistant workspace git branches are disabled/);
    });

    test("existing repo with correct config is idempotent", async () => {
      // Set up a repo that already has everything configured correctly
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Vellum Assistant"], {
        cwd: testDir,
      });
      execFileSync("git", ["config", "user.email", "assistant@vellum.ai"], {
        cwd: testDir,
      });
      const gitignoreContent =
        "# Runtime state - excluded from git tracking\ndata/db/\ndata/qdrant/\ndata/monitoring/\ndata/apps/*/records/\ndata/apps/*/dist/\ndata/apps/*.preview\n/embedding-models/\n/external/\n/bin/\n/plugins-data/\nnode_modules/\n__pycache__/\n.venv/\nlogs/\n*.log\n*.jsonl\n*.sock\n*.pid\ndaemon-startup.lock\nsession-token\n*.sqlite*\n*.db\n*.db-*\n.DS_Store\n*.zip\n*.tar\n*.gz\n*.tgz\n*.bz2\n*.xz\n*.7z\n*.rar\n*.dmg\n*.iso\n*.png\n*.jpg\n*.jpeg\n*.gif\n*.webp\n*.heic\n*.bmp\n*.tiff\n*.mp3\n*.wav\n*.m4a\n*.flac\n*.ogg\n*.mp4\n*.mov\n*.avi\n*.mkv\n*.webm\n*.pdf\n*.gguf\n*.onnx\n*.safetensors\n*.pt\n*.pth\n!data/avatar/**\n!data/sounds/**\n!data/apps/*/icon.png\n!conversations/**\n";
      writeFileSync(join(testDir, ".gitignore"), gitignoreContent);
      writeFileSync(join(testDir, "file.txt"), "content");
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: testDir });

      const gitignoreBefore = readFileSync(
        join(testDir, ".gitignore"),
        "utf-8",
      );

      // Initialize the service — should be a no-op
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Verify nothing changed
      const gitignoreAfter = readFileSync(join(testDir, ".gitignore"), "utf-8");
      expect(gitignoreAfter).toBe(gitignoreBefore);

      const userName = execFileSync("git", ["config", "user.name"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(userName).toBe("Vellum Assistant");

      const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(branch).toBe("main");

      // No errors, no duplicate rules
      const ruleCount = (gitignoreAfter.match(/data\/db\//g) || []).length;
      expect(ruleCount).toBe(1);
    });
  });

  describe("gitignore behavior", () => {
    test("ignores data/db/ but tracks other data/ subdirectories", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Create files in ignored data subdirectories
      mkdirSync(join(testDir, "data", "db"), { recursive: true });
      writeFileSync(
        join(testDir, "data", "db", "conversations.sqlite"),
        "db content",
      );
      mkdirSync(join(testDir, "data", "qdrant"), { recursive: true });
      writeFileSync(
        join(testDir, "data", "qdrant", "index.bin"),
        "qdrant content",
      );
      // Create files in tracked data subdirectories
      mkdirSync(join(testDir, "data", "memory"), { recursive: true });
      writeFileSync(join(testDir, "data", "memory", "index.json"), "{}");
      mkdirSync(join(testDir, "data", "apps"), { recursive: true });
      writeFileSync(join(testDir, "data", "apps", "state.json"), "{}");

      // Commit all changes, then verify what was included
      await service.commitChanges("test commit");

      const committedFiles = execFileSync(
        "git",
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        { cwd: testDir, encoding: "utf-8" },
      ).trim();

      // Ignored subdirectories should NOT be in the commit
      expect(committedFiles).not.toContain("data/db/");
      expect(committedFiles).not.toContain("data/qdrant/");

      // Non-ignored data subdirectories SHOULD be in the commit
      expect(committedFiles).toContain("data/memory/index.json");
      expect(committedFiles).toContain("data/apps/state.json");
    });

    test("respects .gitignore for log files", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.log"), "log content");

      const status = await service.getStatus();

      // .log files should be ignored
      expect(status.untracked).not.toContain("test.log");
    });

    test("tracks non-ignored files", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "config.json"), "{}");
      writeFileSync(join(testDir, "README.md"), "# Test");

      const status = await service.getStatus();

      expect(status.untracked).toContain("config.json");
      expect(status.untracked).toContain("README.md");
    });

    test("excludes plugin node_modules from computed status", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Track the plugin dir first so git reports finer-grained untracked
      // entries — an entirely-untracked dir collapses to a single line and
      // would hide whether node_modules was filtered.
      mkdirSync(join(testDir, "plugins", "image-fallback"), {
        recursive: true,
      });
      writeFileSync(
        join(testDir, "plugins", "image-fallback", "index.js"),
        "x",
      );
      await service.commitChanges("add plugin");

      // Plugin dependencies (ignored) alongside a real source change.
      mkdirSync(
        join(testDir, "plugins", "image-fallback", "node_modules", "dep"),
        { recursive: true },
      );
      writeFileSync(
        join(
          testDir,
          "plugins",
          "image-fallback",
          "node_modules",
          "dep",
          "big.js",
        ),
        "module.exports = {}",
      );
      writeFileSync(
        join(testDir, "plugins", "image-fallback", "other.js"),
        "y",
      );

      const status = await service.getStatus();

      const allEntries = [
        ...status.staged,
        ...status.modified,
        ...status.untracked,
      ];
      expect(allEntries.some((f) => f.includes("node_modules"))).toBe(false);
      expect(status.untracked).toContain("plugins/image-fallback/other.js");
    });
  });

  describe("deadline-aware commitIfDirty", () => {
    test("deadline expired before lock acquisition skips commit quickly", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Create a file so the workspace is dirty
      writeFileSync(join(testDir, "test.txt"), "content");

      // Use a deadline that has already passed
      const pastDeadline = Date.now() - 1000;
      const result = await service.commitIfDirty(
        () => ({ message: "should not commit" }),
        { deadlineMs: pastDeadline },
      );

      expect(result.committed).toBe(false);

      // File should still be uncommitted
      const status = await service.getStatus();
      expect(status.clean).toBe(false);
      expect(status.untracked).toContain("test.txt");
    });

    test("deadline far in the future allows commit to proceed", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Use a deadline far in the future
      const futureDeadline = Date.now() + 60_000;
      const result = await service.commitIfDirty(
        () => ({ message: "deadline commit" }),
        { deadlineMs: futureDeadline },
      );

      expect(result.committed).toBe(true);

      // Verify the commit was actually created
      const log = execFileSync("git", ["log", "--oneline", "-n", "1"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(log).toContain("deadline commit");
    });

    test("no deadline option allows commit as normal", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // No deadline option at all
      const result = await service.commitIfDirty(() => ({
        message: "no deadline commit",
      }));

      expect(result.committed).toBe(true);
    });
  });

  describe("breaker re-check under lock", () => {
    test("queued call that acquires lock after breaker opens skips commit", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Simulate a breaker that opened between the pre-lock check and lock acquisition.
      // We do this by:
      // 1. Starting a commitIfDirty call (which passes the pre-lock breaker check)
      // 2. Forcing the breaker open while the call is in progress

      // First, force the breaker open by setting internal state directly.
      // Since commitIfDirty re-checks the breaker after acquiring the lock,
      // a call that passes the pre-lock check but finds the breaker open
      // after acquiring the lock should bail out.
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 5;
      internal.nextAllowedAttemptMs = Date.now() + 60_000; // far in the future

      // With breaker open, commitIfDirty should skip (pre-lock check)
      const result = await service.commitIfDirty(() => ({
        message: "should not commit",
      }));
      expect(result.committed).toBe(false);

      // Reset breaker
      _resetBreaker(service);

      // Now the commit should proceed normally
      const result2 = await service.commitIfDirty(() => ({
        message: "after breaker reset",
      }));
      expect(result2.committed).toBe(true);
    });

    test("breaker early return inside lock does not reset breaker via recordSuccess", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Force breaker open with known failure count
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 5;
      internal.nextAllowedAttemptMs = Date.now() + 60_000;

      // Pre-lock check catches the open breaker and returns early.
      // Verify that consecutiveFailures is NOT reset to 0.
      const result = await service.commitIfDirty(() => ({
        message: "should not commit",
      }));
      expect(result.committed).toBe(false);
      expect(_getConsecutiveFailures(service)).toBe(5);
    });

    test("deadline early return inside lock does not reset breaker via recordSuccess", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Set up prior failures (breaker closed but failures recorded)
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 3;
      // Set nextAllowedAttemptMs in the past so the breaker check passes
      // but consecutiveFailures is non-zero
      internal.nextAllowedAttemptMs = Date.now() - 1000;

      // Use a deadline that has already passed — this triggers the pre-lock
      // deadline fast-path. consecutiveFailures should NOT be reset.
      const result = await service.commitIfDirty(
        () => ({ message: "should not commit" }),
        { deadlineMs: Date.now() - 1000 },
      );
      expect(result.committed).toBe(false);
      expect(_getConsecutiveFailures(service)).toBe(3);
    });

    test("successful git operation after failures resets breaker", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Set up prior failures with breaker closed (backoff expired)
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 3;
      internal.nextAllowedAttemptMs = Date.now() - 1000;

      // Commit should succeed and reset the breaker
      const result = await service.commitIfDirty(() => ({
        message: "recovery commit",
      }));
      expect(result.committed).toBe(true);
      expect(_getConsecutiveFailures(service)).toBe(0);
    });

    test("bypassBreaker ignores breaker state", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Force breaker open
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 5;
      internal.nextAllowedAttemptMs = Date.now() + 60_000;

      // With bypassBreaker, commit should succeed despite open breaker
      const result = await service.commitIfDirty(
        () => ({ message: "bypass breaker commit" }),
        { bypassBreaker: true },
      );
      expect(result.committed).toBe(true);
    });
  });

  describe("commitIfDirty status read resilience", () => {
    test("status read failure does not trip the circuit breaker", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "test.txt"), "content");

      // Simulate an oversized/failed `git status` read by making the streamed
      // status call throw the way Node's maxBuffer overflow would.
      const proto = Object.getPrototypeOf(service);
      const originalStreaming = proto.execGitStreaming;
      proto.execGitStreaming = async function () {
        const err = new Error(
          "Git command failed: git status --porcelain\n" +
            "Error: stdout maxBuffer length exceeded",
        ) as Error & { code?: string };
        err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        throw err;
      };

      try {
        const result = await service.commitIfDirty(() => ({
          message: "should not commit",
        }));
        // Degrades to "no commit this tick" rather than throwing.
        expect(result.committed).toBe(false);
        // Breaker stays closed so the next cycle still runs.
        expect(_getConsecutiveFailures(service)).toBe(0);
      } finally {
        proto.execGitStreaming = originalStreaming;
      }

      // Once status recovers, auto-commit proceeds — it was never disabled.
      const recovered = await service.commitIfDirty(() => ({
        message: "after status recovery",
      }));
      expect(recovered.committed).toBe(true);
    });
  });

  describe("commitIfDirty diff error handling", () => {
    test("non-1 exit code from git diff --cached --quiet is treated as an error", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Create a file so the workspace is dirty and commitIfDirty will
      // proceed past the "clean" early-return.
      writeFileSync(join(testDir, "test.txt"), "content");

      // Access the private execGit method and wrap it so that
      // 'git diff --cached --quiet' throws with exit code 2 (simulating
      // a real git error rather than the expected exit code 1 for
      // "staged changes exist").
      const proto = Object.getPrototypeOf(service);
      const originalExecGit = proto.execGit;
      proto.execGit = async function (this: unknown, args: string[]) {
        if (
          args[0] === "diff" &&
          args[1] === "--cached" &&
          args[2] === "--quiet"
        ) {
          const err = new Error(
            "Git command failed: git diff --cached --quiet\nError: simulated error\nStderr: ",
          ) as Error & { code?: number };
          err.code = 2;
          throw err;
        }
        return originalExecGit.call(this, args);
      };

      try {
        // commitIfDirty should propagate the error (not treat code 2 as
        // "staged changes exist")
        await expect(
          service.commitIfDirty(() => ({ message: "should not commit" })),
        ).rejects.toThrow();
      } finally {
        // Restore the original method
        proto.execGit = originalExecGit;
      }
    });
  });

  describe("init circuit breaker", () => {
    test("init breaker opens after consecutive failures", async () => {
      // Use a directory that doesn't exist so init fails
      const badDir = "/nonexistent/path/that/does/not/exist";
      const service = new WorkspaceGitService(badDir);

      // First failure — breaker does NOT open (requires 2+ failures)
      await expect(service.ensureInitialized()).rejects.toThrow();
      expect(_getInitConsecutiveFailures(service)).toBe(1);

      // Second failure — expire the backoff window from the first failure
      // so the attempt actually runs (not blocked by breaker).
      const internal = service as unknown as {
        initNextAllowedAttemptMs: number;
      };
      internal.initNextAllowedAttemptMs = Date.now() - 1;

      await expect(service.ensureInitialized()).rejects.toThrow();
      expect(_getInitConsecutiveFailures(service)).toBe(2);

      // Third attempt within the backoff window — breaker is now open
      // (2+ consecutive failures) so the attempt is skipped.
      await expect(service.ensureInitialized()).rejects.toThrow(
        "Init circuit breaker open: backing off after repeated failures",
      );
      // Failure count should NOT increase (the breaker prevented the attempt)
      expect(_getInitConsecutiveFailures(service)).toBe(2);
    });

    test("init breaker skips init attempts during backoff window", async () => {
      const service = new WorkspaceGitService(testDir);

      // Force the init breaker open
      const internal = service as unknown as {
        initConsecutiveFailures: number;
        initNextAllowedAttemptMs: number;
      };
      internal.initConsecutiveFailures = 3;
      internal.initNextAllowedAttemptMs = Date.now() + 60_000; // far in the future

      // ensureInitialized should throw with circuit breaker message
      await expect(service.ensureInitialized()).rejects.toThrow(
        "Init circuit breaker open: backing off after repeated failures",
      );

      // Failure count should NOT increase (the breaker prevented the attempt)
      expect(_getInitConsecutiveFailures(service)).toBe(3);
    });

    test("init breaker resets on success", async () => {
      const service = new WorkspaceGitService(testDir);

      // Simulate prior init failures
      const internal = service as unknown as {
        initConsecutiveFailures: number;
        initNextAllowedAttemptMs: number;
      };
      internal.initConsecutiveFailures = 3;
      // Set backoff in the past so the breaker is closed and allows retry
      internal.initNextAllowedAttemptMs = Date.now() - 1;

      // This should succeed and reset the init breaker
      await service.ensureInitialized();

      expect(_getInitConsecutiveFailures(service)).toBe(0);
      expect(service.isInitialized()).toBe(true);
    });

    test("init breaker allows retry after backoff window expires", async () => {
      const service = new WorkspaceGitService(testDir);

      // Simulate prior init failures with expired backoff
      const internal = service as unknown as {
        initConsecutiveFailures: number;
        initNextAllowedAttemptMs: number;
      };
      internal.initConsecutiveFailures = 5;
      internal.initNextAllowedAttemptMs = Date.now() - 1; // expired

      // Breaker should be closed (backoff expired), allowing init to proceed
      await service.ensureInitialized();

      expect(_getInitConsecutiveFailures(service)).toBe(0);
      expect(service.isInitialized()).toBe(true);
    });

    test("init breaker is independent from commit breaker", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Force commit breaker open
      const internal = service as unknown as {
        consecutiveFailures: number;
        nextAllowedAttemptMs: number;
      };
      internal.consecutiveFailures = 5;
      internal.nextAllowedAttemptMs = Date.now() + 60_000;

      // Init breaker should still be clean
      expect(_getInitConsecutiveFailures(service)).toBe(0);

      // Commit breaker should be open
      expect(_getConsecutiveFailures(service)).toBe(5);

      // Reset commit breaker
      _resetBreaker(service);

      // Force init breaker open
      const internal2 = service as unknown as {
        initConsecutiveFailures: number;
        initNextAllowedAttemptMs: number;
      };
      internal2.initConsecutiveFailures = 3;
      internal2.initNextAllowedAttemptMs = Date.now() + 60_000;

      // Commit breaker should be clean
      expect(_getConsecutiveFailures(service)).toBe(0);

      // Init breaker should be open
      expect(_getInitConsecutiveFailures(service)).toBe(3);

      // Reset init breaker
      _resetInitBreaker(service);
      expect(_getInitConsecutiveFailures(service)).toBe(0);
    });

    test("already initialized service bypasses init breaker check", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      expect(service.isInitialized()).toBe(true);

      // Force init breaker open
      const internal = service as unknown as {
        initConsecutiveFailures: number;
        initNextAllowedAttemptMs: number;
      };
      internal.initConsecutiveFailures = 5;
      internal.initNextAllowedAttemptMs = Date.now() + 60_000;

      // ensureInitialized should succeed via the fast path (already initialized)
      // without hitting the breaker
      await service.ensureInitialized();
    });
  });

  describe("isDeadlineExpired helper", () => {
    test("returns false when deadlineMs is undefined", () => {
      expect(isDeadlineExpired(undefined)).toBe(false);
    });

    test("returns false when deadline is in the future", () => {
      expect(isDeadlineExpired(Date.now() + 60_000)).toBe(false);
    });

    test("returns true when deadline is in the past", () => {
      expect(isDeadlineExpired(Date.now() - 1000)).toBe(true);
    });

    test("returns true when deadline equals current time", () => {
      const now = Date.now();
      // Use a deadline slightly in the past to avoid timing flakes
      expect(isDeadlineExpired(now - 1)).toBe(true);
    });
  });

  describe("git hook hardening", () => {
    test("does not execute pre-commit hooks during commitChanges", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const hookPath = join(testDir, ".git", "hooks", "pre-commit");
      const markerPath = join(testDir, "hook-ran.txt");
      writeFileSync(
        hookPath,
        `#!/bin/sh\necho hook-ran > "${markerPath}"\nexit 1\n`,
      );
      chmodSync(hookPath, 0o755);

      writeFileSync(join(testDir, "test.txt"), "content");
      await service.commitChanges("Add file safely");

      expect(existsSync(markerPath)).toBe(false);
    });

    test("does not execute hooks configured via core.hooksPath during commitIfDirty", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const hooksDir = join(testDir, "custom-hooks");
      mkdirSync(hooksDir, { recursive: true });
      const markerPath = join(testDir, "core-hooks-ran.txt");
      const hookPath = join(hooksDir, "pre-commit");
      writeFileSync(
        hookPath,
        `#!/bin/sh\necho core-hooks-ran > "${markerPath}"\nexit 1\n`,
      );
      chmodSync(hookPath, 0o755);
      execFileSync("git", ["config", "core.hooksPath", hooksDir], {
        cwd: testDir,
      });

      writeFileSync(join(testDir, "dirty.txt"), "dirty");
      const result = await service.commitIfDirty(() => ({
        message: "commit if dirty",
      }));

      expect(result.committed).toBe(true);
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  describe("oversized file exclusion", () => {
    // Just over the default workspaceGit.maxFileSizeBytes (256000)
    const bigContent = () => Buffer.alloc(256001, 120);

    const trackedFiles = () =>
      execFileSync("git", ["ls-files"], { cwd: testDir, encoding: "utf-8" })
        .trim()
        .split("\n");

    test("commitChanges skips oversized files but commits the rest", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "small.txt"), "small");
      writeFileSync(join(testDir, "big.bin"), bigContent());
      await service.commitChanges("Add files");

      const tracked = trackedFiles();
      expect(tracked).toContain("small.txt");
      expect(tracked).not.toContain("big.bin");
      // The oversized file stays on disk untouched
      expect(existsSync(join(testDir, "big.bin"))).toBe(true);
    });

    test("initial commit excludes oversized pre-existing files", async () => {
      writeFileSync(join(testDir, "existing.txt"), "keep me");
      writeFileSync(join(testDir, "huge.bin"), bigContent());

      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const tracked = trackedFiles();
      expect(tracked).toContain("existing.txt");
      expect(tracked).not.toContain("huge.bin");
    });

    test("growth of a tracked file beyond the limit is not committed", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "notes.md"), "small");
      await service.commitChanges("Add notes");

      writeFileSync(join(testDir, "notes.md"), bigContent());
      await service.commitChanges("Grow notes");

      const committed = execFileSync("git", ["show", "HEAD:notes.md"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(committed).toBe("small");
    });

    test("getStatus treats a workspace with only oversized changes as clean", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "big.bin"), bigContent());

      const status = await service.getStatus();
      expect(status.untracked).not.toContain("big.bin");
      expect(status.clean).toBe(true);
    });

    test("commitIfDirty ignores oversized-only changes but commits mixed ones", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "big.bin"), bigContent());
      const first = await service.commitIfDirty(() => ({ message: "big" }));
      expect(first.committed).toBe(false);

      writeFileSync(join(testDir, "small.txt"), "small");
      const second = await service.commitIfDirty(() => ({ message: "mixed" }));
      expect(second.committed).toBe(true);

      const tracked = trackedFiles();
      expect(tracked).toContain("small.txt");
      expect(tracked).not.toContain("big.bin");
    });

    test("oversized blobs are never written to the object store", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const content = bigContent();
      writeFileSync(join(testDir, "big.bin"), content);
      writeFileSync(join(testDir, "small.txt"), "small");
      await service.commitChanges("Add files");

      // hash-object without -w computes the blob id git WOULD store
      const blobSha = execFileSync("git", ["hash-object", "--stdin"], {
        cwd: testDir,
        input: content,
        encoding: "utf-8",
      }).trim();
      expect(() =>
        execFileSync("git", ["cat-file", "-e", blobSha], { cwd: testDir }),
      ).toThrow();
      expect(trackedFiles()).toContain("small.txt");
    });

    test("untracked directory holding only oversized files reads clean", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      mkdirSync(join(testDir, "artifacts"), { recursive: true });
      writeFileSync(join(testDir, "artifacts", "blob.bin"), bigContent());

      const status = await service.getStatus();
      expect(status.clean).toBe(true);

      const result = await service.commitIfDirty(() => ({ message: "dir" }));
      expect(result.committed).toBe(false);
    });

    test("commits small files from a directory that also holds an oversized file", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      mkdirSync(join(testDir, "mixed"), { recursive: true });
      writeFileSync(join(testDir, "mixed", "blob.bin"), bigContent());
      writeFileSync(join(testDir, "mixed", "note.txt"), "keep");
      await service.commitChanges("Add mixed dir");

      const tracked = trackedFiles();
      expect(tracked).toContain("mixed/note.txt");
      expect(tracked).not.toContain("mixed/blob.bin");
    });

    test("externally staged oversized typechange is unstaged", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      writeFileSync(join(testDir, "target.txt"), "target");
      symlinkSync("target.txt", join(testDir, "link"));
      await service.commitChanges("Add symlink");

      // Replace the symlink with an oversized regular file and stage it
      // externally — the staged change is a typechange (T), not ACMR.
      rmSync(join(testDir, "link"));
      writeFileSync(join(testDir, "link"), bigContent());
      execFileSync("git", ["add", "link"], { cwd: testDir });

      await service.commitChanges("Replace link");

      // History must still hold the symlink (mode 120000), not the blob
      const entry = execFileSync("git", ["ls-tree", "HEAD", "link"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(entry).toContain("120000");
    });

    test("oversized files with special-character names stay invisible", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Quoted by default porcelain output; -z must deliver it verbatim
      const name = "résumé archive.bin";
      writeFileSync(join(testDir, name), bigContent());

      const status = await service.getStatus();
      expect(status.clean).toBe(true);

      await service.commitChanges("Special name");
      expect(trackedFiles()).not.toContain(name);
    });

    test("unstaging an oversized glob-like name leaves lookalike paths staged", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // "a?.bin" as a pathspec would also match "ab.bin"
      writeFileSync(join(testDir, "a?.bin"), bigContent());
      writeFileSync(join(testDir, "ab.bin"), "small");
      execFileSync("git", ["add", "--", ":(literal)a?.bin"], { cwd: testDir });

      await service.commitChanges("Add files");

      const tracked = trackedFiles();
      expect(tracked).toContain("ab.bin");
      expect(tracked).not.toContain("a?.bin");
    });

    test("init sweep untracks previously committed oversized files", async () => {
      const first = new WorkspaceGitService(testDir);
      await first.ensureInitialized();

      writeFileSync(join(testDir, "keep.txt"), "small");
      await first.commitChanges("Add small file");

      // Simulate an oversized file that entered history before the guard
      writeFileSync(join(testDir, "legacy.bin"), bigContent());
      execFileSync("git", ["add", "--", ":(literal)legacy.bin"], {
        cwd: testDir,
      });
      execFileSync("git", ["commit", "--no-verify", "-m", "legacy"], {
        cwd: testDir,
      });
      expect(trackedFiles()).toContain("legacy.bin");

      // A fresh service init (new daemon boot) sweeps it out of the index
      const second = new WorkspaceGitService(testDir);
      await second.ensureInitialized();

      const tracked = trackedFiles();
      expect(tracked).not.toContain("legacy.bin");
      expect(tracked).toContain("keep.txt");
      // Working-tree file is preserved; only tracking is dropped
      expect(existsSync(join(testDir, "legacy.bin"))).toBe(true);

      // The staged removal rides along with the next auto-commit
      const result = await second.commitIfDirty(() => ({ message: "sweep" }));
      expect(result.committed).toBe(true);
      const tree = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", "HEAD"],
        { cwd: testDir, encoding: "utf-8" },
      );
      expect(tree).not.toContain("legacy.bin");

      // And the workspace reads clean afterwards — no dirty-loop churn
      const status = await second.getStatus();
      expect(status.clean).toBe(true);
    });

    test("history compaction purges oversized blobs from aged history", async () => {
      const gitEnvAt = (daysAgo: number) => {
        const date = new Date(Date.now() - daysAgo * 86400_000).toISOString();
        return {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        };
      };
      // Build history externally: a big blob committed 30 days ago,
      // untracked 20 days ago, plus a recent commit inside retention.
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "user@example.com"], {
        cwd: testDir,
      });
      writeFileSync(join(testDir, "keep.txt"), "v1");
      writeFileSync(join(testDir, "legacy.bin"), bigContent());
      execFileSync("git", ["add", "-A"], { cwd: testDir });
      execFileSync("git", ["commit", "--no-verify", "-m", "old with blob"], {
        cwd: testDir,
        env: gitEnvAt(30),
      });
      execFileSync("git", ["rm", "--cached", "-q", "legacy.bin"], {
        cwd: testDir,
      });
      execFileSync("git", ["commit", "--no-verify", "-m", "untrack blob"], {
        cwd: testDir,
        env: gitEnvAt(20),
      });
      writeFileSync(join(testDir, "recent.txt"), "recent");
      execFileSync("git", ["add", "recent.txt"], { cwd: testDir });
      execFileSync("git", ["commit", "--no-verify", "-m", "recent change"], {
        cwd: testDir,
      });

      const blobSha = execFileSync("git", ["hash-object", "--stdin"], {
        cwd: testDir,
        input: bigContent(),
        encoding: "utf-8",
      }).trim();
      execFileSync("git", ["cat-file", "-e", blobSha], { cwd: testDir });

      const service = new WorkspaceGitService(testDir);
      await service.compactHistoryNow();

      // The blob is genuinely gone from .git, not just untracked
      expect(() =>
        execFileSync("git", ["cat-file", "-e", blobSha], { cwd: testDir }),
      ).toThrow();

      const subjects = execFileSync("git", ["log", "--format=%s"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(subjects).toContain("recent change");
      expect(subjects).toContain("Compacted workspace history");
      expect(subjects).not.toContain("old with blob");

      // Working tree untouched; service keeps functioning afterwards
      expect(readFileSync(join(testDir, "keep.txt"), "utf-8")).toBe("v1");
      expect(existsSync(join(testDir, "legacy.bin"))).toBe(true);
      writeFileSync(join(testDir, "after.txt"), "after");
      await service.commitChanges("After compaction");
      expect(trackedFiles()).toContain("after.txt");
    });

    test("history compaction is a no-op without oversized blobs", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();
      writeFileSync(join(testDir, "a.txt"), "a");
      await service.commitChanges("Add a");

      const headBefore = await service.getHeadHash();
      const result = await service.compactHistoryNow();

      expect(result.rewrote).toBe(false);
      expect(result.retryAfterMs).toBeUndefined();
      expect(await service.getHeadHash()).toBe(headBefore);
    });

    test("history compaction defers with a retry when blobs are within retention", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Blob enters history via a recent commit (guard bypassed externally)
      writeFileSync(join(testDir, "fresh.bin"), bigContent());
      execFileSync("git", ["add", "--", ":(literal)fresh.bin"], {
        cwd: testDir,
      });
      execFileSync("git", ["commit", "--no-verify", "-m", "fresh blob"], {
        cwd: testDir,
      });

      const headBefore = await service.getHeadHash();
      const result = await service.compactHistoryNow();

      // Nothing is old enough to squash yet, but a retry is requested for
      // when the oldest commit ages past retention.
      expect(result.rewrote).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(await service.getHeadHash()).toBe(headBefore);
    });

    test("deletion of an oversized tracked file is committed", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Simulate an oversized file that entered history before the guard
      writeFileSync(join(testDir, "legacy.bin"), bigContent());
      execFileSync("git", ["add", "legacy.bin"], { cwd: testDir });
      execFileSync("git", ["commit", "--no-verify", "-m", "legacy"], {
        cwd: testDir,
      });

      rmSync(join(testDir, "legacy.bin"));
      await service.commitChanges("Remove legacy");

      expect(trackedFiles()).not.toContain("legacy.bin");
    });
  });
});
