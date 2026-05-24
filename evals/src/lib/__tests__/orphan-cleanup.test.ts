import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupOrphanedEvalContainers,
  EVAL_CONTAINER_SUFFIXES,
  EVAL_NETWORK_SUFFIX,
  EVAL_VOLUME_SUFFIXES,
  inferRunIdFromContainerName,
  removeOrphanedRunResources,
  shouldRemoveOrphan,
} from "../orphan-cleanup";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
  SpawnedProcess,
} from "../runtime/command-runner";
import type { RunMetadata } from "../metrics";

/**
 * Minimal stub runner used by the orphan-cleanup tests. Records every
 * `runner.run` invocation so the tests can assert exact docker calls,
 * and returns scripted exit codes / stdout via the constructor.
 *
 * `spawn` isn't used by orphan-cleanup, so it throws to fail loudly
 * if a future refactor accidentally calls it.
 */
class ScriptedRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: string[];
    opts?: RunOptions;
  }> = [];
  private readonly script: (
    command: string,
    args: string[],
  ) => Promise<CommandResult>;

  constructor(
    script: (command: string, args: string[]) => Promise<CommandResult>,
  ) {
    this.script = script;
  }

  async run(
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, opts });
    return this.script(command, args);
  }

  spawn(): SpawnedProcess {
    throw new Error("orphan-cleanup should never call spawn()");
  }
}

describe("EVAL_CONTAINER_SUFFIXES order", () => {
  test("longest suffixes come first so '-assistant-egress-jail' wins over '-assistant'", () => {
    // If `-assistant` came before `-assistant-egress-jail`, the egress
    // jail container would be misclassified as the main assistant
    // container with a `-egress-jail`-suffixed runId — which then
    // fails the trailing-timestamp test and gets ignored entirely,
    // leaving the jail running indefinitely.
    const assistantIdx = EVAL_CONTAINER_SUFFIXES.indexOf("-assistant");
    const jailIdx = EVAL_CONTAINER_SUFFIXES.indexOf("-assistant-egress-jail");
    expect(jailIdx).toBeLessThan(assistantIdx);
    const hermesIdx = EVAL_CONTAINER_SUFFIXES.indexOf("-hermes");
    const hermesJailIdx = EVAL_CONTAINER_SUFFIXES.indexOf(
      "-hermes-egress-jail",
    );
    expect(hermesJailIdx).toBeLessThan(hermesIdx);
  });

  test("includes the gateway + credential-executor containers vellum hatch creates", () => {
    // The original PR #31918 sweep missed these two, leaving the
    // gateway container's host port 20100 reservation alive and
    // causing the next run to fail with `port is already allocated`.
    expect(EVAL_CONTAINER_SUFFIXES).toContain("-gateway");
    expect(EVAL_CONTAINER_SUFFIXES).toContain("-credential-executor");
  });
});

describe("inferRunIdFromContainerName", () => {
  test.each([
    [
      "eval-vellum-bare-timeline-recall-20260520135745-assistant",
      "eval-vellum-bare-timeline-recall-20260520135745",
    ],
    [
      "eval-vellum-bare-timeline-recall-20260520135745-assistant-egress-jail",
      "eval-vellum-bare-timeline-recall-20260520135745",
    ],
    [
      "eval-vellum-bare-timeline-recall-20260520135745-gateway",
      "eval-vellum-bare-timeline-recall-20260520135745",
    ],
    [
      "eval-vellum-bare-timeline-recall-20260520135745-credential-executor",
      "eval-vellum-bare-timeline-recall-20260520135745",
    ],
    [
      "eval-hermes-bare-timeline-recall-20260520135745-hermes",
      "eval-hermes-bare-timeline-recall-20260520135745",
    ],
    [
      "eval-hermes-bare-timeline-recall-20260520135745-hermes-egress-jail",
      "eval-hermes-bare-timeline-recall-20260520135745",
    ],
  ])("%s → %s", (name, expected) => {
    expect(inferRunIdFromContainerName(name)).toBe(expected);
  });

  test.each([
    // Non-eval containers — shouldn't match any of our suffixes.
    ["my-app-container", undefined],
    ["postgres", undefined],
    // Eval-like but missing the timestamp slot.
    ["eval-vellum-bare-foo-assistant", undefined],
    // Eval-like but with wrong-length timestamp.
    ["eval-vellum-bare-foo-1234-assistant", undefined],
    // Empty.
    ["", undefined],
  ])("rejects unrelated names: %s", (name, expected) => {
    expect(inferRunIdFromContainerName(name)).toBe(expected);
  });
});

describe("shouldRemoveOrphan", () => {
  const NOW_MS = new Date("2026-05-23T14:42:05Z").getTime();
  const FRESH_MS = 60_000;

  test("removes when run.json is missing on disk", () => {
    expect(
      shouldRemoveOrphan({
        metadata: undefined,
        nowMs: NOW_MS,
        freshHeartbeatMs: FRESH_MS,
      }),
    ).toBe(true);
  });

  test.each(["completed", "failed", "abandoned", "unknown"] as const)(
    "removes when status is terminal (%s)",
    (status) => {
      const metadata: RunMetadata = {
        runId: "eval-x-y-12345678901234",
        profileId: "x",
        testId: "y",
        status,
        artifactDir: ".runs/eval-x-y-12345678901234",
      };
      expect(
        shouldRemoveOrphan({
          metadata,
          nowMs: NOW_MS,
          freshHeartbeatMs: FRESH_MS,
        }),
      ).toBe(true);
    },
  );

  test("removes a 'running' run with a stale heartbeat", () => {
    const stale = new Date(NOW_MS - 120_000).toISOString();
    const metadata: RunMetadata = {
      runId: "eval-x-y-12345678901234",
      profileId: "x",
      testId: "y",
      status: "running",
      lastHeartbeatAt: stale,
      artifactDir: ".runs/eval-x-y-12345678901234",
    };
    expect(
      shouldRemoveOrphan({
        metadata,
        nowMs: NOW_MS,
        freshHeartbeatMs: FRESH_MS,
      }),
    ).toBe(true);
  });

  test("removes a 'running' run with no heartbeat at all", () => {
    const metadata: RunMetadata = {
      runId: "eval-x-y-12345678901234",
      profileId: "x",
      testId: "y",
      status: "running",
      artifactDir: ".runs/eval-x-y-12345678901234",
    };
    expect(
      shouldRemoveOrphan({
        metadata,
        nowMs: NOW_MS,
        freshHeartbeatMs: FRESH_MS,
      }),
    ).toBe(true);
  });

  test("keeps a 'running' run with a fresh heartbeat — never steal from a parallel run", () => {
    const fresh = new Date(NOW_MS - 5_000).toISOString();
    const metadata: RunMetadata = {
      runId: "eval-x-y-12345678901234",
      profileId: "x",
      testId: "y",
      status: "running",
      lastHeartbeatAt: fresh,
      artifactDir: ".runs/eval-x-y-12345678901234",
    };
    expect(
      shouldRemoveOrphan({
        metadata,
        nowMs: NOW_MS,
        freshHeartbeatMs: FRESH_MS,
      }),
    ).toBe(false);
  });
});

describe("removeOrphanedRunResources", () => {
  test("issues docker rm for every container suffix + network rm + volume rm per suffix", async () => {
    const runId = "eval-vellum-bare-x-20260524160000";
    const runner = new ScriptedRunner(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const counts = await removeOrphanedRunResources(runner, runId);

    // Containers: one `docker rm -f` per suffix.
    const rmContainerCalls = runner.calls.filter(
      (c) => c.args[0] === "rm" && c.args[1] === "-f",
    );
    expect(rmContainerCalls).toHaveLength(EVAL_CONTAINER_SUFFIXES.length);
    for (const suffix of EVAL_CONTAINER_SUFFIXES) {
      expect(
        rmContainerCalls.some((c) => c.args[2] === `${runId}${suffix}`),
      ).toBe(true);
    }

    // Network: exactly one `docker network rm`.
    const netCalls = runner.calls.filter(
      (c) => c.args[0] === "network" && c.args[1] === "rm",
    );
    expect(netCalls).toHaveLength(1);
    expect(netCalls[0].args[2]).toBe(`${runId}${EVAL_NETWORK_SUFFIX}`);

    // Volumes: one `docker volume rm` per suffix.
    const volCalls = runner.calls.filter(
      (c) => c.args[0] === "volume" && c.args[1] === "rm",
    );
    expect(volCalls).toHaveLength(EVAL_VOLUME_SUFFIXES.length);
    for (const suffix of EVAL_VOLUME_SUFFIXES) {
      expect(volCalls.some((c) => c.args[2] === `${runId}${suffix}`)).toBe(
        true,
      );
    }

    expect(counts.containers).toBe(EVAL_CONTAINER_SUFFIXES.length);
    expect(counts.networks).toBe(1);
    expect(counts.volumes).toBe(EVAL_VOLUME_SUFFIXES.length);
  });

  test("a missing-container exit (1) does not count as removed but does not throw", async () => {
    const runner = new ScriptedRunner(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: No such container",
    }));
    const counts = await removeOrphanedRunResources(
      runner,
      "eval-x-y-12345678901234",
    );
    expect(counts.containers).toBe(0);
    expect(counts.networks).toBe(0);
    expect(counts.volumes).toBe(0);
  });

  test("a thrown spawn error per resource is swallowed so one failure doesn't block the rest", async () => {
    let calls = 0;
    const runner = new ScriptedRunner(async () => {
      calls += 1;
      // First call (first container) throws; everything after returns
      // success. The function should not propagate the throw and
      // should still tally the successful removals.
      if (calls === 1) throw new Error("simulated spawn failure");
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const counts = await removeOrphanedRunResources(
      runner,
      "eval-x-y-12345678901234",
    );
    // Total resource attempts: containers + 1 network + volumes
    const totalAttempts =
      EVAL_CONTAINER_SUFFIXES.length + 1 + EVAL_VOLUME_SUFFIXES.length;
    expect(calls).toBe(totalAttempts);
    // First container threw → not counted. Remaining containers + net + vols all succeeded.
    expect(counts.containers).toBe(EVAL_CONTAINER_SUFFIXES.length - 1);
    expect(counts.networks).toBe(1);
    expect(counts.volumes).toBe(EVAL_VOLUME_SUFFIXES.length);
  });
});

describe("cleanupOrphanedEvalContainers", () => {
  async function setupRunsDir(
    runs: Array<{ runId: string; metadata?: RunMetadata }>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "orphan-cleanup-test-"));
    for (const { runId, metadata } of runs) {
      const runDir = join(dir, runId);
      await mkdir(runDir, { recursive: true });
      if (metadata) {
        await writeFile(join(runDir, "run.json"), JSON.stringify(metadata));
      }
    }
    return dir;
  }

  test("removes orphaned runs and keeps fresh ones — end-to-end sweep", async () => {
    const NOW_MS = new Date("2026-05-23T14:42:05Z").getTime();
    const fresh = new Date(NOW_MS - 5_000).toISOString();
    const stale = new Date(NOW_MS - 120_000).toISOString();
    const runsDir = await setupRunsDir([
      // 1. Fresh running → keep
      {
        runId: "eval-vellum-fresh-12345678901234",
        metadata: {
          runId: "eval-vellum-fresh-12345678901234",
          profileId: "vellum",
          testId: "fresh",
          status: "running",
          lastHeartbeatAt: fresh,
          artifactDir: "",
        },
      },
      // 2. Stale running → remove
      {
        runId: "eval-vellum-stale-12345678901235",
        metadata: {
          runId: "eval-vellum-stale-12345678901235",
          profileId: "vellum",
          testId: "stale",
          status: "running",
          lastHeartbeatAt: stale,
          artifactDir: "",
        },
      },
      // 3. Terminal → remove
      {
        runId: "eval-vellum-done-12345678901236",
        metadata: {
          runId: "eval-vellum-done-12345678901236",
          profileId: "vellum",
          testId: "done",
          status: "completed",
          artifactDir: "",
        },
      },
      // (4. No metadata at all — directory missing, simulated below)
    ]);
    try {
      // docker ps -a returns 5 eval containers spread across 4 runs
      // (fresh with assistant+jail, stale with assistant+gateway,
      // done with credential-executor, ghost with assistant) plus an
      // unrelated container that must be left alone.
      const dockerNames = [
        "eval-vellum-fresh-12345678901234-assistant",
        "eval-vellum-fresh-12345678901234-assistant-egress-jail",
        "eval-vellum-stale-12345678901235-assistant",
        "eval-vellum-stale-12345678901235-gateway",
        "eval-vellum-done-12345678901236-credential-executor",
        "eval-vellum-ghost-12345678901237-assistant",
        "my-unrelated-app",
      ];
      const runner = new ScriptedRunner(async (command, args) => {
        if (command === "docker" && args[0] === "ps") {
          return {
            exitCode: 0,
            stdout: dockerNames.join("\n") + "\n",
            stderr: "",
          };
        }
        if (
          command === "docker" &&
          (args[0] === "rm" ||
            (args[0] === "network" && args[1] === "rm") ||
            (args[0] === "volume" && args[1] === "rm"))
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected docker call: ${command} ${args.join(" ")}`);
      });

      const report = await cleanupOrphanedEvalContainers({
        runner,
        runsDir,
        now: () => NOW_MS,
      });

      expect(report.skipReason).toBeUndefined();
      // Removed: stale, done, ghost. Kept: fresh.
      expect(report.removedRuns).toBe(3);
      expect(report.keptRuns).toBe(1);
      const removedSet = new Set(report.removedRunIds);
      expect(removedSet.has("eval-vellum-stale-12345678901235")).toBe(true);
      expect(removedSet.has("eval-vellum-done-12345678901236")).toBe(true);
      expect(removedSet.has("eval-vellum-ghost-12345678901237")).toBe(true);
      expect(removedSet.has("eval-vellum-fresh-12345678901234")).toBe(false);
      // Unrelated container never participates.
      const unrelatedCalls = runner.calls.filter((c) =>
        c.args.includes("my-unrelated-app"),
      );
      expect(unrelatedCalls).toHaveLength(0);
      // Per-resource counts reflect the full sweep: 3 removed runs ×
      // (container suffixes + 1 network + volume suffixes).
      expect(report.removedContainers).toBe(3 * EVAL_CONTAINER_SUFFIXES.length);
      expect(report.removedNetworks).toBe(3);
      expect(report.removedVolumes).toBe(3 * EVAL_VOLUME_SUFFIXES.length);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("dedupes runIds across multiple matching container suffixes — reads metadata once per run", async () => {
    // A real run has assistant + gateway + credential-executor + jail
    // — 4 containers, one runId. The cleanup should call
    // `readRunMetadata` (i.e. inspect the runs dir) exactly once and
    // issue the full resource sweep exactly once.
    const NOW_MS = Date.now();
    const stale = new Date(NOW_MS - 120_000).toISOString();
    const runId = "eval-vellum-bare-x-20260524160000";
    const runsDir = await setupRunsDir([
      {
        runId,
        metadata: {
          runId,
          profileId: "vellum-bare",
          testId: "x",
          status: "running",
          lastHeartbeatAt: stale,
          artifactDir: "",
        },
      },
    ]);
    try {
      const runner = new ScriptedRunner(async (command, args) => {
        if (command === "docker" && args[0] === "ps") {
          return {
            exitCode: 0,
            stdout: [
              `${runId}-assistant`,
              `${runId}-assistant-egress-jail`,
              `${runId}-gateway`,
              `${runId}-credential-executor`,
            ].join("\n"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const report = await cleanupOrphanedEvalContainers({
        runner,
        runsDir,
        now: () => NOW_MS,
      });
      expect(report.removedRuns).toBe(1);
      expect(report.removedRunIds).toEqual([runId]);
      // Exactly one full resource sweep (container removals are
      // attempted for every suffix, not just the ones that appeared
      // in `docker ps`).
      const containerRms = runner.calls.filter(
        (c) => c.args[0] === "rm" && c.args[1] === "-f",
      );
      expect(containerRms).toHaveLength(EVAL_CONTAINER_SUFFIXES.length);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("skips with a reason when docker ps fails (binary missing / daemon down)", async () => {
    const runner = new ScriptedRunner(async () => {
      throw new Error("spawn docker ENOENT");
    });
    const report = await cleanupOrphanedEvalContainers({
      runner,
      runsDir: ".runs",
    });
    expect(report.removedRuns).toBe(0);
    expect(report.keptRuns).toBe(0);
    expect(report.skipReason).toContain("ENOENT");
  });

  test("skips with a reason when docker ps exits non-zero", async () => {
    const runner = new ScriptedRunner(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "permission denied while trying to connect to the docker daemon",
    }));
    const report = await cleanupOrphanedEvalContainers({
      runner,
      runsDir: ".runs",
    });
    expect(report.removedRuns).toBe(0);
    expect(report.skipReason).toContain("permission denied");
  });
});
