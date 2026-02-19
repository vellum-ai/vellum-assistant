import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { CommitMessageProvider, CommitContext, CommitMessageResult } from '../workspace/commit-message-provider.js';

// ---------------------------------------------------------------------------
// Guard against module mock leakage from earlier test files (e.g. session-queue).
// Re-register the real workspace modules so our static imports bind to them.
// The ?real query string forces Bun to bypass the mock cache.
// ---------------------------------------------------------------------------
// @ts-expect-error Bun mock bypass: ?real query string forces real module resolution
mock.module('../workspace/git-service.js', async () => await import('../workspace/git-service.js?real'));
// @ts-expect-error Bun mock bypass: ?real query string forces real module resolution
mock.module('../workspace/turn-commit.js', async () => await import('../workspace/turn-commit.js?real'));
// @ts-expect-error Bun mock bypass: ?real query string forces real module resolution
mock.module('../workspace/commit-message-enrichment-service.js', async () => await import('../workspace/commit-message-enrichment-service.js?real'));

import { commitTurnChanges } from '../workspace/turn-commit.js';
import { WorkspaceGitService, _resetGitServiceRegistry } from '../workspace/git-service.js';
import { _resetEnrichmentService, getEnrichmentService } from '../workspace/commit-message-enrichment-service.js';

describe('commitTurnChanges', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `vellum-turn-commit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
  });

  afterEach(async () => {
    // Shut down any in-flight enrichment work before removing the test directory
    try { await getEnrichmentService().shutdown(); } catch { /* ignore */ }
    _resetEnrichmentService();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    try { await getEnrichmentService().shutdown(); } catch { /* ignore */ }
    _resetEnrichmentService();
  });

  test('turn with file edits creates a commit', async () => {
    // Initialize workspace git
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Simulate file edits during a turn
    writeFileSync(join(testDir, 'hello.txt'), 'hello world');
    writeFileSync(join(testDir, 'config.json'), '{"key": "value"}');

    await commitTurnChanges(testDir, 'sess_abc123', 1);

    // Verify a commit was created
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    expect(log).toContain('Turn:');

    // Verify commit message format
    const fullMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    expect(fullMessage).toContain('Turn:');
    expect(fullMessage).toContain('Session: sess_abc123');
    expect(fullMessage).toContain('Turn: 1');
    expect(fullMessage).toContain('Timestamp:');
    expect(fullMessage).toContain('Files: 2 changed');
  });

  test('turn with no changes creates no commit', async () => {
    // Initialize workspace git
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Count commits before
    const logBefore = execFileSync('git', ['log', '--oneline'], {
      cwd: testDir,
      encoding: 'utf-8',
    }).trim();
    const commitCountBefore = logBefore.split('\n').length;

    // No file changes — just call commitTurnChanges
    await commitTurnChanges(testDir, 'sess_xyz', 3);

    // Count commits after
    const logAfter = execFileSync('git', ['log', '--oneline'], {
      cwd: testDir,
      encoding: 'utf-8',
    }).trim();
    const commitCountAfter = logAfter.split('\n').length;

    // No new commits should have been created
    expect(commitCountAfter).toBe(commitCountBefore);
  });

  test('multiple tool calls in one turn result in single commit at end', async () => {
    // Initialize workspace git
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Simulate multiple tool call outputs (file writes) within a single turn
    writeFileSync(join(testDir, 'file1.txt'), 'content from tool call 1');
    writeFileSync(join(testDir, 'file2.txt'), 'content from tool call 2');
    writeFileSync(join(testDir, 'file3.txt'), 'content from tool call 3');
    mkdirSync(join(testDir, 'subdir'), { recursive: true });
    writeFileSync(join(testDir, 'subdir', 'nested.txt'), 'nested content');

    // Single call to commitTurnChanges (as happens at turn boundary)
    await commitTurnChanges(testDir, 'sess_multi', 2);

    // There should be exactly 2 commits: initial + turn
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: testDir,
      encoding: 'utf-8',
    }).trim();
    const commitCount = log.split('\n').length;
    expect(commitCount).toBe(2);

    // The single turn commit should include all 4 files
    const changedFiles = execFileSync(
      'git', ['diff', '--name-only', 'HEAD~1', 'HEAD'],
      { cwd: testDir, encoding: 'utf-8' },
    ).trim();

    expect(changedFiles).toContain('file1.txt');
    expect(changedFiles).toContain('file2.txt');
    expect(changedFiles).toContain('file3.txt');
    expect(changedFiles).toContain('subdir/nested.txt');
  });

  test('commit message includes correct metadata', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    writeFileSync(join(testDir, 'doc.md'), '# Document');
    writeFileSync(join(testDir, 'style.css'), 'body {}');
    writeFileSync(join(testDir, 'app.js'), 'console.log("hello")');

    await commitTurnChanges(testDir, 'sess_meta_test', 5);

    const fullMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    // Verify structured metadata
    expect(fullMessage).toContain('Session: sess_meta_test');
    expect(fullMessage).toContain('Turn: 5');
    expect(fullMessage).toContain('Files: 3 changed');
    // Timestamp should be ISO 8601 format
    expect(fullMessage).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('commit summary shows single file name for one change', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    writeFileSync(join(testDir, 'only-file.txt'), 'content');

    await commitTurnChanges(testDir, 'sess_single', 1);

    const fullMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    expect(fullMessage).toContain('Turn: only-file.txt');
    expect(fullMessage).toContain('Files: 1 changed');
  });

  test('commit summary shows "and N more" for many changes', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `file${i}.txt`), `content ${i}`);
    }

    await commitTurnChanges(testDir, 'sess_many', 1);

    const firstLine = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: testDir,
      encoding: 'utf-8',
    }).trim();

    // Should show first 2 files "and 3 more"
    expect(firstLine).toContain('and 3 more');
  });

  test('handles errors gracefully without throwing', async () => {
    // Call with a nonexistent workspace — should NOT throw
    await commitTurnChanges('/nonexistent/workspace/path', 'sess_err', 1);
    // If we get here, the test passes (no exception bubbled up)
  });

  test('successive turns produce separate commits', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Turn 1
    writeFileSync(join(testDir, 'turn1.txt'), 'turn 1 content');
    await commitTurnChanges(testDir, 'sess_successive', 1);

    // Turn 2
    writeFileSync(join(testDir, 'turn2.txt'), 'turn 2 content');
    await commitTurnChanges(testDir, 'sess_successive', 2);

    // Turn 3 — no changes
    await commitTurnChanges(testDir, 'sess_successive', 3);

    // Should have 3 total commits: initial + turn 1 + turn 2
    // Turn 3 had no changes so no commit
    const log = execFileSync('git', ['log', '--oneline'], {
      cwd: testDir,
      encoding: 'utf-8',
    }).trim();
    const commitCount = log.split('\n').length;
    expect(commitCount).toBe(3);

    // Verify turn metadata in the commits
    const turn2Msg = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });
    expect(turn2Msg).toContain('Turn: 2');

    const turn1Msg = execFileSync('git', ['log', '-1', '--skip=1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });
    expect(turn1Msg).toContain('Turn: 1');
  });

  test('custom commit message provider output is used in commit', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    const customProvider: CommitMessageProvider = {
      buildImmediateMessage(ctx: CommitContext): CommitMessageResult {
        return {
          message: `CUSTOM-TURN: session=${ctx.sessionId} turn=${ctx.turnNumber} files=${ctx.changedFiles.length}`,
          metadata: { custom: true, provider: 'test-provider' },
        };
      },
    };

    writeFileSync(join(testDir, 'provider-test.txt'), 'provider test content');

    await commitTurnChanges(testDir, 'sess_provider', 42, customProvider);

    const fullMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    // Verify the custom provider's message was used, not the default
    expect(fullMessage).toContain('CUSTOM-TURN: session=sess_provider turn=42 files=1');
    expect(fullMessage).toContain('custom: true');
    expect(fullMessage).toContain('provider: "test-provider"');
  });

  test('custom provider metadata is included in commit message', async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    const customProvider: CommitMessageProvider = {
      buildImmediateMessage(_ctx: CommitContext): CommitMessageResult {
        return {
          message: 'Minimal custom message',
          metadata: { enriched: false, source: 'unit-test' },
        };
      },
    };

    writeFileSync(join(testDir, 'meta-test.txt'), 'metadata test');

    await commitTurnChanges(testDir, 'sess_meta', 1, customProvider);

    const fullMessage = execFileSync('git', ['log', '-1', '--pretty=%B'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    expect(fullMessage).toContain('Minimal custom message');
    expect(fullMessage).toContain('enriched: false');
    expect(fullMessage).toContain('source: "unit-test"');
  });
});
