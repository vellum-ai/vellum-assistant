import { describe, expect, test } from "bun:test";

import {
  reapAbandonedEvalContainers,
  reapContainersForRun,
} from "../adapters/docker-reaper";
import { ensureRunArtifacts, RUNS_DIR, writeRunMetadata } from "../metrics";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
  SpawnedProcess,
} from "../runtime/command-runner";

interface RunCall {
  command: string;
  args: string[];
}

/**
 * In-memory `CommandRunner` that returns canned `docker ps` output
 * and records every `docker rm -f` call. `spawn` is never exercised
 * by the reaper, so the stub throws if called — that surfaces shape
 * regressions immediately.
 */
class FakeRunner implements CommandRunner {
  readonly calls: RunCall[] = [];
  containers: string[] = [];
  dockerPsExitCode = 0;
  /** Container names that should fail `docker rm -f` (returns exit code 1). */
  rmFailures: Set<string> = new Set();
  /** When true, every `docker` invocation rejects (binary missing simulation). */
  dockerMissing = false;

  async run(
    command: string,
    args: string[],
    _opts?: RunOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (this.dockerMissing) {
      throw new Error("docker: command not found");
    }
    if (command !== "docker") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `unexpected command ${command}`,
      };
    }
    if (args[0] === "ps") {
      return {
        exitCode: this.dockerPsExitCode,
        stdout:
          this.containers.join("\n") + (this.containers.length ? "\n" : ""),
        stderr: "",
      };
    }
    if (args[0] === "rm" && args[1] === "-f") {
      const name = args[2]!;
      if (this.rmFailures.has(name)) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `No such container: ${name}`,
        };
      }
      return { exitCode: 0, stdout: name, stderr: "" };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `unhandled docker args ${args.join(" ")}`,
    };
  }

  spawn(): SpawnedProcess {
    throw new Error("spawn() unexpectedly called from reaper");
  }

  rmCalls(): string[] {
    return this.calls
      .filter((c) => c.command === "docker" && c.args[0] === "rm")
      .map((c) => c.args[2]!);
  }
}

/** Seed a `.runs/<runId>/run.json` with the given shape. */
async function seedRun(
  runId: string,
  metadata: {
    status: "running" | "completed" | "failed" | "abandoned";
    startedAt?: string;
    lastHeartbeatAt?: string;
  },
): Promise<void> {
  await ensureRunArtifacts(runId);
  await writeRunMetadata(runId, {
    runId,
    sessionId: "session-reaper-test",
    profileId: "p",
    testId: "t",
    status: metadata.status,
    startedAt: metadata.startedAt ?? "2026-05-22T13:00:00.000Z",
    lastHeartbeatAt: metadata.lastHeartbeatAt,
    artifactDir: `${RUNS_DIR}/${runId}`,
  });
}

/** Stable counter so concurrent tests don't collide on runId. */
let runIdCounter = 0;
function freshRunId(label: string): string {
  runIdCounter++;
  return `eval-reaper-${label}-${Date.now()}-${runIdCounter.toString(16).padStart(4, "0")}`;
}

describe("reapAbandonedEvalContainers", () => {
  test("reaps containers when their owning run is completed", async () => {
    const runId = freshRunId("completed");
    await seedRun(runId, { status: "completed" });
    const runner = new FakeRunner();
    runner.containers = [
      `${runId}-assistant`,
      `${runId}-gateway`,
      `${runId}-credential-executor`,
    ];

    const result = await reapAbandonedEvalContainers({ runner });

    expect(result.reaped.sort()).toEqual(
      [
        `${runId}-assistant`,
        `${runId}-credential-executor`,
        `${runId}-gateway`,
      ].sort(),
    );
    expect(result.preserved).toEqual([]);
    expect(result.unparseable).toEqual([]);
    expect(runner.rmCalls().sort()).toEqual(
      [
        `${runId}-assistant`,
        `${runId}-credential-executor`,
        `${runId}-gateway`,
      ].sort(),
    );
  });

  test("reaps containers when run.json is missing entirely", async () => {
    const runId = freshRunId("missing");
    // Deliberately don't seed — readRunMetadata will return undefined.
    const runner = new FakeRunner();
    runner.containers = [`${runId}-assistant`];

    const result = await reapAbandonedEvalContainers({ runner });

    expect(result.reaped).toEqual([`${runId}-assistant`]);
    expect(result.preserved).toEqual([]);
  });

  test("reaps a `running` run whose heartbeat is stale", async () => {
    const runId = freshRunId("stale-hb");
    await seedRun(runId, {
      status: "running",
      startedAt: "2026-05-22T13:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T13:00:00.000Z",
    });
    const runner = new FakeRunner();
    runner.containers = [`${runId}-assistant`];

    // Inject a "now" 5 minutes after the last heartbeat (>> 60s threshold).
    const result = await reapAbandonedEvalContainers({
      runner,
      now: () => new Date("2026-05-22T13:05:00.000Z"),
    });

    expect(result.reaped).toEqual([`${runId}-assistant`]);
    expect(result.preserved).toEqual([]);
  });

  test("preserves a `running` run with a fresh heartbeat", async () => {
    const runId = freshRunId("fresh-hb");
    await seedRun(runId, {
      status: "running",
      startedAt: "2026-05-22T14:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T14:00:50.000Z",
    });
    const runner = new FakeRunner();
    runner.containers = [`${runId}-assistant`, `${runId}-gateway`];

    // 30s after the last heartbeat — well under the 60s threshold.
    const result = await reapAbandonedEvalContainers({
      runner,
      now: () => new Date("2026-05-22T14:01:20.000Z"),
    });

    expect(result.reaped).toEqual([]);
    expect(result.preserved.sort()).toEqual(
      [`${runId}-assistant`, `${runId}-gateway`].sort(),
    );
    expect(runner.rmCalls()).toEqual([]);
  });

  test("respects a custom heartbeatTimeoutMs", async () => {
    const runId = freshRunId("custom-threshold");
    await seedRun(runId, {
      status: "running",
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:30.000Z",
    });
    const runner = new FakeRunner();
    runner.containers = [`${runId}-assistant`];

    // Default 60s would preserve — but a tighter 10s threshold reaps.
    const result = await reapAbandonedEvalContainers({
      runner,
      heartbeatTimeoutMs: 10_000,
      now: () => new Date("2026-05-22T15:00:45.000Z"),
    });

    expect(result.reaped).toEqual([`${runId}-assistant`]);
  });

  test("classifies eval-prefixed containers with unknown shape as unparseable, never reaps them", async () => {
    const runner = new FakeRunner();
    // Name doesn't end in a known service suffix — could belong to an
    // unrelated tool / a future shape we don't know about.
    runner.containers = ["eval-unrelated-blob", "eval-something-else"];

    const result = await reapAbandonedEvalContainers({ runner });

    expect(result.reaped).toEqual([]);
    expect(result.preserved).toEqual([]);
    expect(result.unparseable.sort()).toEqual(
      ["eval-something-else", "eval-unrelated-blob"].sort(),
    );
    expect(runner.rmCalls()).toEqual([]);
  });

  test("invokes `docker ps -a` with the `eval-` prefix filter", async () => {
    const runner = new FakeRunner();
    runner.containers = [];

    await reapAbandonedEvalContainers({ runner });

    const psCall = runner.calls.find(
      (c) => c.command === "docker" && c.args[0] === "ps",
    );
    expect(psCall).toBeDefined();
    expect(psCall!.args).toEqual([
      "ps",
      "-a",
      "--filter",
      "name=^eval-",
      "--format",
      "{{.Names}}",
    ]);
  });

  test("never throws when the docker binary is missing", async () => {
    const runner = new FakeRunner();
    runner.dockerMissing = true;

    const result = await reapAbandonedEvalContainers({ runner });

    expect(result).toEqual({ reaped: [], preserved: [], unparseable: [] });
  });

  test("never throws when `docker ps` exits non-zero", async () => {
    const runner = new FakeRunner();
    runner.dockerPsExitCode = 1;
    runner.containers = [];

    const result = await reapAbandonedEvalContainers({ runner });

    expect(result).toEqual({ reaped: [], preserved: [], unparseable: [] });
  });

  test("skips a failed `docker rm -f` without throwing — surfaces as not-reaped", async () => {
    const runId = freshRunId("rm-fails");
    await seedRun(runId, { status: "failed" });
    const runner = new FakeRunner();
    runner.containers = [`${runId}-assistant`];
    runner.rmFailures.add(`${runId}-assistant`);

    const result = await reapAbandonedEvalContainers({ runner });

    // Best-effort: a failed rm is silently dropped. Next sweep retries.
    expect(result.reaped).toEqual([]);
    expect(result.preserved).toEqual([]);
    expect(runner.rmCalls()).toEqual([`${runId}-assistant`]);
  });

  test("partitions a mix of live, stale, terminal, and missing runs in a single sweep", async () => {
    const liveRunId = freshRunId("mix-live");
    const staleRunId = freshRunId("mix-stale");
    const doneRunId = freshRunId("mix-done");
    const ghostRunId = freshRunId("mix-ghost");

    await seedRun(liveRunId, {
      status: "running",
      startedAt: "2026-05-22T16:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T16:00:50.000Z",
    });
    await seedRun(staleRunId, {
      status: "running",
      startedAt: "2026-05-22T15:00:00.000Z",
      lastHeartbeatAt: "2026-05-22T15:00:00.000Z",
    });
    await seedRun(doneRunId, { status: "completed" });
    // ghostRunId intentionally not seeded — no run.json at all.

    const runner = new FakeRunner();
    runner.containers = [
      `${liveRunId}-assistant`,
      `${liveRunId}-gateway`,
      `${staleRunId}-assistant`,
      `${doneRunId}-assistant`,
      `${ghostRunId}-credential-executor`,
      "eval-no-service-suffix",
    ];

    const result = await reapAbandonedEvalContainers({
      runner,
      now: () => new Date("2026-05-22T16:01:20.000Z"),
    });

    expect(result.preserved.sort()).toEqual(
      [`${liveRunId}-assistant`, `${liveRunId}-gateway`].sort(),
    );
    expect(result.reaped.sort()).toEqual(
      [
        `${doneRunId}-assistant`,
        `${ghostRunId}-credential-executor`,
        `${staleRunId}-assistant`,
      ].sort(),
    );
    expect(result.unparseable).toEqual(["eval-no-service-suffix"]);
  });
});

describe("reapContainersForRun", () => {
  test("force-removes every sibling container belonging to the runId", async () => {
    const runId = "eval-force-reap-test-abc";
    const runner = new FakeRunner();
    runner.containers = []; // unused by this path — direct docker rm -f

    const result = await reapContainersForRun(runner, runId);

    expect(result.reaped.sort()).toEqual(
      [
        `${runId}-assistant`,
        `${runId}-credential-executor`,
        `${runId}-gateway`,
      ].sort(),
    );
    expect(runner.rmCalls().sort()).toEqual(
      [
        `${runId}-assistant`,
        `${runId}-credential-executor`,
        `${runId}-gateway`,
      ].sort(),
    );
  });

  test("survives container-already-gone (per-sibling rm failures swallowed)", async () => {
    const runId = "eval-force-reap-half-gone";
    const runner = new FakeRunner();
    runner.rmFailures.add(`${runId}-gateway`);
    runner.rmFailures.add(`${runId}-credential-executor`);

    const result = await reapContainersForRun(runner, runId);

    // Only the assistant container was actually removed; the other two
    // were silently treated as already-gone.
    expect(result.reaped).toEqual([`${runId}-assistant`]);
  });

  test("refuses to operate on non-eval runIds (safety guardrail)", async () => {
    const runner = new FakeRunner();

    const result = await reapContainersForRun(runner, "not-an-eval-id");

    // No docker calls at all — refuse to be tricked into reaping
    // host-wide containers by a malformed id.
    expect(result.reaped).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});
