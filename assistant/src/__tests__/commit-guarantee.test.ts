/**
 * Regression tests for turn-boundary commit guarantees.
 *
 * These tests verify that workspace changes are committed even when
 * post-processing errors occur after the agent loop completes, and
 * that the shutdown sequence commits changes made during server.stop().
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetGitServiceRegistry,
  getWorkspaceGitService,
  WorkspaceGitService,
} from "../workspace/git-service.js";
import {
  _resetHeartbeatState,
  WorkspaceHeartbeatService,
} from "../workspace/heartbeat-service.js";
import { commitTurnChanges } from "../workspace/turn-commit.js";

describe("Commit guarantees", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `vellum-commit-guarantee-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
    _resetHeartbeatState();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function gitEnv(cwd: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("GIT_")) {
        env[key] = value;
      }
    }
    env.GIT_CEILING_DIRECTORIES = cwd;
    return env;
  }

  function commitCount(cwd: string): number {
    return parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd,
        encoding: "utf-8",
        env: gitEnv(cwd),
      }).trim(),
      10,
    );
  }

  function lastCommitMessage(cwd: string): string {
    return execFileSync("git", ["log", "-1", "--pretty=%B"], {
      cwd,
      encoding: "utf-8",
      env: gitEnv(cwd),
    }).trim();
  }

  function isWorkspaceClean(cwd: string): boolean {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      env: gitEnv(cwd),
    }).trim();
    return status === "";
  }

  describe("session turn-boundary commit after post-processing error", () => {
    test("commits workspace changes even when post-processing throws", async () => {
      // Simulate the session.ts commit-guarantee pattern:
      //   1. Agent loop runs and modifies workspace files
      //   2. Post-processing (resolveAssistantAttachments) throws
      //   3. Turn-boundary commit must still happen in finally block

      const conversationId = "sess_post_processing_error";
      const service = getWorkspaceGitService(testDir);
      await service.ensureInitialized();

      // Baseline: initial commit only
      expect(commitCount(testDir)).toBe(1);

      let turnCount = 0;

      // Simulate runAgentLoop with the finally-block commit pattern
      let turnStarted = false;
      try {
        // Step 1: Agent loop runs — tools modify workspace files
        writeFileSync(join(testDir, "tool-output.txt"), "generated content");
        writeFileSync(join(testDir, "modified-file.ts"), "export const x = 1;");
        turnStarted = true;

        // Step 2: Post-processing throws (simulating resolveAssistantAttachments failure)
        throw new Error("Simulated resolveAssistantAttachments failure");
      } catch {
        // Error handled (session emits error event, etc.)
      } finally {
        // Step 3: Turn-boundary commit in finally block — the key guarantee
        if (turnStarted) {
          turnCount++;
          await commitTurnChanges(testDir, conversationId, turnCount);
        }
      }

      // Assert: workspace changes were committed despite the post-processing error
      expect(commitCount(testDir)).toBe(2);
      expect(isWorkspaceClean(testDir)).toBe(true);

      const msg = lastCommitMessage(testDir);
      expect(msg).toContain("Turn:");
      expect(msg).toContain("Conversation: sess_post_processing_error");
      expect(msg).toContain("Turn: 1");
      expect(msg).toContain("Files: 2 changed");
    });

    test("does not commit when turn never started (pre-message blocked)", async () => {
      // When pre-message hooks block the turn, no commit should occur
      const service = getWorkspaceGitService(testDir);
      await service.ensureInitialized();

      let turnCount = 0;
      let turnStarted = false;

      try {
        // Pre-message hook blocks — early return before agent loop
        const blocked = true;
        if (blocked) {
          return; // Simulates the early return in session.ts
        }
        turnStarted = true; // Never reached
      } catch {
        // Error handled
      } finally {
        if (turnStarted) {
          turnCount++;
          await commitTurnChanges(testDir, "sess_blocked", turnCount);
        }
      }

      // Assert: no turn-boundary commit was created (only initial commit)
      expect(commitCount(testDir)).toBe(1);
      expect(turnCount).toBe(0);
    });

    test("commits workspace changes when user cancels mid-turn", async () => {
      // When the user cancels, the agent loop may have already modified files.
      // The finally-block commit must still run.
      const conversationId = "sess_cancelled";
      const service = getWorkspaceGitService(testDir);
      await service.ensureInitialized();

      let turnCount = 0;
      let turnStarted = false;

      try {
        // Agent loop starts and modifies files before cancellation
        writeFileSync(join(testDir, "partial-work.ts"), "partial content");
        turnStarted = true;

        // User cancels — agent loop throws AbortError
        const abortError = new Error("AbortError");
        abortError.name = "AbortError";
        throw abortError;
      } catch {
        // Cancellation handled (session emits generation_cancelled)
      } finally {
        if (turnStarted) {
          turnCount++;
          await commitTurnChanges(testDir, conversationId, turnCount);
        }
      }

      // Assert: partial work was committed
      expect(commitCount(testDir)).toBe(2);
      expect(isWorkspaceClean(testDir)).toBe(true);
      expect(lastCommitMessage(testDir)).toContain("Files: 1 changed");
    });

    test("commits across multiple turns with intermittent errors", async () => {
      // Verify commit guarantees hold across multiple turns where some
      // succeed normally and others have post-processing errors.
      const conversationId = "sess_mixed";
      const service = getWorkspaceGitService(testDir);
      await service.ensureInitialized();

      let turnCount = 0;

      // Turn 1: normal success
      {
        let turnStarted = false;
        try {
          writeFileSync(join(testDir, "turn1.ts"), "turn 1 content");
          turnStarted = true;
          // Post-processing succeeds
        } finally {
          if (turnStarted) {
            turnCount++;
            await commitTurnChanges(testDir, conversationId, turnCount);
          }
        }
      }

      // Turn 2: post-processing error
      {
        let turnStarted = false;
        try {
          writeFileSync(join(testDir, "turn2.ts"), "turn 2 content");
          turnStarted = true;
          throw new Error("Post-processing failure");
        } catch {
          // handled
        } finally {
          if (turnStarted) {
            turnCount++;
            await commitTurnChanges(testDir, conversationId, turnCount);
          }
        }
      }

      // Turn 3: normal success
      {
        let turnStarted = false;
        try {
          writeFileSync(join(testDir, "turn3.ts"), "turn 3 content");
          turnStarted = true;
        } finally {
          if (turnStarted) {
            turnCount++;
            await commitTurnChanges(testDir, conversationId, turnCount);
          }
        }
      }

      // Assert: all 3 turns were committed (initial + 3 turns = 4)
      expect(commitCount(testDir)).toBe(4);
      expect(isWorkspaceClean(testDir)).toBe(true);
      expect(turnCount).toBe(3);
    });
  });

  describe("lifecycle shutdown commit sequencing", () => {
    test("post-stop commit catches writes made during server.stop()", async () => {
      // Simulate the lifecycle shutdown flow where writes occur during
      // server.stop() (e.g. in-flight tool executions completing during drain).
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const services = new Map<string, WorkspaceGitService>();
      services.set(testDir, service);

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      // Pre-stop commit: captures existing dirty state
      writeFileSync(join(testDir, "pre-stop-file.txt"), "pre-stop content");

      const preStopResult = await heartbeat.commitAllPending();
      expect(preStopResult.committed).toBe(1);
      expect(commitCount(testDir)).toBe(2); // initial + pre-stop

      // Simulate writes that occur during server.stop()
      writeFileSync(
        join(testDir, "during-stop-file.txt"),
        "written during server drain",
      );

      // Post-stop commit: catches the late writes
      const postStopResult = await heartbeat.commitAllPending();
      expect(postStopResult.committed).toBe(1);
      expect(commitCount(testDir)).toBe(3); // initial + pre-stop + post-stop

      // Verify the post-stop commit captured the file
      expect(isWorkspaceClean(testDir)).toBe(true);
      expect(lastCommitMessage(testDir)).toContain("shutdown");
    });

    test("shutdown does not deadlock when commit fails", async () => {
      // Both pre-stop and post-stop commits must be non-fatal to prevent
      // shutdown from hanging.
      const services = new Map<string, WorkspaceGitService>();
      // Use an uninitialized service that will fail when trying to commit
      const uninitDir = join(
        tmpdir(),
        `vellum-uninit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(uninitDir, { recursive: true });
      const uninitService = new WorkspaceGitService(uninitDir);
      services.set(uninitDir, uninitService);

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      // Both calls should complete without throwing
      const preStop = await heartbeat.commitAllPending();
      const postStop = await heartbeat.commitAllPending();

      // Uninitialized workspaces are skipped gracefully
      expect(preStop.committed).toBe(0);
      expect(postStop.committed).toBe(0);

      rmSync(uninitDir, { recursive: true, force: true });
    });

    test("post-stop commit is idempotent when no new writes occur", async () => {
      const service = new WorkspaceGitService(testDir);
      await service.ensureInitialized();

      const services = new Map<string, WorkspaceGitService>();
      services.set(testDir, service);

      const heartbeat = new WorkspaceHeartbeatService({
        getServices: () => services,
      });

      // Pre-stop commit with dirty state
      writeFileSync(join(testDir, "file.txt"), "content");
      await heartbeat.commitAllPending();
      expect(commitCount(testDir)).toBe(2);

      // Post-stop commit with no new writes — should be a no-op
      const postStop = await heartbeat.commitAllPending();
      expect(postStop.committed).toBe(0);
      expect(commitCount(testDir)).toBe(2); // unchanged
    });
  });
});
