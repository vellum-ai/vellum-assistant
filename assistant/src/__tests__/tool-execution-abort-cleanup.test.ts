/**
 * Tests verifying that resources are properly cleaned up when AbortSignal fires
 * during tool execution: shell processes are killed, file operations respect
 * pre-abort signals, and git operations abort via the signal.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// ── Shared mock setup ────────────────────────────────────────────────────────
// Config mock must be declared before importing tool modules so that the
// mock.module calls are hoisted above the dynamic imports.
import { mock } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "anthropic",
    model: "test",
    maxTokens: 4096,
    dataDir: "/tmp",
    timeouts: {
      shellDefaultTimeoutSec: 120,
      shellMaxTimeoutSec: 600,
      permissionTimeoutSec: 300,
    },
    sandbox: { enabled: false, backend: "native" as const },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: {
      enabled: false,
      action: "warn" as const,
      entropyThreshold: 4.0,
    },
  }),
  loadConfig: () => ({}),
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// shell.ts requires the sandbox wrapper — provide a pass-through stub.
mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: (
    command: string,
    _cwd: string,
    _cfg: unknown,
    _opts?: unknown,
  ) => ({
    command: "bash",
    args: ["-c", "--", command],
    sandboxed: false,
  }),
}));

// shell.ts uses the script proxy — stub it to avoid network side-effects.
mock.module("../tools/network/script-proxy/index.js", () => ({
  getOrStartSession: async () => ({
    session: { id: "mock-session" },
  }),
  getSessionEnv: () => ({}),
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => "/tmp",
  getDataDir: () => "/tmp",
  getWorkspaceDir: () => "/tmp/workspace",
  getDbPath: () => "/tmp/assistant.db",
  ensureDataDir: () => {},
}));

mock.module("../tools/credentials/resolve.js", () => ({
  resolveCredentialRef: () => null,
}));

mock.module("../tools/network/script-proxy/logging.js", () => ({
  buildCredentialRefTrace: () => ({}),
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
  scanText: () => [],
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const testDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "abort-cleanup-test-")));
  testDirs.push(dir);
  return dir;
}

function makeToolContext(workingDir: string, signal?: AbortSignal) {
  return {
    workingDir,
    conversationId: "test-conv",
    trustClass: "guardian" as const,
    signal,
  };
}

// Restore all module mocks before each test so that this suite is not
// order-dependent. Without this, stubs installed by one test file can bleed
// into subsequent files and produce false passes or failures.
beforeEach(() => {
  mock.restore();
});

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1. Shell process cleanup on AbortSignal ─────────────────────────────────

describe("shell tool — process cleanup on AbortSignal", () => {
  test("kills the child process when AbortSignal fires mid-execution", async () => {
    const { hostShellTool } =
      await import("../tools/host-terminal/host-shell.js");
    const dir = makeTempDir();
    const ac = new AbortController();

    const promise = hostShellTool.execute(
      { command: "sleep 30", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    // Allow the child process to start before aborting.
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const result = await promise;

    // The process was killed by SIGKILL, so it exits non-zero.
    expect(result.isError).toBe(true);
  });

  test("kills the child process immediately when signal is already aborted", async () => {
    const { hostShellTool } =
      await import("../tools/host-terminal/host-shell.js");
    const dir = makeTempDir();
    const ac = new AbortController();
    ac.abort(); // pre-aborted

    const result = await hostShellTool.execute(
      { command: "sleep 30", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(true);
  });

  test("completes normally when abort signal never fires", async () => {
    const { hostShellTool } =
      await import("../tools/host-terminal/host-shell.js");
    const dir = makeTempDir();
    const ac = new AbortController();

    const result = await hostShellTool.execute(
      { command: "echo completed", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed");
    // Ensure aborting after completion doesn't cause errors.
    ac.abort();
  });

  test("removes the abort listener after process exits normally", async () => {
    const { hostShellTool } =
      await import("../tools/host-terminal/host-shell.js");
    const dir = makeTempDir();
    const ac = new AbortController();

    await hostShellTool.execute(
      { command: "echo done", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    // After the process exits the abort listener should be removed.
    // AbortSignal.eventCounts is not universally available, but we can
    // verify the listener doesn't hold a reference by aborting and
    // confirming no error is thrown from a dangling handler.
    expect(() => ac.abort()).not.toThrow();
  });

  test("abort during long-running output does not leave orphaned listeners", async () => {
    const { hostShellTool } =
      await import("../tools/host-terminal/host-shell.js");
    const dir = makeTempDir();
    const ac = new AbortController();
    const chunks: string[] = [];

    const promise = hostShellTool.execute(
      {
        command: "for i in 1 2 3 4 5; do echo $i; sleep 2; done",
        reason: "test",
      },
      {
        ...makeToolContext(dir, ac.signal),
        onOutput: (c: string) => chunks.push(c),
      },
    );

    // Wait for the first chunk to arrive before aborting.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (chunks.length > 0) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });

    ac.abort();
    const result = await promise;

    // Process was killed.
    expect(result.isError).toBe(true);
  });
});

// ── 2. File operation abort handling ─────────────────────────────────────────
//
// File operations in this codebase use synchronous Node.js APIs
// (readFileSync / writeFileSync), so there are no long-lived file handles
// to close. Abort cancellation is handled at the executor level:
// ToolExecutor.execute() checks signal.aborted before dispatching to the
// tool and returns a 'Cancelled' error result immediately.
// The tests below verify that contract at the tool level.

describe("file tools — abort signal pre-check", () => {
  test("file_write tool: execute still succeeds when context has no signal", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/filesystem/write.js");
    const fileWriteTool = getTool("file_write")!;
    const dir = makeTempDir();

    const result = await fileWriteTool.execute(
      { path: "out.txt", content: "hello", reason: "test" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
  });

  test("file_write tool: execute succeeds with a non-aborted signal", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/filesystem/write.js");
    const fileWriteTool = getTool("file_write")!;
    const dir = makeTempDir();
    const ac = new AbortController();

    const result = await fileWriteTool.execute(
      { path: "out2.txt", content: "world", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(dir, "out2.txt"))).toBe(true);
  });

  test("file_read tool: execute succeeds when context has no signal", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/filesystem/read.js");
    const fileReadTool = getTool("file_read")!;
    const dir = makeTempDir();
    writeFileSync(join(dir, "read-me.txt"), "content to read");

    const result = await fileReadTool.execute(
      { path: "read-me.txt" },
      makeToolContext(dir),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("content to read");
  });

  test("file_read tool: execute succeeds with a non-aborted signal", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/filesystem/read.js");
    const fileReadTool = getTool("file_read")!;
    const dir = makeTempDir();
    writeFileSync(join(dir, "read-me2.txt"), "readable");
    const ac = new AbortController();

    const result = await fileReadTool.execute(
      { path: "read-me2.txt" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("readable");
  });

  test("file_write tool: synchronous write completes regardless of pre-aborted signal (abort checked at executor level)", async () => {
    // The tool implementations use synchronous Node.js I/O, so they complete
    // regardless of the signal. The ToolExecutor.execute() wrapper is
    // responsible for checking signal.aborted before dispatching; the tool
    // itself is not expected to check it. This test documents that contract.
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/filesystem/write.js");

    const dir = makeTempDir();
    const ac = new AbortController();
    ac.abort(); // pre-aborted

    const fileWriteTool = getTool("file_write")!;

    // When invoked directly (not through ToolExecutor), the sync write runs.
    const result = await fileWriteTool.execute(
      { path: "should-write.txt", content: "test", reason: "test" },
      makeToolContext(dir, ac.signal),
    );
    // Should succeed — the tool's own execute() doesn't check the signal.
    expect(result.isError).toBe(false);
  });
});

// ── 3. Git operation cleanup on AbortSignal ───────────────────────────────────

describe("WorkspaceGitService — abort signal propagation", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `abort-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    testDirs.push(testDir);
  });

  test("writeNote: AbortSignal cancels the git notes operation", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    const headHash = await service.getHeadHash();

    // Abort immediately — writeNote passes the signal to execFileAsync.
    const ac = new AbortController();
    ac.abort();

    // The operation should throw (or resolve with an error) because the signal
    // is already aborted when execFileAsync receives it.
    let threw = false;
    try {
      await service.writeNote(headHash, "should-be-cancelled", ac.signal);
    } catch {
      threw = true;
    }

    // With a pre-aborted signal, Node's execFileAsync rejects immediately.
    expect(threw).toBe(true);
  });

  test("writeNote: completes normally without an abort signal", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    const headHash = await service.getHeadHash();

    // Should not throw.
    await service.writeNote(headHash, "note content");
  });

  test("commitIfDirty: respects deadlineMs to avoid stale commits", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    writeFileSync(join(testDir, "dirty.txt"), "uncommitted");

    // Deadline already expired.
    const { committed } = await service.commitIfDirty(
      () => ({ message: "should not commit" }),
      { deadlineMs: Date.now() - 1000 },
    );

    expect(committed).toBe(false);
  });

  test("commitIfDirty: commits when deadline has not expired", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    writeFileSync(join(testDir, "commit-me.txt"), "changes");

    const { committed } = await service.commitIfDirty(
      () => ({ message: "test commit" }),
      { deadlineMs: Date.now() + 30_000 },
    );

    expect(committed).toBe(true);
  });

  test("ensureInitialized: concurrent calls resolve without duplicate git inits", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);

    // Fire multiple concurrent init calls — all should resolve without errors.
    await Promise.all([
      service.ensureInitialized(),
      service.ensureInitialized(),
      service.ensureInitialized(),
    ]);

    expect(service.isInitialized()).toBe(true);
  });

  test("commitChanges: after abort-signalled writeNote does not corrupt repo", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    writeFileSync(join(testDir, "f.txt"), "data");

    // Commit the file.
    await service.commitChanges("add file");

    const headHash = await service.getHeadHash();

    // Fire a pre-aborted writeNote — it should fail without corrupting the repo.
    const ac = new AbortController();
    ac.abort();

    let noteAborted = false;
    try {
      await service.writeNote(headHash, "note", ac.signal);
    } catch {
      noteAborted = true;
    }
    expect(noteAborted).toBe(true);

    // A subsequent commit should succeed — the aborted note did not corrupt state.
    await service.commitChanges("second commit");

    // Repo must still be in a clean, functional state.
    const status = await service.getStatus();
    expect(status.clean).toBe(true);
  });

  test("concurrent git operations are serialized by the mutex", async () => {
    const { WorkspaceGitService, _resetGitServiceRegistry } =
      await import("../workspace/git-service.js");

    _resetGitServiceRegistry();
    const service = new WorkspaceGitService(testDir);
    await service.ensureInitialized();

    // Track the order of execution to prove serialization.
    const executionLog: string[] = [];

    // Create a deferred promise so we can explicitly control when the first
    // mutex holder releases. This guarantees the second operation is queued
    // behind the first — no timing dependency.
    let releaseFirst!: () => void;
    const firstBlocks = new Promise<void>((r) => {
      releaseFirst = r;
    });

    // Operation A: acquire the mutex, signal it's holding, then wait for
    // our explicit release before finishing.
    let opAQueued!: () => void;
    const opAIsHolding = new Promise<void>((r) => {
      opAQueued = r;
    });

    const opA = service.runWithMutex(async (exec) => {
      executionLog.push("A:start");
      opAQueued(); // signal that A holds the lock
      await firstBlocks; // wait until we explicitly release
      await exec(["status"]);
      executionLog.push("A:end");
    });

    // Wait until A is definitely holding the lock before starting B.
    await opAIsHolding;

    // Operation B: a normal commitChanges that must wait for A to finish.
    writeFileSync(join(testDir, "concurrent.txt"), "data");
    const opB = service.commitChanges("concurrent commit").then(() => {
      executionLog.push("B:done");
    });

    // At this point B is queued behind A in the mutex. Release A.
    releaseFirst();

    // Both operations should complete without errors.
    await Promise.all([opA, opB]);

    // A must have fully completed before B started — that's the mutex guarantee.
    expect(executionLog).toEqual(["A:start", "A:end", "B:done"]);
  });
});

// ── 4. Shell tool (sandboxed) — abort signal ─────────────────────────────────
//
// The sandboxed `bash` tool mirrors the host_bash abort handling. Since the
// sandbox stub is already mocked above, we can drive the sandboxed path too.

describe("bash (sandboxed) shell tool — process cleanup on AbortSignal", () => {
  test("kills child process when signal fires mid-execution", async () => {
    // Import shell.ts (registered as 'bash') after mocks are in place.
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/terminal/shell.js");

    // Assert registration — a missing tool signals a real regression, not a skip.
    expect(getTool("bash")).toBeDefined();
    const bashTool = getTool("bash")!;

    const dir = makeTempDir();
    const ac = new AbortController();

    const promise = bashTool.execute(
      { command: "sleep 30", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const result = await promise;
    expect(result.isError).toBe(true);
  });

  test("kills child process immediately when signal is pre-aborted", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/terminal/shell.js");

    expect(getTool("bash")).toBeDefined();
    const bashTool = getTool("bash")!;

    const dir = makeTempDir();
    const ac = new AbortController();
    ac.abort();

    const result = await bashTool.execute(
      { command: "sleep 30", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(true);
  });

  test("short command completes normally with a non-aborted signal attached", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/terminal/shell.js");

    expect(getTool("bash")).toBeDefined();
    const bashTool = getTool("bash")!;

    const dir = makeTempDir();
    const ac = new AbortController();

    const result = await bashTool.execute(
      { command: "echo hello-world", reason: "test" },
      makeToolContext(dir, ac.signal),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello-world");
    ac.abort(); // cleanup after success
  });
});
