/**
 * Tests for `assistant/src/memory/v2/consolidation-job.ts`.
 *
 * Coverage matrix:
 *   - Flag off → no runner call; returns flag_off.
 *   - Flag on, empty buffer → no runner call; returns empty_buffer.
 *   - Flag on, non-empty buffer → runner invoked with the cutoff-templated
 *     prompt and `suppressFailureNotifications: true`; follow-up jobs
 *     enqueued on success.
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
  afterEach,
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

mock.module("../../jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
  ): string => {
    enqueuedJobs.push({ type, payload });
    nextJobIdCounter += 1;
    return `job-${nextJobIdCounter}`;
  },
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

const { _setOverridesForTesting } =
  await import("../../../config/assistant-feature-flags.js");
const { memoryV2ConsolidateJob } = await import("../consolidation-job.js");
const { CUTOFF_PLACEHOLDER, CONSOLIDATION_PROMPT } =
  await import("../prompts/consolidation.js");

// `isAssistantFeatureFlagEnabled` ignores the `config` argument it receives
// (resolution is purely from the overrides + registry caches), so we hand
// the handler a minimal stand-in instead of materializing the full default
// config.
const CONFIG = {} as Parameters<typeof memoryV2ConsolidateJob>[1];

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
});

afterEach(() => {
  _setOverridesForTesting({});
});

// ---------------------------------------------------------------------------

describe("memoryV2ConsolidateJob — flag off", () => {
  test("returns flag_off without invoking the runner when flag is off", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result).toEqual({ kind: "flag_off" });
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // Lock must NOT linger on the flag-off path — the handler bailed before
    // the lock was acquired.
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("memoryV2ConsolidateJob — flag on, empty buffer", () => {
  beforeEach(() => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
  });

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

describe("memoryV2ConsolidateJob — flag on, non-empty buffer", () => {
  beforeEach(() => {
    _setOverridesForTesting({ "memory-v2-enabled": true });
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
    expect(runnerLastArgs?.source).toBe("memory");
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
    // Cutoff is an ISO-8601 timestamp — check the year prefix matches the
    // current year so we know the substitution actually happened.
    expect(prompt).toContain(`${new Date().getFullYear()}`);
  });

  test("enqueues memory_v2_rebuild_edges and memory_v2_reembed follow-up jobs on success", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    if (result.kind === "invoked") {
      expect(result.followUpJobIds).toEqual(["job-1", "job-2"]);
    }

    expect(enqueuedJobs).toHaveLength(2);
    expect(enqueuedJobs[0]).toEqual({
      type: "memory_v2_rebuild_edges",
      payload: {},
    });
    expect(enqueuedJobs[1]).toEqual({
      type: "memory_v2_reembed",
      payload: {},
    });
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
    _setOverridesForTesting({ "memory-v2-enabled": true });
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");
  });

  test("a stale lock file blocks a second concurrent invocation", async () => {
    // Pre-seed a lock file as if a prior run was still in flight. The
    // simple wx-based lock has no liveness probe, so this also covers
    // stale-lock-on-disk behavior — operators clear stale locks manually.
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    writeFileSync(lockPath(), "9999 1700000000000\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("locked");
    if (result.kind === "locked") {
      expect(result.holder).toContain("9999");
    }
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // The pre-seeded lock must NOT be removed by a contender — only the
    // owner releases it.
    expect(existsSync(lockPath())).toBe(true);
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
