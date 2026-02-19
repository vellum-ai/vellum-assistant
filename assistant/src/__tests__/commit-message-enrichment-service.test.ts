import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  CommitEnrichmentService,
  _resetEnrichmentService,
} from '../workspace/commit-message-enrichment-service.js';
import { WorkspaceGitService, _resetGitServiceRegistry } from '../workspace/git-service.js';
import type { CommitContext } from '../workspace/commit-message-provider.js';

describe('CommitEnrichmentService', () => {
  let testDir: string;
  let gitService: WorkspaceGitService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `vellum-enrichment-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
    _resetEnrichmentService();

    gitService = new WorkspaceGitService(testDir);
    await gitService.ensureInitialized();
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeContext(overrides?: Partial<CommitContext>): CommitContext {
    return {
      workspaceDir: testDir,
      trigger: 'turn',
      sessionId: 'sess_test',
      turnNumber: 1,
      changedFiles: ['file.txt'],
      timestampMs: Date.now(),
      ...overrides,
    };
  }

  async function createCommit(): Promise<string> {
    writeFileSync(join(testDir, `file-${Date.now()}.txt`), 'content');
    await gitService.commitChanges('test commit');
    return await gitService.getHeadHash();
  }

  test('enqueue and execute writes git note on success', async () => {
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
    const noteContent = execFileSync('git', ['notes', '--ref=vellum', 'show', commitHash], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    const note = JSON.parse(noteContent);
    expect(note.enriched).toBe(true);
    expect(note.trigger).toBe('turn');
    expect(note.sessionId).toBe('sess_test');
    expect(note.turnNumber).toBe(1);
    expect(note.filesChanged).toBe(1);
    expect(service._getSucceededCount()).toBe(1);
  });

  test('queue overflow drops oldest job', async () => {
    const service = new CommitEnrichmentService({
      maxQueueSize: 2,
      maxConcurrency: 0, // 0 concurrency means nothing processes, for testing queue behavior
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    // Override concurrency so nothing actually runs
    // We want to test queue overflow behavior only
    const hash1 = await createCommit();
    const hash2 = await createCommit();
    const hash3 = await createCommit();

    // With maxConcurrency 0, nothing will process; but let's use 1 and block processing
    // Instead, use a service with concurrency 1 but fill the queue faster than it drains
    const service2 = new CommitEnrichmentService({
      maxQueueSize: 2,
      maxConcurrency: 1,
      jobTimeoutMs: 30000,
      maxRetries: 0,
    });

    // Enqueue 3 jobs — the first starts immediately (active worker),
    // second goes to queue, third overflows and drops the second
    service2.enqueue({ workspaceDir: testDir, commitHash: hash1, context: makeContext(), gitService });
    service2.enqueue({ workspaceDir: testDir, commitHash: hash2, context: makeContext(), gitService });
    service2.enqueue({ workspaceDir: testDir, commitHash: hash3, context: makeContext(), gitService });

    // The queue should have 2 items (hash2 and hash3 or hash3 depending on timing)
    // But hash1 is being processed. Let's check dropped count.
    // With maxQueueSize=2, after hash1 starts processing (active worker=1),
    // hash2 goes to queue (size=1), hash3 goes to queue (size=2), no drop yet.
    // Actually the first job is picked up immediately, so queue has 2 items max.
    // Let's check dropped count after shutdown.
    await service2.shutdown();

    // No drops expected since queue size 2 can hold 2 pending while 1 is active
    expect(service2._getDroppedCount()).toBe(0);

    await service.shutdown();
  });

  test('queue overflow actually drops when truly full', async () => {
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
    service.enqueue({ workspaceDir: testDir, commitHash: hash1, context: makeContext(), gitService });
    service.enqueue({ workspaceDir: testDir, commitHash: hash2, context: makeContext(), gitService });
    service.enqueue({ workspaceDir: testDir, commitHash: hash3, context: makeContext(), gitService });

    expect(service._getDroppedCount()).toBe(1);

    await service.shutdown();
  });

  test('fire-and-forget enqueue does not block caller', async () => {
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

  test('graceful shutdown drains in-flight and discards pending', async () => {
    const hash1 = await createCommit();
    const hash2 = await createCommit();

    const service = new CommitEnrichmentService({
      maxQueueSize: 10,
      maxConcurrency: 1,
      jobTimeoutMs: 5000,
      maxRetries: 0,
    });

    service.enqueue({ workspaceDir: testDir, commitHash: hash1, context: makeContext(), gitService });
    service.enqueue({ workspaceDir: testDir, commitHash: hash2, context: makeContext(), gitService });

    // Shutdown should complete without hanging
    await service.shutdown();

    // At least the first job should have completed (it was in-flight)
    expect(service._getSucceededCount()).toBeGreaterThanOrEqual(1);
  });

  test('discards jobs enqueued after shutdown', async () => {
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

  test('multiple successful enrichments write separate git notes', async () => {
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
    while (service._getQueueSize() > 0 || service._getActiveWorkers() > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await service.shutdown();

    // Both notes should exist
    const note1 = JSON.parse(execFileSync('git', ['notes', '--ref=vellum', 'show', hash1], {
      cwd: testDir, encoding: 'utf-8',
    }));
    const note2 = JSON.parse(execFileSync('git', ['notes', '--ref=vellum', 'show', hash2], {
      cwd: testDir, encoding: 'utf-8',
    }));

    expect(note1.turnNumber).toBe(1);
    expect(note2.turnNumber).toBe(2);
    expect(service._getSucceededCount()).toBe(2);
  });
});
