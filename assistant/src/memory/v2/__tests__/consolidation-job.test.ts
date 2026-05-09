/**
 * Tests for `assistant/src/memory/v2/consolidation-job.ts`.
 *
 * Coverage matrix:
 *   - v2 disabled in config → no provider/wake calls; returns disabled.
 *   - v2 on, empty buffer → no wake call; returns empty_buffer.
 *   - v2 on, non-empty buffer → bootstrap conversation, wake invoked with
 *     the cutoff-templated prompt, follow-up jobs enqueued.
 *   - Lock file already present → second call returns locked; first call's
 *     in-flight semantics preserved by leaving the lock in place.
 *   - Wake returns invoked: false → orphan conversation cleaned up; no
 *     follow-up jobs enqueued.
 *   - Wake throws → orphan conversation cleaned up; lock released; handler
 *     does NOT propagate the error (treated like any other wake failure).
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

// ── bootstrapConversation mock ──────────────────────────────────────
let bootstrapCalls = 0;
let bootstrapLastArgs: Record<string, unknown> | null = null;

mock.module("../../conversation-bootstrap.js", () => ({
  bootstrapConversation: (opts: Record<string, unknown>) => {
    bootstrapCalls += 1;
    bootstrapLastArgs = opts;
    return { id: `conv-${bootstrapCalls}` };
  },
}));

// ── deleteConversation mock (orphan cleanup path) ───────────────────
let deleteCalls = 0;
const deletedIds: string[] = [];
let deleteShouldThrow = false;

mock.module("../../conversation-crud.js", () => ({
  deleteConversation: (id: string) => {
    deleteCalls += 1;
    deletedIds.push(id);
    if (deleteShouldThrow) {
      throw new Error("simulated delete failure");
    }
    return { segmentIds: [], deletedSummaryIds: [] };
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

// ── wakeAgentForOpportunity mock ────────────────────────────────────
let wakeCalls = 0;
let wakeLastArgs: Record<string, unknown> | null = null;
let wakeShouldThrow = false;
let wakeInvoked = true;
let wakeReason: string | undefined;

mock.module("../../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async (opts: Record<string, unknown>) => {
    wakeCalls += 1;
    wakeLastArgs = opts;
    if (wakeShouldThrow) {
      throw new Error("simulated wake failure");
    }
    return {
      invoked: wakeInvoked,
      producedToolCalls: false,
      ...(wakeReason ? { reason: wakeReason } : {}),
    };
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

  bootstrapCalls = 0;
  bootstrapLastArgs = null;
  deleteCalls = 0;
  deletedIds.length = 0;
  deleteShouldThrow = false;
  enqueuedJobs.length = 0;
  nextJobIdCounter = 0;
  wakeCalls = 0;
  wakeLastArgs = null;
  wakeShouldThrow = false;
  wakeInvoked = true;
  wakeReason = undefined;
});

// ---------------------------------------------------------------------------

describe("memoryV2ConsolidateJob — v2 disabled", () => {
  test("returns disabled without invoking the wake when memory.v2.enabled is false", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG_DISABLED);

    expect(result).toEqual({ kind: "disabled" });
    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
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
    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("returns empty_buffer when buffer.md is whitespace-only", async () => {
    writeFileSync(bufferPath(), "   \n\n\t\n");

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result).toEqual({ kind: "empty_buffer" });
    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
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

  test("bootstraps a background conversation and wakes the assistant with a templated prompt", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(bootstrapCalls).toBe(1);
    expect(bootstrapLastArgs).toEqual({
      conversationType: "background",
      source: "memory_v2_consolidation",
      origin: "memory_consolidation",
      systemHint: "Running memory consolidation",
      groupId: "system:background",
    });

    expect(wakeCalls).toBe(1);
    expect(wakeLastArgs?.conversationId).toBe("conv-1");
    expect(wakeLastArgs?.source).toBe("memory_v2_consolidation");

    // The hint must contain the prompt body with the cutoff timestamp
    // substituted in. Asserting the placeholder is GONE catches a regression
    // where `replaceAll` is dropped and the model receives `{{CUTOFF}}`.
    const hint = wakeLastArgs?.hint as string;
    expect(hint).toContain("memory consolidation");
    expect(hint).not.toContain(CUTOFF_PLACEHOLDER);
    // Cutoff is a buffer-entry-format timestamp (`Mon D, h:mm AM/PM`) so it
    // compares like-with-like against `buffer.md` lines at minute precision.
    expect(hint).toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)\b/);
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
    const hint = wakeLastArgs?.hint as string;
    expect(hint).toMatch(
      /^CUSTOM CONSOLIDATION at [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/m,
    );
    expect(hint).not.toContain("You are running memory consolidation");
    expect(hint).not.toContain(CUTOFF_PLACEHOLDER);
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

  test("releases the lock after a successful invocation so the next run can acquire it", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(result.kind).toBe("invoked");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("returns wake_failed and cleans up the orphan conversation when wake returns invoked: false", async () => {
    wakeInvoked = false;
    wakeReason = "no_resolver";

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("wake_failed");
    if (result.kind === "wake_failed") {
      expect(result.reason).toBe("no_resolver");
    }
    expect(deleteCalls).toBe(1);
    expect(deletedIds).toEqual(["conv-1"]);
    // Critical: do NOT enqueue follow-ups when the wake didn't run — there's
    // nothing for them to operate on.
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("returns wake_failed without throwing when wake itself rejects", async () => {
    wakeShouldThrow = true;

    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("wake_failed");
    if (result.kind === "wake_failed") {
      expect(result.reason).toBe("simulated wake failure");
    }
    // Lock must still be released on the throw path.
    expect(existsSync(lockPath())).toBe(false);
    expect(deleteCalls).toBe(1);
    expect(enqueuedJobs).toHaveLength(0);
  });

  test("does not propagate when deleteConversation throws on the cleanup path", async () => {
    wakeInvoked = false;
    deleteShouldThrow = true;

    await expect(
      memoryV2ConsolidateJob(makeJob(), CONFIG),
    ).resolves.toMatchObject({ kind: "wake_failed" });

    expect(deleteCalls).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
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
    expect(bootstrapCalls).toBe(0);
    expect(wakeCalls).toBe(0);
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
    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
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
    expect(bootstrapCalls).toBe(1);
    expect(wakeCalls).toBe(1);
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
