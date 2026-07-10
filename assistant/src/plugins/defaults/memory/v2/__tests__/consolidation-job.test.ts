/**
 * Tests for `assistant/src/memory/v2/consolidation-job.ts`.
 *
 * Coverage matrix:
 *   - Flag off → no runner call; returns disabled.
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
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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

mock.module("../../../../../runtime/background-job-runner.js", () => ({
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

mock.module("../../../../../notifications/emit-signal.js", () => ({
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

mock.module("../../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
  ): string => {
    enqueuedJobs.push({ type, payload });
    nextJobIdCounter += 1;
    return `job-${nextJobIdCounter}`;
  },
  isMemoryEnabled: () => true,
}));

// ── v3 live gate mock ───────────────────────────────────────────────
//
// `memory.v3.live` being on appends `memory_v3_maintain` to the
// post-consolidation follow-up fan-out, selects the v3 article-shape prompt,
// and includes the core-pages curation section. `v3FlagOn` toggles the gate
// for the existing on/off tests; `flagStates["memory-v3-live"]` overrides it
// for the article-shape tests.
let v3FlagOn = false;
let flagStates: Record<string, boolean> = {};
mock.module("../../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => flagStates[key] ?? v3FlagOn,
}));

// The v3-live gate lives in config (`config.memory.v3.live`), read via
// `isMemoryV3Live`; drive it through `flagStates["memory-v3-live"]` (and
// `v3FlagOn` for the existing on/off tests).
mock.module("../../../../../config/memory-v3-gate.js", () => ({
  isMemoryV3Live: () => flagStates["memory-v3-live"] ?? v3FlagOn,
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

// The handler only reads `config.memory.enabled`, `config.memory.v2.enabled`,
// `config.memory.v2.consolidation_prompt_path`, and
// `config.memory.v2.consolidation_max_entries_per_run`, so a minimal
// stand-in covers those call sites without materializing the full default
// config.
const CONFIG = {
  memory: {
    enabled: true,
    v2: { enabled: true, consolidation_prompt_path: null },
  },
} as Parameters<typeof memoryV2ConsolidateJob>[1];

/** CONFIG plus a per-run entry cap for the chunked-cutoff tests. */
function configWithMaxEntries(
  maxEntries: number | null,
): Parameters<typeof memoryV2ConsolidateJob>[1] {
  return {
    memory: {
      enabled: true,
      v2: {
        enabled: true,
        consolidation_prompt_path: null,
        consolidation_max_entries_per_run: maxEntries,
      },
    },
  } as Parameters<typeof memoryV2ConsolidateJob>[1];
}
const CONFIG_DISABLED = {
  memory: {
    enabled: true,
    v2: { enabled: false, consolidation_prompt_path: null },
  },
} as Parameters<typeof memoryV2ConsolidateJob>[1];
const CONFIG_MEMORY_DISABLED = {
  memory: {
    enabled: false,
    v2: { enabled: true, consolidation_prompt_path: null },
  },
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

  // v3 follow-up flag default: off.
  v3FlagOn = false;
  flagStates = {};
});

// ---------------------------------------------------------------------------

describe("memoryV2ConsolidateJob — chunked cutoff (consolidation_max_entries_per_run)", () => {
  const FIVE_ENTRIES = [
    "- [Apr 27, 9:00 AM] Alice prefers VS Code.",
    "- [Apr 27, 9:01 AM] Bob takes his coffee black.",
    "- [Apr 27, 9:02 AM] Carol loves jazz.",
    "- [Apr 27, 9:03 AM] Dave runs marathons.",
    "- [Apr 27, 9:04 AM] Erin paints watercolors.",
  ].join("\n");

  test("buffer over the cap → cutoff is the first over-cap entry's timestamp; overflow deferred", async () => {
    writeFileSync(bufferPath(), FIVE_ENTRIES + "\n");

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(3),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.cutoff).toBe("Apr 27, 9:03 AM");
    expect(outcome.deferredEntries).toBe(2);
    expect(runnerCalls).toBe(1);
    expect(runnerLastArgs!.prompt as string).toContain("Apr 27, 9:03 AM");
  });

  test("buffer at or under the cap → full-buffer cutoff, nothing deferred", async () => {
    writeFileSync(bufferPath(), FIVE_ENTRIES + "\n");

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(5),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.deferredEntries).toBe(0);
    // Cutoff is the run-start timestamp, not any buffer entry's.
    expect(outcome.cutoff).not.toBe("Apr 27, 9:03 AM");
  });

  test("null cap → full buffer processed regardless of size", async () => {
    writeFileSync(bufferPath(), FIVE_ENTRIES + "\n");

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(null),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.deferredEntries).toBe(0);
  });

  test("cap absent from config (hand-crafted stand-in) → full buffer processed", async () => {
    writeFileSync(bufferPath(), FIVE_ENTRIES + "\n");

    const outcome = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.deferredEntries).toBe(0);
  });

  test("same-minute burst (every entry shares the over-cap timestamp) → full-buffer cutoff, no wedge", () => {
    // A sweep that wrote >cap entries within one minute: a pulled-back
    // cutoff would defer ALL of them ("timestamp >= cutoff stays") and the
    // size trigger would requeue an identical no-op run forever.
    writeFileSync(
      bufferPath(),
      [
        "- [Apr 27, 9:00 AM] Alice prefers VS Code.",
        "- [Apr 27, 9:00 AM] Bob takes his coffee black.",
        "- [Apr 27, 9:00 AM] Carol loves jazz.",
        "- [Apr 27, 9:00 AM] Dave runs marathons.",
      ].join("\n") + "\n",
    );

    return memoryV2ConsolidateJob(makeJob(), configWithMaxEntries(2)).then(
      (outcome) => {
        expect(outcome.kind).toBe("invoked");
        if (outcome.kind !== "invoked") throw new Error("unreachable");
        expect(outcome.deferredEntries).toBe(0);
        expect(outcome.cutoff).not.toBe("Apr 27, 9:00 AM");
      },
    );
  });

  test("continuation lines (multi-line entries) don't count as entries or break the cutoff", async () => {
    // The second entry carries embedded newlines: its continuation lines
    // belong to that entry, so the buffer holds 3 entries, not 5 lines.
    // With a cap of 2, the cutoff is the THIRD entry's timestamp.
    writeFileSync(
      bufferPath(),
      [
        "- [Apr 27, 9:00 AM] Alice prefers VS Code.",
        "- [Apr 27, 9:01 AM] Bob shared a snippet:",
        "  line two of Bob's multi-line memory",
        "  line three of Bob's multi-line memory",
        "- [Apr 27, 9:03 AM] Dave runs marathons.",
      ].join("\n") + "\n",
    );

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(2),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.cutoff).toBe("Apr 27, 9:03 AM");
    expect(outcome.deferredEntries).toBe(1);
  });

  test("bracketed continuation lines (checklists, wikilinks) are not counted as entries", async () => {
    // Continuation lines that START with "- [" but don't carry the
    // formatBufferTimestamp shape must not count toward the cap or become
    // the cutoff — "- [ ] task" would otherwise yield a blank-string cutoff.
    writeFileSync(
      bufferPath(),
      [
        "- [Apr 27, 9:00 AM] Alice's project plan:",
        "- [ ] follow up with Bob",
        "- [[meeting-notes]] referenced doc",
        "- [Apr 27, 9:01 AM] Carol loves jazz.",
      ].join("\n") + "\n",
    );

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(2),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    // Two real entries, cap 2 → no chunking, full-buffer cutoff.
    expect(outcome.deferredEntries).toBe(0);
    expect(outcome.cutoff).not.toBe(" ");
    expect(outcome.cutoff).not.toBe("[meeting-notes]");
  });

  test("multi-line entries under the cap → full-buffer cutoff even when raw line count exceeds it", async () => {
    writeFileSync(
      bufferPath(),
      [
        "- [Apr 27, 9:00 AM] Alice shared a snippet:",
        "  continuation one",
        "  continuation two",
        "- [Apr 27, 9:01 AM] Bob takes his coffee black.",
      ].join("\n") + "\n",
    );

    const outcome = await memoryV2ConsolidateJob(
      makeJob(),
      configWithMaxEntries(2),
    );

    expect(outcome.kind).toBe("invoked");
    if (outcome.kind !== "invoked") throw new Error("unreachable");
    expect(outcome.deferredEntries).toBe(0);
    expect(outcome.cutoff).not.toBe("Apr 27, 9:01 AM");
  });
});

describe("memoryV2ConsolidateJob — v2 disabled", () => {
  test("returns disabled without invoking the runner when memory.enabled is false", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");

    const result = await memoryV2ConsolidateJob(
      makeJob(),
      CONFIG_MEMORY_DISABLED,
    );

    expect(result).toEqual({ kind: "disabled" });
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // Lock must NOT linger on the disabled path — the handler bailed before
    // the lock was acquired.
    expect(existsSync(lockPath())).toBe(false);
  });

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
    expect(runnerLastArgs?.callSite).toBe("memoryV2Consolidation");
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

  test("wire-scopes the run to local memory-file tools — no network egress or host tools", async () => {
    // Security: the consolidation run is guardian-trust + non-interactive, so
    // the permission checker auto-approves any tool within the background
    // threshold (a public web_fetch classifies Low). The run must therefore be
    // handed an explicit allowlist that excludes every egress/host tool, so
    // prompt injection embedded in buffer/page content cannot exfiltrate
    // memory over an auto-approved channel. Wire gate mode (the default) means
    // the excluded tools are never even presented to the model.
    await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(runnerCalls).toBe(1);
    const allowed = runnerLastArgs?.allowedTools as string[] | undefined;
    expect(allowed).toBeDefined();
    const allowedSet = new Set(allowed);

    // The local file-reorganization surface the pass actually uses.
    for (const tool of [
      "file_read",
      "file_write",
      "file_edit",
      "file_list",
      "code_search",
      "bash",
      "recall",
    ]) {
      expect(allowedSet.has(tool)).toBe(true);
    }

    // Network egress + host-proxy tools must NOT be reachable.
    for (const tool of [
      "web_fetch",
      "web_search",
      "network_request",
      "host_bash",
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_cu",
    ]) {
      expect(allowedSet.has(tool)).toBe(false);
    }
    // Belt-and-suspenders: nothing host-prefixed slipped in.
    expect((allowed ?? []).some((t) => t.startsWith("host_"))).toBe(false);
    // Gate mode is left at the default ("wire") so excluded tools are filtered
    // off the wire, not merely rejected at execution time.
    expect(runnerLastArgs?.toolGateMode).toBeUndefined();
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

  test("releases the lock after a successful invocation so the next run can acquire it", async () => {
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(result.kind).toBe("invoked");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("enqueues memory_v3_maintain as a follow-up when a v3 flag is on", async () => {
    v3FlagOn = true;
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(enqueuedJobs.map((j) => j.type)).toEqual([
      "memory_v2_reembed",
      "memory_v3_maintain",
    ]);
  });

  test("does not enqueue memory_v3_maintain when v3 flags are off", async () => {
    v3FlagOn = false;
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(result.kind).toBe("invoked");
    expect(enqueuedJobs.map((j) => j.type)).toEqual(["memory_v2_reembed"]);
  });

  test("includes the core-pages curation section in the prompt only when a v3 flag is on", async () => {
    // v2-only installs must not be instructed to curate memory/core-pages.md
    // — the file feeds the v3 core lane and is inert without it.
    v3FlagOn = false;
    await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(runnerLastArgs?.prompt as string).not.toContain("core-pages");

    v3FlagOn = true;
    await memoryV2ConsolidateJob(makeJob(), CONFIG);
    expect(runnerLastArgs?.prompt as string).toContain(
      "## 10. Review `memory/core-pages.md`",
    );
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
    // GIVEN a lock seeded with the current process's PID and a fresh
    // timestamp, so the liveness probe sees a running holder AND the lock is
    // well within the staleness TTL (i.e. a genuinely in-flight run).
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    writeFileSync(lockPath(), `${process.pid} ${Date.now()}\n`);

    // WHEN a second invocation tries to acquire the lock
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    // THEN it reports `locked` rather than taking over
    expect(result.kind).toBe("locked");
    if (result.kind === "locked") {
      expect(result.holder).toContain(`${process.pid}`);
    }
    expect(runnerCalls).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
    // AND the live holder's lock must NOT be removed by a contender.
    expect(existsSync(lockPath())).toBe(true);
  });

  test("a lock from a live PID but older than the TTL is taken over (container PID-1 collision)", async () => {
    // GIVEN a lock held by a live PID (the current process stands in for the
    // container's PID-1 daemon, which always probes as alive) whose timestamp
    // is far older than the staleness TTL. This is the wedge from the
    // incident: a restarted daemon reuses the dead holder's PID, so the
    // liveness probe alone could never reclaim the abandoned lock.
    mkdirSync(join(memoryDir(), ".v2-state"), { recursive: true });
    const ancient = Date.now() - 365 * 24 * 60 * 60 * 1000;
    writeFileSync(lockPath(), `${process.pid} ${ancient}\n`);

    // WHEN consolidation runs
    const result = await memoryV2ConsolidateJob(makeJob(), CONFIG);

    // THEN the expired lock is taken over and consolidation proceeds
    expect(result.kind).toBe("invoked");
    expect(runnerCalls).toBe(1);
    // AND the lock is released in the finally block after a successful run.
    expect(existsSync(lockPath())).toBe(false);
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

describe("article-shape selection — keyed on the live gate", () => {
  // The v3 article shape drops the `summary:` field that v2 injection
  // depends on, so only a live (`memory.v3.live`) install may select the v3
  // template — a v2-only install must keep producing `summary:`-bearing pages.
  const V3_MARKER = "The lead IS the card";

  test("v3 off → v2 article shape", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");
    flagStates = { "memory-v3-live": false };

    await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(runnerCalls).toBe(1);
    const prompt = runnerLastArgs?.prompt as string;
    expect(prompt).not.toContain(V3_MARKER);
    expect(prompt).toContain("The `summary` field is required");
    // §10 (core-pages curation) is omitted on a v2-only install.
    expect(prompt).not.toContain("memory/core-pages.md");
  });

  test("live on → v3 article shape", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");
    flagStates = { "memory-v3-live": true };

    await memoryV2ConsolidateJob(makeJob(), CONFIG);

    expect(runnerCalls).toBe(1);
    const prompt = runnerLastArgs?.prompt as string;
    expect(prompt).toContain(V3_MARKER);
    expect(prompt).not.toContain("The `summary` field is required");
    expect(prompt).toContain("memory/core-pages.md");
  });
});
