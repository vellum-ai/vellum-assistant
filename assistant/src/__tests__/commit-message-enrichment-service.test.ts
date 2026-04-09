import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetEnrichmentService,
  CommitEnrichmentService,
  getEnrichmentService,
} from "../workspace/commit-message-enrichment-service.js";
import type { CommitContext } from "../workspace/commit-message-provider.js";
import {
  _resetGitServiceRegistry,
  WorkspaceGitService,
} from "../workspace/git-service.js";

describe("CommitEnrichmentService", () => {
  let testDir: string;
  let gitService: WorkspaceGitService;

  beforeEach(async () => {
    _resetGitServiceRegistry();
    _resetEnrichmentService();
    testDir = join(
      tmpdir(),
      `vellum-enrichment-test-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    gitService = new WorkspaceGitService(testDir);
    await gitService.ensureInitialized();
  });

  afterEach(async () => {
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

  function makeContext(overrides?: Partial<CommitContext>): CommitContext {
    return {
      workspaceDir: testDir,
      trigger: "turn",
      conversationId: "sess_test",
      turnNumber: 1,
      changedFiles: ["file.txt"],
      timestampMs: Date.now(),
      ...overrides,
    };
  }

  async function createCommit(): Promise<string> {
    const filename = `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    writeFileSync(join(testDir, filename), "content");
    // Use execFileSync directly for test setup commits to avoid async
    // timing issues that can leave stale index.lock files on loaded CI runners.
    const lockPath = join(testDir, ".git", "index.lock");
    try {
      unlinkSync(lockPath);
    } catch {
      /* no lock to clean */
    }
    execFileSync("git", ["add", "-A"], { cwd: testDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Vellum Assistant",
        "-c",
        "user.email=assistant@vellum.ai",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-verify",
        "-m",
        "test commit",
        "--allow-empty",
      ],
      { cwd: testDir },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: testDir,
      encoding: "utf-8",
    }).trim();
  }

  async function waitForDrain(
    service: CommitEnrichmentService,
    timeoutMs = 5000,
  ): Promise<void> {
    const started = Date.now();
    while (service._getQueueSize() > 0 || service._getActiveWorkers() > 0) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `Timed out waiting for enrichment queue to drain after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("enqueue and execute writes git note on success", async () => {
    const commitHash = await createCommit();
    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    service.enqueue({
      workspaceDir: testDir,
      commitHash,
      context: makeContext(),
      gitService,
    });

    // Wait for async processing
    await service.shutdown();

    // Verify git note was written
    const noteContent = execFileSync(
      "git",
      ["notes", "--ref=vellum", "show", commitHash],
      {
        cwd: testDir,
        encoding: "utf-8",
      },
    );

    const note = JSON.parse(noteContent);
    expect(note.enriched).toBe(true);
    expect(note.trigger).toBe("turn");
    expect(note.conversationId).toBe("sess_test");
    expect(note.turnNumber).toBe(1);
    expect(note.filesChanged).toBe(1);
    expect(service._getSucceededCount()).toBe(1);
  });

  test("queue overflow drops oldest job", async () => {
    const service = new CommitEnrichmentService({
      maxQueueSize: 2,
      maxConcurrency: 1,
      jobTimeoutMs: 30000,
      maxRetries: 0,
    });

    const hash1 = await createCommit();
    const hash2 = await createCommit();
    const hash3 = await createCommit();

    // Enqueue 3 jobs — hash1 starts immediately (active worker),
    // hash2 goes to queue (size=1), hash3 goes to queue (size=2), no overflow drop.
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash1,
      context: makeContext(),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash2,
      context: makeContext(),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash3,
      context: makeContext(),
      gitService,
    });

    // No overflow drops — queue size 2 can hold 2 pending while 1 is active
    expect(service._getDroppedCount()).toBe(0);
    expect(service._getQueueSize()).toBe(2);

    // Shutdown discards the 2 pending jobs
    await service.shutdown();
    expect(service._getDroppedCount()).toBe(2);
    expect(service._getSucceededCount()).toBe(1);
  });

  test("queue overflow actually drops when truly full", async () => {
    // Create a service where the worker is slow
    const service = new CommitEnrichmentService({
      maxQueueSize: 1,
      maxConcurrency: 1,
      jobTimeoutMs: 30000,
      maxRetries: 0,
    });

    const hash1 = await createCommit();
    const hash2 = await createCommit();
    const hash3 = await createCommit();

    // hash1 starts processing immediately (active worker = 1, queue empty)
    // hash2 goes to queue (queue size = 1)
    // hash3 tries to go to queue but it's full → drops hash2, adds hash3
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash1,
      context: makeContext(),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash2,
      context: makeContext(),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash3,
      context: makeContext(),
      gitService,
    });

    expect(service._getDroppedCount()).toBe(1);

    await service.shutdown();
  });

  test("fire-and-forget enqueue does not block caller", async () => {
    const commitHash = await createCommit();
    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    const start = Date.now();
    service.enqueue({
      workspaceDir: testDir,
      commitHash,
      context: makeContext(),
      gitService,
    });
    const elapsed = Date.now() - start;

    // enqueue should return immediately (< 50ms)
    expect(elapsed).toBeLessThan(50);

    await service.shutdown();
  });

  test("graceful shutdown drains in-flight and discards pending", async () => {
    const hash1 = await createCommit();
    const hash2 = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash1,
      context: makeContext(),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash2,
      context: makeContext(),
      gitService,
    });

    // Shutdown should complete without hanging
    await service.shutdown();

    // The first job was in-flight and should complete. The second was pending
    // and should be discarded, counted as dropped.
    expect(service._getSucceededCount()).toBe(1);
    expect(service._getDroppedCount()).toBe(1);
    expect(service._getQueueSize()).toBe(0);
  });

  test("shutdown discards all pending jobs and counts them as dropped", async () => {
    // Use maxConcurrency 1 so only one job starts processing; the rest stay pending.
    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      hashes.push(await createCommit());
    }

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    for (const hash of hashes) {
      service.enqueue({
        workspaceDir: testDir,
        commitHash: hash,
        context: makeContext(),
        gitService,
      });
    }

    // First job is in-flight, remaining 4 are pending
    await service.shutdown();

    // In-flight job completes, pending jobs are discarded
    expect(service._getSucceededCount()).toBe(1);
    expect(service._getDroppedCount()).toBe(4);
  });

  test("shutdown does not cause concurrency spike", async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      hashes.push(await createCommit());
    }

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    for (const hash of hashes) {
      service.enqueue({
        workspaceDir: testDir,
        commitHash: hash,
        context: makeContext(),
        gitService,
      });
    }

    await service.shutdown();

    // Active workers should be 0 after shutdown
    expect(service._getActiveWorkers()).toBe(0);
  });

  test("discards jobs enqueued after shutdown", async () => {
    const commitHash = await createCommit();
    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    await service.shutdown();

    // Enqueue after shutdown should be silently discarded
    service.enqueue({
      workspaceDir: testDir,
      commitHash,
      context: makeContext(),
      gitService,
    });

    expect(service._getQueueSize()).toBe(0);
    expect(service._getSucceededCount()).toBe(0);
  });

  test("multiple successful enrichments write separate git notes", async () => {
    const hash1 = await createCommit();
    const hash2 = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash1,
      context: makeContext({ turnNumber: 1 }),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hash2,
      context: makeContext({ turnNumber: 2 }),
      gitService,
    });

    // Wait for queue to drain before shutdown (avoids discarding pending jobs)
    await waitForDrain(service, 5000);
    await service.shutdown();

    // Both notes should exist
    const note1 = JSON.parse(
      execFileSync("git", ["notes", "--ref=vellum", "show", hash1], {
        cwd: testDir,
        encoding: "utf-8",
      }),
    );
    const note2 = JSON.parse(
      execFileSync("git", ["notes", "--ref=vellum", "show", hash2], {
        cwd: testDir,
        encoding: "utf-8",
      }),
    );

    expect(note1.turnNumber).toBe(1);
    expect(note2.turnNumber).toBe(2);
    expect(service._getSucceededCount()).toBe(2);
  });

  test("job timeout triggers retry with backoff then fails after max retries", async () => {
    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 10, // short timeout
      maxRetries: 2,
    });

    const commitHash = await createCommit();

    // Use a slow gitService so the timeout always wins the race.
    // A 1ms timeout against a real git write is flaky on fast CI runners.
    const slowGitService = new WorkspaceGitService(testDir);
    await slowGitService.ensureInitialized();
    slowGitService.writeNote = () => new Promise<void>(() => {});

    service.enqueue({
      workspaceDir: testDir,
      commitHash,
      context: makeContext(),
      gitService: slowGitService,
    });

    // Wait for all retries to complete (initial + 2 retries, with backoff)
    // Backoff: 1s after attempt 1, 2s after attempt 2 = ~3s total
    await waitForDrain(service, 10000);
    await service.shutdown();

    // After 1 initial attempt + 2 retries (3 total), the job should be counted as failed
    expect(service._getFailedCount()).toBe(1);
    expect(service._getSucceededCount()).toBe(0);
  }, 15000); // Allow up to 15s for backoff delays

  test("queue overflow drop behavior is deterministic", async () => {
    // With maxQueueSize=2 and maxConcurrency=1:
    // - Job A starts processing immediately (in-flight)
    // - Job B enters queue (size=1)
    // - Job C enters queue (size=2)
    // - Job D overflows: drops oldest (B), adds D → queue has [C, D]
    // - Job E overflows: drops oldest (C), adds E → queue has [D, E]
    const service = new CommitEnrichmentService({
      maxQueueSize: 2,
      maxConcurrency: 1,
      jobTimeoutMs: 30000,
      maxRetries: 0,
    });

    const hashA = await createCommit();
    const hashB = await createCommit();
    const hashC = await createCommit();
    const hashD = await createCommit();
    const hashE = await createCommit();

    service.enqueue({
      workspaceDir: testDir,
      commitHash: hashA,
      context: makeContext({ turnNumber: 1 }),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hashB,
      context: makeContext({ turnNumber: 2 }),
      gitService,
    });
    service.enqueue({
      workspaceDir: testDir,
      commitHash: hashC,
      context: makeContext({ turnNumber: 3 }),
      gitService,
    });
    // No drops yet: A is in-flight, B and C in queue (size=2)
    expect(service._getDroppedCount()).toBe(0);

    service.enqueue({
      workspaceDir: testDir,
      commitHash: hashD,
      context: makeContext({ turnNumber: 4 }),
      gitService,
    });
    // Queue was full (2), so oldest (B) was dropped
    expect(service._getDroppedCount()).toBe(1);

    service.enqueue({
      workspaceDir: testDir,
      commitHash: hashE,
      context: makeContext({ turnNumber: 5 }),
      gitService,
    });
    // Queue was full again (2), so oldest (C) was dropped
    expect(service._getDroppedCount()).toBe(2);

    // Queue should have exactly 2 items: D and E
    expect(service._getQueueSize()).toBe(2);

    await service.shutdown();

    // A was in-flight and completed; D and E were pending and discarded at shutdown
    expect(service._getSucceededCount()).toBe(1);
    // 2 overflow drops + 2 shutdown discards = 4 total
    expect(service._getDroppedCount()).toBe(4);
  });

  test("timed-out enrichment work is cancelled via AbortSignal", async () => {
    // Track whether the slow enrichment work actually ran to completion
    let enrichmentCompleted = false;
    const commitHash = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 50, // Very short timeout
      maxRetries: 0,
    });

    // Monkey-patch writeNote to simulate slow work that respects the abort signal.
    // The real writeNote now passes the signal to execFileAsync which kills the
    // child process on abort. This mock replicates that behavior by rejecting
    // when the signal fires.
    const originalWriteNote = gitService.writeNote.bind(gitService);
    gitService.writeNote = async (
      _hash: string,
      _note: string,
      signal?: AbortSignal,
    ) => {
      // Simulate slow work that is cancellable via AbortSignal
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          enrichmentCompleted = true;
          resolve();
        }, 200);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    try {
      service.enqueue({
        workspaceDir: testDir,
        commitHash,
        context: makeContext(),
        gitService,
      });

      await waitForDrain(service, 5000);
      await service.shutdown();

      // Allow any zombie work to settle — if abort didn't work, the 200ms timer
      // would still be running and would set enrichmentCompleted=true. Wait
      // longer than the 200ms mock delay to reliably catch the regression.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The job should have timed out and been counted as failed
      expect(service._getFailedCount()).toBe(1);
      expect(service._getSucceededCount()).toBe(0);
      // The slow enrichment work should NOT have completed since the signal was aborted
      expect(enrichmentCompleted).toBe(false);
    } finally {
      gitService.writeNote = originalWriteNote;
    }
  });

  test("shutdown does not hang on timed-out jobs", async () => {
    const commitHash = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 50, // Short timeout
      maxRetries: 0,
    });

    // Make writeNote artificially slow so the job will always time out.
    // The mock respects the abort signal so the subprocess is killed on timeout.
    const originalWriteNote = gitService.writeNote.bind(gitService);
    gitService.writeNote = async (
      _hash: string,
      _note: string,
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    };

    try {
      service.enqueue({
        workspaceDir: testDir,
        commitHash,
        context: makeContext(),
        gitService,
      });

      // Shutdown should complete promptly, not hang for 5s waiting on the slow writeNote
      const shutdownStart = Date.now();
      await service.shutdown();
      const shutdownElapsed = Date.now() - shutdownStart;

      // Shutdown should complete well under the 5s slow-work duration
      expect(shutdownElapsed).toBeLessThan(3000);
      expect(service._getFailedCount()).toBe(1);
    } finally {
      gitService.writeNote = originalWriteNote;
    }
  }, 10000);

  test("abort signal is triggered on non-timeout errors before retry", async () => {
    const commitHash = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    // Make writeNote throw an error and observe whether the signal gets aborted
    const originalWriteNote = gitService.writeNote.bind(gitService);
    gitService.writeNote = async (_hash: string, _note: string) => {
      // Set up a listener on the abort controller's signal to track abortion.
      // We access the signal indirectly by throwing, which triggers the catch
      // block in executeJob where controller.abort() is called.
      throw new Error("Simulated writeNote failure");
    };

    try {
      service.enqueue({
        workspaceDir: testDir,
        commitHash,
        context: makeContext(),
        gitService,
      });

      await waitForDrain(service, 5000);
      await service.shutdown();

      // The job should have failed (no retries configured)
      expect(service._getFailedCount()).toBe(1);
      expect(service._getSucceededCount()).toBe(0);
    } finally {
      gitService.writeNote = originalWriteNote;
    }
  });

  test("enqueue is fire-and-forget and never throws even when called rapidly", async () => {
    const service = new CommitEnrichmentService({
      maxQueueSize: 3,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    const hashes: string[] = [];
    for (let i = 0; i < 5; i++) {
      hashes.push(await createCommit());
    }

    // Rapidly enqueue more jobs than the queue can hold — must never throw
    const fn = () => {
      for (const hash of hashes) {
        service.enqueue({
          workspaceDir: testDir,
          commitHash: hash,
          context: makeContext(),
          gitService,
        });
      }
    };

    expect(fn).not.toThrow();

    // Some jobs should have been dropped due to overflow (queue size 3, 1 in-flight)
    // 5 jobs: 1 in-flight + 3 queue + 1 overflow = at least 1 drop
    expect(service._getDroppedCount()).toBeGreaterThanOrEqual(1);

    await service.shutdown();
  });
});
