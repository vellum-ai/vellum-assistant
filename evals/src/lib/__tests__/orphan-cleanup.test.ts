import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupOrphanedEvalContainers,
  EVAL_CONTAINER_SUFFIXES,
  inferRunIdFromContainerName,
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

  test("removes orphaned containers and keeps fresh ones — end-to-end sweep", async () => {
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
      // docker ps -a returns 5 containers — fresh, stale, done, ghost
      // (no .runs dir), and an unrelated container that must be left
      // alone.
      const dockerNames = [
        "eval-vellum-fresh-12345678901234-assistant",
        "eval-vellum-fresh-12345678901234-assistant-egress-jail",
        "eval-vellum-stale-12345678901235-assistant",
        "eval-vellum-done-12345678901236-assistant",
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
        if (command === "docker" && args[0] === "rm") {
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
      // Removed: stale, done, ghost. Kept: fresh + its egress jail
      // (both belong to the same fresh runId).
      expect(report.removed).toBe(3);
      expect(report.kept).toBe(2);
      const removedSet = new Set(report.removedNames);
      expect(removedSet.has("eval-vellum-stale-12345678901235-assistant")).toBe(
        true,
      );
      expect(removedSet.has("eval-vellum-done-12345678901236-assistant")).toBe(
        true,
      );
      expect(removedSet.has("eval-vellum-ghost-12345678901237-assistant")).toBe(
        true,
      );
      expect(removedSet.has("eval-vellum-fresh-12345678901234-assistant")).toBe(
        false,
      );
      // Unrelated container is never touched.
      expect(removedSet.has("my-unrelated-app")).toBe(false);
      // Exactly one docker ps + one docker rm per removed container.
      const rmCalls = runner.calls.filter((c) => c.args[0] === "rm");
      expect(rmCalls).toHaveLength(3);
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
    expect(report.removed).toBe(0);
    expect(report.kept).toBe(0);
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
    expect(report.removed).toBe(0);
    expect(report.skipReason).toContain("permission denied");
  });
});
