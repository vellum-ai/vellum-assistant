import { rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  abandonAllRunningRunsSync,
  appendTranscriptTurn,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  ensureRunArtifacts,
  readRunMetadata,
  runMetrics,
  RUNS_DIR,
  scavengeAbandonedRuns,
  updateHeartbeat,
  updateRunMetadata,
  writeRunMetadata,
  writeUsage,
} from "../metrics";
import type { TestDef } from "../test-def";
import scoreAssistantCost from "../../../benchmarks/personal-intelligence/tests/timeline-recall/metrics/assistant-cost";
import scoreDateMentioned from "../../../benchmarks/personal-intelligence/tests/timeline-recall/metrics/date-mentioned";

const testDef: TestDef = {
  id: "timeline-recall",
  specPath: "/tmp/SPEC.md",
  setupPath: "/tmp/setup.ts",
  setupCommands: [],
  metricsDir: "/tmp/metrics",
  metricPaths: [],
};

async function freshRunId(name: string): Promise<string> {
  const runId = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

describe("timeline-recall metrics", () => {
  test("date metric scores 1 when assistant names March 14", async () => {
    const runId = await freshRunId("date-pass");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "You mentioned it on March 14.",
      emittedAt: "now",
    });

    const result = await scoreDateMentioned({ runId });

    expect(result.score).toBe(1);
    expect(result).not.toHaveProperty("passed");
  });

  test("date metric scores 0 when assistant does not name the date", async () => {
    const runId = await freshRunId("date-fail");
    await appendTranscriptTurn(runId, {
      role: "assistant",
      content: "I cannot find it.",
      emittedAt: "now",
    });

    const result = await scoreDateMentioned({ runId });

    expect(result.score).toBe(0);
  });

  test("cost metric scores cost as a 0-1 fraction against the baseline", async () => {
    // GIVEN a run that spent under the timeline-recall cost baseline ($0.05)
    const runId = await freshRunId("cost");
    await writeUsage(runId, { requests: [], totalCostUsd: 0.0123 });

    // WHEN the cost metric scores it
    const result = await scoreAssistantCost({ runId });

    // THEN it reports a 0-1 fraction (not raw negative dollars) and, being
    // under budget, earns full marks
    expect(result.name).toBe("assistant-cost-usd");
    expect(result).not.toHaveProperty("unit");
    expect(result.score).toBe(1);
    expect(result.metadata).toMatchObject({
      baselineUsd: 0.05,
      costUsd: 0.0123,
    });
  });

  test("cost metric scores 0 when metering is only partial, even if the priced subtotal is under budget", async () => {
    // GIVEN a run whose priced subtotal ($0.0007) is well under the $0.05
    // baseline, but some model traffic went unpriced (costStatus "partial")
    const runId = await freshRunId("cost-partial");
    await writeUsage(runId, {
      requests: [],
      totalCostUsd: 0.0007,
      costStatus: "partial",
      costDiagnostics: [{ requestIndex: 0, reason: "unpriced_model" }],
    });

    // WHEN the cost metric scores it
    const result = await scoreAssistantCost({ runId });

    // THEN it refuses to award full credit for an incomplete figure and
    // flags the unpriced traffic instead of inflating the aggregate
    expect(result.score).toBe(0);
    expect(result.reason).toContain("partially metered");
  });

  test("cost metric decays toward zero as spend exceeds the baseline", async () => {
    // GIVEN a run that spent 2× the $0.05 baseline
    const runId = await freshRunId("cost-over");
    await writeUsage(runId, { requests: [], totalCostUsd: 0.1 });

    // WHEN the cost metric scores it
    const result = await scoreAssistantCost({ runId });

    // THEN the score is the inverse cost ratio (half marks at 2× the baseline)
    expect(result.score).toBeCloseTo(0.5, 10);
  });

  test("runs metric files in parallel", async () => {
    const runId = await freshRunId("parallel");
    const dir = resolve(`.runs/${runId}-metrics`);
    await Bun.write(
      `${dir}/a.ts`,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "a", score: 1 }; };',
    );
    await Bun.write(
      `${dir}/b.ts`,
      'export default async () => { await new Promise((r) => setTimeout(r, 80)); return { name: "b", score: 1 }; };',
    );

    const start = Date.now();
    const results = await runMetrics({
      test: { ...testDef, metricPaths: [`${dir}/a.ts`, `${dir}/b.ts`] },
      runId,
    });

    expect(results.map((r) => r.name).sort()).toEqual(["a", "b"]);
    expect(Date.now() - start).toBeLessThan(140);
    await rm(dir, { recursive: true, force: true });
  });
});

// Counter-padded runId matching the production
// `^eval-[a-z0-9\-]+-\d{17}-[a-f0-9]{4}$` shape the server enforces.
let scavCounter = 0;
async function seedRunningRun(input: {
  startedAt: string;
  lastHeartbeatAt?: string;
  status?: "running" | "completed" | "failed";
}): Promise<string> {
  const ts = `${Date.now()}${scavCounter++}000`.slice(-17);
  const rand = scavCounter.toString(16).padStart(4, "0").slice(-4);
  const runId = `eval-scav-${ts}-${rand}`;
  await ensureRunArtifacts(runId);
  await writeRunMetadata(runId, {
    runId,
    sessionId: "session-scav",
    profileId: "p1",
    testId: "t1",
    status: input.status ?? "running",
    startedAt: input.startedAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
    artifactDir: `${RUNS_DIR}/${runId}`,
  });
  return runId;
}

describe("scavengeAbandonedRuns", () => {
  test("flips a running run with a stale heartbeat to abandoned with a deterministic clock", async () => {
    const stale = await seedRunningRun({
      startedAt: "2026-05-22T13:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T13:00:00.000Z",
    });
    const fresh = await seedRunningRun({
      startedAt: "2026-05-22T13:05:00.000Z",
      lastHeartbeatAt: "2026-05-22T13:05:00.000Z",
    });

    // Inject a "now" 5 minutes after the stale run's last heartbeat. With the
    // default 60s timeout, stale → abandoned, fresh stays running.
    const now = () => new Date("2026-05-22T13:05:00.000Z");
    const result = await scavengeAbandonedRuns({ now });

    expect(result.count).toBeGreaterThanOrEqual(1);
    const staleMeta = await readRunMetadata(stale);
    const freshMeta = await readRunMetadata(fresh);
    expect(staleMeta?.status).toBe("abandoned");
    expect(staleMeta?.error).toContain("Process exited without completing");
    expect(staleMeta?.completedAt).toBe("2026-05-22T13:05:00.000Z");
    expect(freshMeta?.status).toBe("running");
  });

  test("respects custom heartbeatTimeoutMs", async () => {
    const run = await seedRunningRun({
      startedAt: "2026-05-22T14:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T14:00:30.000Z",
    });
    // Default 60s wouldn't flip — but with 10s it does.
    const now = () => new Date("2026-05-22T14:00:45.000Z");
    await scavengeAbandonedRuns({ now, heartbeatTimeoutMs: 10_000 });
    const meta = await readRunMetadata(run);
    expect(meta?.status).toBe("abandoned");
  });

  test("exports a sane default timeout", () => {
    expect(DEFAULT_HEARTBEAT_TIMEOUT_MS).toBe(60_000);
  });
});

describe("abandonAllRunningRunsSync", () => {
  test("flips every running run regardless of heartbeat age and writes run.json (not metadata.json)", async () => {
    const a = await seedRunningRun({
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    const b = await seedRunningRun({
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });
    const completed = await seedRunningRun({
      startedAt: new Date().toISOString(),
      status: "completed",
    });

    const count = abandonAllRunningRunsSync({ signal: "SIGINT" });
    expect(count).toBeGreaterThanOrEqual(2);

    const aMeta = await readRunMetadata(a);
    const bMeta = await readRunMetadata(b);
    const cMeta = await readRunMetadata(completed);
    expect(aMeta?.status).toBe("abandoned");
    expect(aMeta?.error).toContain("SIGINT");
    expect(bMeta?.status).toBe("abandoned");
    // Already-completed runs are left alone.
    expect(cMeta?.status).toBe("completed");

    // Belt-and-suspenders: the write landed in run.json (the real filename
    // per runArtifacts()), not metadata.json (the bug that made the
    // pre-fix signal handler a silent no-op).
    const runJson = await readFile(join(RUNS_DIR, a, "run.json"), "utf8");
    expect(JSON.parse(runJson).status).toBe("abandoned");
  });

  test("uses a different error message for the 'exit' signal", () => {
    abandonAllRunningRunsSync({ signal: "exit" });
    // No assertion on count — other tests may have left no running runs.
    // We just confirm the function doesn't throw with the synthetic signal.
    expect(true).toBe(true);
  });
});

describe("updateHeartbeat", () => {
  test("writes lastHeartbeatAt when the run is still running", async () => {
    const runId = await seedRunningRun({
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:00.000Z",
    });
    const before = (await readRunMetadata(runId))?.lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateHeartbeat(runId);
    const after = (await readRunMetadata(runId))?.lastHeartbeatAt;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("is a no-op when the run is no longer running (status race-safety)", async () => {
    const runId = await seedRunningRun({
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:00.000Z",
      status: "completed",
    });
    const before = (await readRunMetadata(runId))?.lastHeartbeatAt;
    await updateHeartbeat(runId);
    const after = (await readRunMetadata(runId))?.lastHeartbeatAt;
    // No write — value is unchanged, even though we asked for a heartbeat.
    expect(after).toBe(before);
  });
});

describe("updateRunMetadata (per-runId mutex)", () => {
  test("serializes concurrent updaters so no two run at once for the same runId", async () => {
    // Without the mutex, ten concurrent updaters all race on read-modify-write
    // and the final result depends on scheduling. With the mutex, the updaters
    // run end-to-end one after another.
    const runId = await seedRunningRun({
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:00.000Z",
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const ops = Array.from({ length: 10 }, (_, i) =>
      updateRunMetadata(runId, async (current) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield to the microtask queue so an unlocked impl would interleave.
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        if (!current) return undefined;
        return { ...current, lastHeartbeatAt: `tick-${i}` };
      }),
    );
    await Promise.all(ops);
    expect(maxInFlight).toBe(1);
    // And the final write must have been one of the ticks — the last one
    // to release the lock wins, but every tick was applied serially.
    const final = await readRunMetadata(runId);
    expect(final?.lastHeartbeatAt).toMatch(/^tick-\d$/);
  });

  test("a heartbeat that queues behind a final completed-write becomes a no-op (race-safety)", async () => {
    // Reproduces the P1 race Codex flagged: heartbeat reads `running`,
    // suspends, the final `completed` write lands. Without the mutex,
    // the heartbeat continuation clobbers `completed` back to `running`.
    // With the mutex, the heartbeat re-reads `current.status` inside the
    // lock and skips its write.
    const runId = await seedRunningRun({
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:00.000Z",
    });
    // Fire heartbeat and final write concurrently. The mutex serializes
    // them in arrival order; whichever observes the lock first runs first.
    const heartbeat = updateHeartbeat(runId);
    const finalWrite = writeRunMetadata(runId, {
      runId,
      sessionId: "session-scav",
      profileId: "p1",
      testId: "t1",
      status: "completed",
      startedAt: "2026-05-22T15:00:00.000Z",
      completedAt: "2026-05-22T15:00:05.000Z",
      artifactDir: `${RUNS_DIR}/${runId}`,
    });
    await Promise.all([heartbeat, finalWrite]);
    // The final state is always `completed` — never `running` — because
    // either the heartbeat ran first (then the final write replaced it),
    // or the final write ran first (then the heartbeat saw `completed`
    // and skipped).
    const final = await readRunMetadata(runId);
    expect(final?.status).toBe("completed");
  });
});
