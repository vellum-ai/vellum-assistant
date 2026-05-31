/**
 * Tests for `assistant/src/memory/v2/consolidation-job.ts`.
 *
 * Coverage matrix:
 *   - Flag off → no runner call; returns disabled.
 *   - Flag on, empty buffer → no runner call; returns empty_buffer.
 *   - Flag on, non-empty buffer → runner invoked with the cutoff-templated
 *     prompt and `suppressFailureNotifications: true`; follow-up jobs
 *     enqueued on success.
 *   - v3 flag (shadow/live) on → `memory_v3_maintain` enqueued alongside the
 *     unconditional `memory_v2_reembed`; off → only reembed; a thrown v3
 *     enqueue is swallowed and consolidation still succeeds.
 *   - Lock file already present → second call returns locked.
 *   - Runner returns ok=false → run_failed surfaced; NO follow-up jobs;
 *     `emitNotificationSignal` was NOT called as a result of the failure
 *     (suppression is honored end-to-end).
 *
 * Tests use temp workspaces (mkdtemp) and never touch `~/.vellum/`. Sample
 * content uses generic placeholders (Alice).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// ── feature-flag mock ───────────────────────────────────────────────
//
// The handler gates the `memory_v3_maintain` follow-up on the v3 flags.
// Mock the resolver (mirroring the v3 maintain-job test) so flag state is
// a plain map under test control, independent of the gateway override cache
// or config-object internals.
let flagState: Record<string, boolean> = {};

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown): boolean =>
    flagState[key] ?? false,
}));

// ── runBackgroundJob mock ───────────────────────────────────────────
//
// The consolidation handler delegates the bootstrap + processMessage +
// timeout + classification + suppress-aware emit to runBackgroundJob.
// We stub it here and assert (a) the runner is called with
// `suppressFailureNotifications: true`, and (b) the prompt + callSite
// + trustContext + origin match what the consolidation surface expects.
let runnerCalls = 0;
let runnerLastArgs: Record<string, unknown> | null = null;
let runnerImpl: () => Promise<{
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: string;
}> = async () => ({ conversationId: "conv-1", ok: true });

mock.module("../../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: Record<string, unknown>) => {
    runnerCalls += 1;
    runnerLastArgs = opts;
    return runnerImpl();
  },
}));

// ── emitNotificationSignal spy ──────────────────────────────────────
//
// The runner is stubbed above, so the real `emit-signal` module never
// runs in these tests. We mock it as a defensive belt-and-suspenders
// assertion: even if the runner stub were swapped out for the real
// implementation, this counter would catch any path that ends up
// emitting a signal as a result of consolidation failure.
const emitCalls: Array<Record<string, unknown>> = [];

mock.module("../../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitCalls.push(params);
    return {
      signalId: "sig-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

// ── enqueueMemoryJob mock ───────────────────────────────────────────
const enqueuedJobs: Array<{
  type: string;
  payload: Record<string, unknown>;
}> = [];
let nextJobIdCounter = 0;
// When set to a job type, the next enqueue of that type throws — used to
// exercise the best-effort try/catch around the flag-gated v3 follow-up.
let enqueueThrowFor: string | null = null;

mock.module("../../jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
  ): string => {
    if (enqueueThrowFor === type) {
      enqueueThrowFor = null;
      throw new Error(`simulated enqueue failure for ${type}`);
    }
    enqueuedJobs.push({ type, payload });
    nextJobIdCounter += 1;
    return `job-${nextJobIdCounter}`;
  },
  isMemoryEnabled: () => true,
}));

// ── Workspace pin ───────────────────────────────────────────────────
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-consolidate-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { memoryV2ConsolidateJob } = await import("../consolidation-job.js");
const { CUTOFF_PLACEHOLDER, CONSOLIDATION_PROMPT } =
  await import("../prompts/consolidation.js");

// The resolver only reads `config.memory.v2.enabled` and
// `config.memory.v2.consolidation_prompt_path`, so a minimal stand-in
// covers both call sites without materializing the full default config.
const CONFIG = {
  memory: { v2: { enabled: true, consolidation_prompt_path: null } },
} as Parameters<typeof memoryV2ConsolidateJob>[1];
const CONFIG_DISABLED = {
  memory: { v2: { enabled: false, consolidation_prompt_path: null } },
} as Parameters<typeof memoryV2ConsolidateJob>[1];

function makeJob(): Parameters<typeof memoryV2ConsolidateJob>[0] {
  return {
    id: "consolidate-1",
    type: "memory_v2_consolidate",
    payload: {},
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const memoryDir = () => join(tmpWorkspace, "memory");
const lockPath = () =>
  join(tmpWorkspace, "memory", ".v2-state", "consolidation.lock");
const bufferPath = () => join(tmpWorkspace, "memory", "buffer.md");

beforeEach(() => {
  // Fresh workspace state per test — mirrors the seed migration so the
  // handler finds a clean memory tree.
  rmSync(memoryDir(), { recursive: true, force: true });
  mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
  mkdirSync(join(memoryDir(), "concepts"), { recursive: true });
  mkdirSync(join(memoryDir(), "archive"), { recursive: true });

  runnerCalls = 0;
  runnerLastArgs = null;
  runnerImpl = async () => ({ conversationId: "conv-1", ok: true });
  emitCalls.length = 0;
  enqueuedJobs.length = 0;
  nextJobIdCounter = 0;
  enqueueThrowFor = null;
  flagState = {};
});

// ---------------------------------------------------------------------------

describe("memoryV2ConsolidateJob — v2 disabled", () => {
  test("returns disabled without invoking the runner when memory.v2.enabled is false", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG_DISABLED);

    expect(result).toEqual({ kind: "disabled" });
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // Lock must NOT linger on the disabled path — the handler bailed before
    // the lock was acquired.
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("memoryV2ConsolidateJob — empty buffer", () => {
  test("returns empty_buffer when buffer.md is missing", async () => {
    expect(existsSync(bufferPath())).toBe(false);

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result).toEqual({ kind: "empty_buffer" });
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("returns empty_buffer when buffer.md is whitespace-only", async () => {
    writeFileSync(bufferPath(), "   \n\n\t\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result).toEqual({ kind: "empty_buffer" });
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("releases the lock on the empty-buffer skip path so the next run can re-attempt", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(result.kind).toBe("empty_buffer");
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("memoryV2ConsolidateJob — non-empty buffer", () => {
  beforeEach(() => {
    writeFileSync(
      bufferPath(),
      "- [Apr 27, 9:00 AM] Alice prefers VS Code over Vim.\n" +
        "- [Apr 27, 9:05 AM] Alice ships at end of day.\n",
    );
  });

  test("invokes runBackgroundJob with the cutoff-templated prompt and suppressFailureNotifications: true", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(runnerCalls).toBe(1);
    expect(runnerLastArgs).not.toBeNull();
    expect(runnerLastArgs?.jobName).toBe("memory.consolidate");
    expect(runnerLastArgs?.source).toBe("memory_v2_consolidation");
    expect(runnerLastArgs?.callSite).toBe("mainAgent");
    expect(runnerLastArgs?.origin).toBe("memory_consolidation");
    // The whole point of this PR: opt out of activity.failed notifications
    // because consolidation runs on tight intervals and transient failures
    // would spam the home feed.
    expect(runnerLastArgs?.suppressFailureNotifications).toBe(true);
    expect(runnerLastArgs?.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
    expect(typeof runnerLastArgs?.timeoutMs).toBe("number");
    expect((runnerLastArgs?.timeoutMs as number) > 0).toBe(true);

    // The prompt must contain the rendered consolidation body with the
    // cutoff substituted in. Asserting the placeholder is GONE catches a
    // regression where `replaceAll` is dropped and the model receives
    // `{{CUTOFF}}` literally.
    const prompt = runnerLastArgs?.prompt as string;
    expect(prompt).toContain("memory consolidation");
    expect(prompt).not.toContain(CUTOFF_PLACEHOLDER);
    // Cutoff is a buffer-entry-format timestamp (`Mon D, h:mm AM/PM`) so it
    // compares like-with-like against `buffer.md` lines at minute precision.
    expect(prompt).toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)\b/);
  });

  test("honors memory.v2.consolidation_prompt_path override when set", async () => {
    writeFileSync(
      join(tmpWorkspace, "custom-prompt.md"),
      "CUSTOM CONSOLIDATION at {{CUTOFF}}\n",
    );
    const overrideConfig = {
      memory: {
        v2: { enabled: true, consolidation_prompt_path: "custom-prompt.md" },
      },
    } as Parameters<typeof memoryV2ConsolidateJob>[1];

    const result = await memoryV2ConsolidateJob(makeJob(), overrideConfig);

    expect(result.kind).toBe("invoked");
    const prompt = runnerLastArgs?.prompt as string;
    expect(prompt).toMatch(
      /^CUSTOM CONSOLIDATION at [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/m,
    );
    expect(prompt).not.toContain("You are running memory consolidation");
    expect(prompt).not.toContain(CUTOFF_PLACEHOLDER);
  });

  test("enqueues the memory_v2_reembed follow-up job on success", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    if (result.kind === "invoked") {
      expect(result.followUpJobIds).toEqual(["job-1"]);
    }

    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]).toEqual({
      type: "memory_v2_reembed",
      payload: {},
    });
  });

  test("does NOT enqueue memory_v3_maintain when no v3 flag is set", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(enqueuedJobs.map((j) => j.type)).toEqual(["memory_v2_reembed"]);
  });

  test("enqueues memory_v3_maintain alongside reembed when memory-v3-shadow is on", async () => {
    flagState["memory-v3-shadow"] = true;

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    if (result.kind === "invoked") {
      expect(result.followUpJobIds).toEqual(["job-1", "job-2"]);
    }
    expect(enqueuedJobs).toEqual([
      { type: "memory_v2_reembed", payload: {} },
      { type: "memory_v3_maintain", payload: {} },
    ]);
  });

  test("enqueues memory_v3_maintain when memory-v3-live is on", async () => {
    flagState["memory-v3-live"] = true;

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(enqueuedJobs.map((j) => j.type)).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
  });

  test("swallows a thrown v3 enqueue and still succeeds with the reembed follow-up", async () => {
    // The v3 maintenance enqueue is best-effort: a throw must not fail the
    // consolidation that already wrote the agent's edits, nor drop the
    // unconditional v2 reembed that was enqueued before it.
    flagState["memory-v3-shadow"] = true;
    enqueueThrowFor = "memory_v3_maintain";

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    if (result.kind === "invoked") {
      // Only the reembed id made it in; the v3 enqueue threw before pushing.
      expect(result.followUpJobIds).toEqual(["job-1"]);
    }
    expect(enqueuedJobs.map((j) => j.type)).toEqual(["memory_v2_reembed"]);
  });

  test("releases the lock after a successful invocation so the next run can acquire it", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(result.kind).toBe("invoked");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("returns run_failed and skips follow-ups when the runner reports failure", async () => {
    runnerImpl = async () => ({
      conversationId: "conv-1",
      ok: false,
      error: new Error("simulated runner failure"),
      errorKind: "exception",
    });

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("run_failed");
    if (result.kind === "run_failed") {
      expect(result.reason).toBe("simulated runner failure");
    }
    // No follow-ups: the agent's writes may be partial and re-embedding
    // partial state would be misleading.
    expect(enqueuedJobs).toHaveLength(0);
    // Lock must still be released on the failure path so the next
    // scheduled consolidation can re-attempt.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("does NOT emit a notification signal when the runner fails (suppression honored)", async () => {
    // This is the user-visible payoff of `suppressFailureNotifications: true`:
    // even when the runner stub reports a failure, the consolidation
    // handler must not produce any notification side-effect. The runner
    // itself owns the suppression behavior; this test guards the contract
    // from the consolidation surface — if a future change ever bypasses
    // the runner and emits its own signal on the failure path, this assert
    // will catch it.
    runnerImpl = async () => ({
      conversationId: "conv-1",
      ok: false,
      error: new Error("network blip"),
      errorKind: "model_provider",
    });

    await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(emitCalls).toHaveLength(0);
  });
});

describe("memoryV2ConsolidateJob — concurrent invocations", () => {
  beforeEach(() => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");
  });

  test("a live lock holder blocks a second concurrent invocation", async () => {
    // Pre-seed a lock file with the current process's PID so the liveness
    // probe sees a running holder and the second invocation correctly
    // reports `locked` rather than taking over.
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    writeFileSync(lockPath(), `${process.pid} 1700000000000\n`);

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("locked");
    if (result.kind === "locked") {
      expect(result.holder).toContain(`${process.pid}`);
    }
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // The live holder's lock must NOT be removed by a contender.
    expect(existsSync(lockPath())).toBe(true);
  });

  test("a stale lock from a non-running PID is taken over and consolidation proceeds", async () => {
    // PID 999999 is well outside the typical kernel max_pid range on macOS
    // and Linux, so kill(pid, 0) reliably returns ESRCH. The takeover path
    // must unlink the stale file, retry the wx create, and bootstrap the
    // background conversation as if the lock had been free all along.
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    writeFileSync(lockPath(), "999999 1700000000000\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(runnerCalls).toBe(1);
    // Lock is released in the finally block after a successful run.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("an empty / corrupted lock file is treated as stale and taken over", async () => {
    // A zero-byte file simulates a prior holder that crashed between the
    // O_EXCL create and the PID write. With only one writer ever, an
    // unparseable payload is unambiguously corruption, not a live
    // mid-write — take it over.
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    writeFileSync(lockPath(), "");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(runnerCalls).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("CONSOLIDATION_PROMPT", () => {
  // Sanity tests on the prompt body — protect against accidental edits that
  // strip the cutoff sentinel or drop instructions for one of the four prose
  // files the consolidation pass owns.

  test("contains the {{CUTOFF}} placeholder in the unrendered template", () => {
    expect(CONSOLIDATION_PROMPT).toContain(CUTOFF_PLACEHOLDER);
  });

  test("references essentials, threads, recent, and buffer", () => {
    expect(CONSOLIDATION_PROMPT).toContain("memory/essentials.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/threads.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/recent.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/buffer.md");
  });
});
