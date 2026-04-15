import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  _resetEnrichmentService,
  getEnrichmentService,
} from "../workspace/commit-message-enrichment-service.js";
import type {
  CommitContext,
  CommitMessageProvider,
  CommitMessageResult,
} from "../workspace/commit-message-provider.js";
import {
  _resetGitServiceRegistry,
  WorkspaceGitService,
} from "../workspace/git-service.js";
import {
  _resetHeartbeatState,
  WorkspaceHeartbeatService,
} from "../workspace/heartbeat-service.js";

describe("WorkspaceHeartbeatService", () => {
  let testDir: string;
  let service: WorkspaceGitService;
  let services: Map<string, WorkspaceGitService>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `vellum-heartbeat-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
    _resetHeartbeatState();

    service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    services = new Map();
    services.set(testDir, service);
  });

  afterEach(async () => {
    // Shut down any in-flight enrichment work before removing the test directory
    try {
      await getEnrichmentService().shutdown();
    } catch {
      /* ignore */
    }
    _resetEnrichmentService();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    try {
      await getEnrichmentService().shutdown();
    } catch {
      /* ignore */
    }
    _resetEnrichmentService();
  });

  describe("heartbeat check with age threshold", () => {
    test("does not commit when workspace is clean", async () => {
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 0, // Immediate
        fileThreshold: 1,
        getServices: () => services,
      });

      const result = await heartbeat.check();

      expect(result.checked).toBe(1);
      expect(result.committed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    test("does not commit when changes are below age and file thresholds", async () => {
      writeFileSync(join(testDir, "file.txt"), "content");

      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 10 * 60 * 1000, // 10 minutes
        fileThreshold: 100,
        getServices: () => services,
      });

      const result = await heartbeat.check();

      expect(result.checked).toBe(1);
      expect(result.committed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    test("commits when changes exceed age threshold", async () => {
      writeFileSync(join(testDir, "file.txt"), "content");

      let currentTime = 1000000;
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 5 * 60 * 1000, // 5 minutes
        fileThreshold: 100,
        getServices: () => services,
        now: () => currentTime,
      });

      // First check: records dirty time but doesn't commit (too recent)
      const firstResult = await heartbeat.check();
      expect(firstResult.committed).toBe(0);

      // Advance time past threshold
      currentTime += 6 * 60 * 1000; // 6 minutes later

      const secondResult = await heartbeat.check();
      expect(secondResult.committed).toBe(1);

      // Verify commit message
      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain("auto-commit");
      expect(commitMsg).toContain("heartbeat");
      expect(commitMsg).toContain("safety net");
    });

    test("commits when file count exceeds threshold", async () => {
      // Create enough files to exceed the threshold
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(testDir, `file${i}.txt`), `content ${i}`);
      }

      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 10 * 60 * 1000, // 10 minutes (not yet)
        fileThreshold: 20,
        getServices: () => services,
      });

      const result = await heartbeat.check();

      expect(result.committed).toBe(1);

      // Verify commit message mentions file count
      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain("25 files changed");
    });
  });

  describe("normal operation does not create spurious commits", () => {
    test("clean workspace produces no heartbeat commits", async () => {
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 0,
        fileThreshold: 1,
        getServices: () => services,
      });

      // Run check multiple times on clean workspace
      for (let i = 0; i < 5; i++) {
        const result = await heartbeat.check();
        expect(result.committed).toBe(0);
      }

      // Only the initial commit should exist
      const commitCount = execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: testDir,
        encoding: "utf-8",
      }).trim();
      expect(parseInt(commitCount, 10)).toBe(1);
    });

    test("changes below both thresholds do not trigger heartbeat commit", async () => {
      // Create a small number of files (below file threshold)
      writeFileSync(join(testDir, "small-change.txt"), "content");

      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 10 * 60 * 1000, // 10 minutes
        fileThreshold: 100, // Very high
        getServices: () => services,
      });

      const result = await heartbeat.check();
      expect(result.committed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    test("does not double-commit after turn-boundary commit clears changes", async () => {
      writeFileSync(join(testDir, "file.txt"), "content");

      let currentTime = 1000000;
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 5 * 60 * 1000,
        fileThreshold: 100,
        getServices: () => services,
        now: () => currentTime,
      });

      // First check: records dirty state
      await heartbeat.check();

      // Simulate a turn-boundary commit that clears the changes
      await service.commitChanges("Turn-boundary commit");

      // Advance time past the threshold
      currentTime += 6 * 60 * 1000;

      // Heartbeat should see clean workspace and skip
      const result = await heartbeat.check();
      expect(result.committed).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe("shutdown commits", () => {
    test("commits pending changes on shutdown", async () => {
      writeFileSync(join(testDir, "unsaved.txt"), "uncommitted content");

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      const result = await heartbeat.commitAllPending();

      expect(result.checked).toBe(1);
      expect(result.committed).toBe(1);

      // Verify commit message
      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain("auto-commit");
      expect(commitMsg).toContain("shutdown");
      expect(commitMsg).toContain("safety net");
    });

    test("does not commit on shutdown when workspace is clean", async () => {
      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      const result = await heartbeat.commitAllPending();

      expect(result.checked).toBe(1);
      expect(result.committed).toBe(0);
      expect(result.skipped).toBe(1);
    });

    test("shutdown commits multiple workspaces", async () => {
      const testDir2 = join(
        tmpdir(),
        `vellum-heartbeat-test2-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`,
      );
      mkdirSync(testDir2, { recursive: true });
      const service2 = new WorkspaceGitService(testDir2);
      await service2.ensureInitialized();
      services.set(testDir2, service2);

      writeFileSync(join(testDir, "file1.txt"), "content1");
      writeFileSync(join(testDir2, "file2.txt"), "content2");

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      const result = await heartbeat.commitAllPending();

      expect(result.checked).toBe(2);
      expect(result.committed).toBe(2);

      // Clean up second test dir
      rmSync(testDir2, { recursive: true, force: true });
    });
  });

  describe("uninitialized workspaces", () => {
    test("skips uninitialized workspaces", async () => {
      const uninitDir = join(
        tmpdir(),
        `vellum-uninit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(uninitDir, { recursive: true });

      const uninitService = new WorkspaceGitService(uninitDir);
      const mixedServices = new Map<string, WorkspaceGitService>();
      mixedServices.set(uninitDir, uninitService);
      mixedServices.set(testDir, service);

      writeFileSync(join(testDir, "file.txt"), "content");

      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 0,
        fileThreshold: 1,
        getServices: () => mixedServices,
        now: () => Date.now(),
      });

      // First check to register dirty state, then immediate second check
      await heartbeat.check();

      const result = await heartbeat.check();
      // Only initialized workspace should be checked
      // The first check committed the file, so the second check sees it clean
      expect(result.checked).toBe(1);

      rmSync(uninitDir, { recursive: true, force: true });
    });
  });

  describe("threshold behavior", () => {
    test("resets dirty tracking after successful commit", async () => {
      let currentTime = 1000000;
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 5 * 60 * 1000,
        fileThreshold: 100,
        getServices: () => services,
        now: () => currentTime,
      });

      // Create changes and register dirty state
      writeFileSync(join(testDir, "file1.txt"), "content");
      await heartbeat.check(); // Records first-seen time

      // Advance past threshold and commit
      currentTime += 6 * 60 * 1000;
      const firstResult = await heartbeat.check();
      expect(firstResult.committed).toBe(1);

      // Drain fire-and-forget enrichment from the first commit before the
      // next commit. Enrichment's writeNote() can leave a stale index.lock
      // on some git versions (see heartbeat-service.ts:240-242), causing
      // the subsequent commit to fail with "index.lock: File exists".
      await getEnrichmentService().shutdown();
      _resetEnrichmentService();

      // Create new changes after the commit
      writeFileSync(join(testDir, "file2.txt"), "more content");

      // Check again immediately -- should not commit (dirty timer was reset)
      const secondResult = await heartbeat.check();
      expect(secondResult.committed).toBe(0);

      // Advance past threshold again
      currentTime += 6 * 60 * 1000;
      const thirdResult = await heartbeat.check();
      expect(thirdResult.committed).toBe(1);
    });

    test("commit message includes trigger metadata", async () => {
      writeFileSync(join(testDir, "file.txt"), "content");

      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 0,
        fileThreshold: 1,
        getServices: () => services,
      });

      // Two checks: first registers, second commits (age 0 means immediate on re-check)
      await heartbeat.check();
      await heartbeat.check();

      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain('trigger: "heartbeat"');
    });
  });

  describe("start and stop", () => {
    test("start and stop are idempotent", async () => {
      const heartbeat = new WorkspaceHeartbeatService({
        intervalMs: 60000,
        getServices: () => services,
      });

      // Should not throw
      heartbeat.start();
      heartbeat.start(); // Idempotent
      await heartbeat.stop();
      await heartbeat.stop(); // Idempotent
    });
  });

  describe("custom commit message provider", () => {
    test("heartbeat commit uses custom provider message", async () => {
      writeFileSync(join(testDir, "file.txt"), "content");

      const customProvider: CommitMessageProvider = {
        buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
          return {
            message: `CUSTOM-HEARTBEAT: ${ctx.changedFiles.length} files via ${ctx.trigger}`,
            metadata: { customProvider: true, trigger: ctx.trigger },
          };
        },
      };

      let currentTime = 1000000;
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 5 * 60 * 1000,
        fileThreshold: 100,
        getServices: () => services,
        now: () => currentTime,
        commitMessageProvider: customProvider,
      });

      // First check registers dirty state
      await heartbeat.check();
      // Advance time past threshold
      currentTime += 6 * 60 * 1000;
      // Second check commits
      const result = await heartbeat.check();
      expect(result.committed).toBe(1);

      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain("CUSTOM-HEARTBEAT:");
      expect(commitMsg).toContain("via heartbeat");
      expect(commitMsg).toContain("customProvider: true");
    });

    test("shutdown commit uses custom provider message", async () => {
      writeFileSync(join(testDir, "unsaved.txt"), "uncommitted content");

      const customProvider: CommitMessageProvider = {
        buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
          return {
            message: `CUSTOM-SHUTDOWN: saving ${ctx.changedFiles.length} files`,
            metadata: { shutdownProvider: true },
          };
        },
      };

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
        commitMessageProvider: customProvider,
      });

      const result = await heartbeat.commitAllPending();
      expect(result.committed).toBe(1);

      const commitMsg = execFileSync("git", ["log", "-1", "--pretty=%B"], {
        cwd: testDir,
        encoding: "utf-8",
      });
      expect(commitMsg).toContain("CUSTOM-SHUTDOWN: saving");
      expect(commitMsg).toContain("shutdownProvider: true");
    });

    test("custom provider receives correct context fields for heartbeat trigger", async () => {
      writeFileSync(join(testDir, "a.txt"), "a");
      writeFileSync(join(testDir, "b.txt"), "b");

      let capturedCtx: CommitContext | null = null;
      const customProvider: CommitMessageProvider = {
        buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
          capturedCtx = ctx;
          return { message: "capture-context" };
        },
      };

      let currentTime = 1000000;
      const heartbeat = new WorkspaceHeartbeatService({
        ageThresholdMs: 5 * 60 * 1000,
        fileThreshold: 100,
        getServices: () => services,
        now: () => currentTime,
        commitMessageProvider: customProvider,
      });

      // Register dirty state
      await heartbeat.check();
      // Advance past threshold
      currentTime += 6 * 60 * 1000;
      await heartbeat.check();

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.trigger).toBe("heartbeat");
      expect(capturedCtx!.workspaceDir).toBe(testDir);
      expect(capturedCtx!.changedFiles).toContain("a.txt");
      expect(capturedCtx!.changedFiles).toContain("b.txt");
      expect(capturedCtx!.timestampMs).toBe(currentTime);
      expect(capturedCtx!.reason).toBeDefined();
    });

    test("custom provider receives correct context fields for shutdown trigger", async () => {
      writeFileSync(join(testDir, "shutdown-file.txt"), "data");

      let capturedCtx: CommitContext | null = null;
      const customProvider: CommitMessageProvider = {
        buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
          capturedCtx = ctx;
          return { message: "capture-shutdown-context" };
        },
      };

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
        commitMessageProvider: customProvider,
      });

      await heartbeat.commitAllPending();

      expect(capturedCtx).not.toBeNull();
      expect(capturedCtx!.trigger).toBe("shutdown");
      expect(capturedCtx!.workspaceDir).toBe(testDir);
      expect(capturedCtx!.changedFiles).toContain("shutdown-file.txt");
    });
  });
});
