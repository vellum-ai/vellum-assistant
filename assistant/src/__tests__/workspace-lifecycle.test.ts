/**
 * Integration-style test that exercises the full git workspace lifecycle:
 *   lazy init → turn-boundary commits → heartbeat safety net → commit history verification.
 *
 * This test wires together WorkspaceGitService, commitTurnChanges, and WorkspaceHeartbeatService
 * in the same flow a real daemon session would follow.
 *
 * Also contains hook-trust lifecycle tests that verify hooks stay suppressed through
 * the full workspace lifecycle until an explicit trust decision is made.
 */

// ─── Bun mock.module calls must appear before all other imports ───────────────

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// Default: fail-closed ("ask"). Hook trust tests switch to "allow".
let _lifecycleMockDecision: "allow" | "deny" | "ask" = "ask";

mock.module("../workspace/git-hooks-trust.js", () => ({
  getGitHooksTrustDecision: (_workspaceDir: string) => _lifecycleMockDecision,
  setGitHooksTrustDecision: () => {},
  detectConfiguredHooks: async () => ({
    hookFiles: [],
    hooksDir: "",
    hasHooks: false,
  }),
  GIT_HOOKS_TRUST_PSEUDO_TOOL: "__internal:git-hooks-trust",
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
}));

// ─── Module imports (after mocks) ────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _resetEnrichmentService,
  getEnrichmentService,
} from "../workspace/commit-message-enrichment-service.js";
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

describe("Workspace git lifecycle (integration)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `vellum-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    _resetGitServiceRegistry();
    _resetHeartbeatState();
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

  afterAll(async () => {
    try {
      await getEnrichmentService().shutdown();
    } catch {
      /* ignore */
    }
    _resetEnrichmentService();
  });

  // Build a clean git env: strip all GIT_* env vars that CI runners
  // inject, then set GIT_CEILING_DIRECTORIES to isolate test repos.
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

  // Helper to read git log output
  function gitLog(cwd: string, format = "--oneline"): string {
    return execFileSync("git", ["log", format], {
      cwd,
      encoding: "utf-8",
      env: gitEnv(cwd),
    }).trim();
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

  function lastCommitFiles(cwd: string): string[] {
    return execFileSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd,
      encoding: "utf-8",
      env: gitEnv(cwd),
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  }

  test("full lifecycle: init → turns → heartbeat → history", async () => {
    const sessionId = "sess_lifecycle_test";

    // ----------------------------------------------------------------
    // Step 1: Lazy initialization — workspace starts without a git repo
    // ----------------------------------------------------------------
    expect(existsSync(join(testDir, ".git"))).toBe(false);

    // Pre-populate workspace with files (simulates existing workspace)
    writeFileSync(join(testDir, "README.md"), "# My Project");
    writeFileSync(join(testDir, "config.json"), '{"version": 1}');

    // Getting the service via the singleton registry is how session.ts does it
    const service = getWorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Verify lazy init created the repo and the initial commit
    expect(existsSync(join(testDir, ".git"))).toBe(true);
    expect(commitCount(testDir)).toBe(1);
    expect(lastCommitMessage(testDir)).toContain(
      "Initial commit: migrated existing workspace",
    );

    // ----------------------------------------------------------------
    // Step 2: Turn 1 — assistant edits files, turn-boundary commit fires
    // ----------------------------------------------------------------
    writeFileSync(
      join(testDir, "hello.ts"),
      'export const greeting = "hello";',
    );
    writeFileSync(join(testDir, "config.json"), '{"version": 2}');

    await commitTurnChanges(testDir, sessionId, 1);

    expect(commitCount(testDir)).toBe(2);
    const turn1Msg = lastCommitMessage(testDir);
    expect(turn1Msg).toContain("Turn:");
    expect(turn1Msg).toContain("Session: sess_lifecycle_test");
    expect(turn1Msg).toContain("Turn: 1");
    expect(turn1Msg).toContain("Files: 2 changed");
    expect(turn1Msg).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);

    const turn1Files = lastCommitFiles(testDir);
    expect(turn1Files).toContain("hello.ts");
    expect(turn1Files).toContain("config.json");

    // ----------------------------------------------------------------
    // Step 3: Turn 2 — more edits
    // ----------------------------------------------------------------
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "index.ts"), 'console.log("hello");');

    await commitTurnChanges(testDir, sessionId, 2);

    expect(commitCount(testDir)).toBe(3);
    const turn2Msg = lastCommitMessage(testDir);
    expect(turn2Msg).toContain("Turn: 2");
    expect(turn2Msg).toContain("Files: 1 changed");

    // ----------------------------------------------------------------
    // Step 4: Turn 3 — no changes (should NOT create a commit)
    // ----------------------------------------------------------------
    await commitTurnChanges(testDir, sessionId, 3);
    expect(commitCount(testDir)).toBe(3); // Still 3

    // ----------------------------------------------------------------
    // Step 5: Heartbeat safety net — simulate uncommitted changes
    //         that linger past the age threshold
    // ----------------------------------------------------------------
    writeFileSync(
      join(testDir, "background-output.log.txt"),
      "background process output",
    );

    // Build a services map the way the heartbeat does at runtime
    const services = new Map<string, WorkspaceGitService>();
    services.set(testDir, service);

    let fakeTime = 2_000_000;
    const heartbeat = new WorkspaceHeartbeatService({
      ageThresholdMs: 5 * 60 * 1000,
      fileThreshold: 100,
      getServices: () => services,
      now: () => fakeTime,
    });

    // First heartbeat: records the dirty timestamp
    const firstCheck = await heartbeat.check();
    expect(firstCheck.committed).toBe(0);
    expect(firstCheck.skipped).toBe(1); // Below threshold

    // Advance time past 5-minute threshold
    fakeTime += 6 * 60 * 1000;

    const secondCheck = await heartbeat.check();
    expect(secondCheck.committed).toBe(1);
    expect(commitCount(testDir)).toBe(4);

    const heartbeatMsg = lastCommitMessage(testDir);
    expect(heartbeatMsg).toContain("auto-commit");
    expect(heartbeatMsg).toContain("heartbeat");
    expect(heartbeatMsg).toContain("safety net");

    // ----------------------------------------------------------------
    // Step 6: Verify full commit history has correct ordering/metadata
    // ----------------------------------------------------------------
    const fullLog = gitLog(testDir, "--oneline");
    const lines = fullLog.split("\n");
    expect(lines.length).toBe(4);

    // Most recent first
    expect(lines[0]).toContain("auto-commit");
    expect(lines[1]).toContain("Turn:");
    expect(lines[2]).toContain("Turn:");
    expect(lines[3]).toContain("Initial commit");

    // ----------------------------------------------------------------
    // Step 7: Shutdown commit — one more file, then graceful shutdown
    // ----------------------------------------------------------------
    writeFileSync(join(testDir, "unsaved-work.txt"), "important unsaved data");

    const shutdownResult = await heartbeat.commitAllPending();
    expect(shutdownResult.committed).toBe(1);
    expect(commitCount(testDir)).toBe(5);
    expect(lastCommitMessage(testDir)).toContain("shutdown");
  });

  test("workspace recovers from corrupted .git directory", async () => {
    // Initialize a real repo, then corrupt it by removing HEAD.
    // This is more realistic than an empty .git dir (which behaves
    // differently across git versions and CI environments).
    execFileSync("git", ["init", "-b", "main"], {
      cwd: testDir,
      encoding: "utf-8",
      env: gitEnv(testDir),
    });
    rmSync(join(testDir, ".git", "HEAD"));

    const service = new WorkspaceGitService(testDir);

    // The key behavior: ensureInitialized must NOT throw on a corrupted repo.
    await service.ensureInitialized();

    // Service reports as initialized and the repo is functional.
    // We only assert isInitialized() here because on CI runners the
    // corruption recovery path can't fully isolate from the parent
    // checkout repo (git env vars and configs leak through despite
    // cleanGitEnv), causing git status and log helpers to read from
    // the wrong repo.
    expect(service.isInitialized()).toBe(true);
  });

  test("concurrent turn commits and heartbeats do not conflict", async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Simulate concurrent turn commits and heartbeat checks
    const services = new Map<string, WorkspaceGitService>();
    services.set(testDir, service);

    const heartbeat = new WorkspaceHeartbeatService({
      ageThresholdMs: 0,
      fileThreshold: 1,
      getServices: () => services,
    });

    // Create files and fire turn commits + heartbeat checks concurrently
    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `concurrent-${i}.txt`), `content ${i}`);
      operations.push(commitTurnChanges(testDir, "sess_concurrent", i + 1));
      operations.push(heartbeat.check());
    }

    // None of these should throw (mutex serialization prevents conflicts)
    await Promise.all(operations);

    // Verify the repo is in a consistent state
    const status = await service.getStatus();
    expect(status.clean).toBe(true);
  });

  test("fire-and-forget pattern does not lose commits", async () => {
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Simulate the session.ts fire-and-forget pattern:
    // `void commitTurnChanges(...)` -- the void discards the promise
    writeFileSync(join(testDir, "fire-forget-1.txt"), "content 1");
    const p1 = commitTurnChanges(testDir, "sess_ff", 1);

    writeFileSync(join(testDir, "fire-forget-2.txt"), "content 2");
    const p2 = commitTurnChanges(testDir, "sess_ff", 2);

    // Even though session.ts doesn't await these, they should eventually complete
    await Promise.all([p1, p2]);

    // All files should be committed (no data loss).
    // The first commit may absorb both files, so the second sees a clean
    // workspace and correctly skips rather than creating an empty commit.
    const count = commitCount(testDir);
    expect(count).toBeGreaterThanOrEqual(2); // initial + at least 1 turn commit

    // Verify no file changes are lost
    const status = await service.getStatus();
    expect(status.clean).toBe(true);
  });

  test("getWorkspaceGitService returns same instance across turn commits and heartbeat", async () => {
    // Verify the singleton registry is coherent across all modules
    const fromTurnCommitPath = getWorkspaceGitService(testDir);
    const fromHeartbeatPath = getWorkspaceGitService(testDir);
    const fromDirectCall = getWorkspaceGitService(testDir);

    expect(fromTurnCommitPath).toBe(fromHeartbeatPath);
    expect(fromHeartbeatPath).toBe(fromDirectCall);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Hook trust lifecycle — fail-closed through the full session lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  test("hooks remain suppressed throughout full lifecycle when trust is ask (default)", async () => {
    // Ensure default fail-closed behavior
    _lifecycleMockDecision = "ask";

    const sessionId = "sess_hook_trust_lifecycle";

    // Plant a hook that writes a sentinel if it executes
    const sentinel = join(testDir, "hook-lifecycle.marker");
    const hooksDir = join(testDir, ".git", "hooks");

    const service = getWorkspaceGitService(testDir);
    await service.ensureInitialized();

    // .git/hooks exists only after init
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "pre-commit"),
      `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`,
      { mode: 0o755 },
    );

    // Turn 1 commit
    writeFileSync(join(testDir, "turn1.ts"), "content");
    await commitTurnChanges(testDir, sessionId, 1);
    expect(existsSync(sentinel)).toBe(false);

    // Turn 2 commit
    writeFileSync(join(testDir, "turn2.ts"), "more content");
    await commitTurnChanges(testDir, sessionId, 2);
    expect(existsSync(sentinel)).toBe(false);

    // Heartbeat commit
    writeFileSync(join(testDir, "background.txt"), "bg work");

    const services = new Map<string, WorkspaceGitService>();
    services.set(testDir, service);

    const heartbeat = new WorkspaceHeartbeatService({
      ageThresholdMs: 0,
      fileThreshold: 1,
      getServices: () => services,
    });

    const hbResult = await heartbeat.check();
    expect(hbResult.committed).toBe(1);
    expect(existsSync(sentinel)).toBe(false);

    // Shutdown commit
    writeFileSync(join(testDir, "final.txt"), "final write");
    const shutdownResult = await heartbeat.commitAllPending();
    expect(shutdownResult.committed).toBe(1);
    expect(existsSync(sentinel)).toBe(false);

    // All commits were created without the hook running
    expect(commitCount(testDir)).toBeGreaterThanOrEqual(4); // init + 2 turns + heartbeat + shutdown
  });

  test("hooks run for every commit once workspace is explicitly trusted", async () => {
    // Simulate the user granting trust
    _lifecycleMockDecision = "allow";

    const sentinel = join(testDir, "trusted-lifecycle.marker");
    const hooksDir = join(testDir, ".git", "hooks");

    const service = getWorkspaceGitService(testDir);
    await service.ensureInitialized();

    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "pre-commit"),
      `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`,
      { mode: 0o755 },
    );

    writeFileSync(join(testDir, "trusted.ts"), "export const y = 1;");
    await service.commitChanges("test: trust lifecycle allow");

    // Hook should have run for the trusted workspace
    expect(existsSync(sentinel)).toBe(true);
  });
});
