import { describe, expect, test } from "bun:test";

import {
  classifyOrphanAfterWait,
  decideWorkerSlot,
  resolveWorkerCommand,
  workerKindSignature,
  type WorkerProcessStatus,
} from "../worker-process.js";

const entry = new URL("file:///source/monitoring/worker.ts");

describe("resolveWorkerCommand", () => {
  test("uses the packaged Windows worker executable when present", () => {
    expect(
      resolveWorkerCommand(entry, "monitoring", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => true,
      }),
    ).toEqual(["/runtime/vellum-worker.exe", "monitoring"]);
  });

  test("routes integrity checks through the packaged worker", () => {
    expect(
      resolveWorkerCommand(entry, "db-integrity", {
        platform: "win32",
        execPath: "/runtime/vellum-worker.exe",
        executableExists: () => true,
      }),
    ).toEqual(["/runtime/vellum-worker.exe", "db-integrity"]);
  });

  test("falls back to the source entry outside a packaged runtime", () => {
    expect(
      resolveWorkerCommand(entry, "monitoring", {
        platform: "win32",
        execPath: "/runtime/vellum-daemon.exe",
        executableExists: () => false,
      }),
    ).toEqual(["bun", "--smol", "run", "/source/monitoring/worker.ts"]);
  });
});

describe("workerKindSignature", () => {
  const schedule = new URL(
    "file:////app/runtime/0.11.7/src/schedule/worker.ts",
  );
  const source = {
    platform: "darwin" as const,
    execPath: "/runtime/bun",
    executableExists: () => false,
  };

  test("is the same for a worker of this kind from any install", () => {
    const previous = new URL(
      "file:////app/runtime/0.10.11/src/schedule/worker.ts",
    );
    expect(workerKindSignature(schedule, "schedule", source)).toEqual(
      workerKindSignature(previous, "schedule", source),
    );
  });

  test("distinguishes one worker kind from another", () => {
    const monitoring = new URL(
      "file:////app/runtime/0.11.7/src/monitoring/worker.ts",
    );
    expect(workerKindSignature(schedule, "schedule", source)).not.toEqual(
      workerKindSignature(monitoring, "monitoring", source),
    );
  });

  // The signature only guards against signalling a recycled PID, so it has to
  // be specific enough that an unrelated program running its own worker.ts
  // never matches.
  const matches = (command: string, signature: readonly string[]): boolean =>
    signature.every((part) => command.includes(part));

  test("does not match an unrelated program running some other worker.ts", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect(matches("bun run /home/dev/side-project/worker.ts", signature)).toBe(
      false,
    );
    expect(matches("node /srv/queue/src/jobs/worker.ts", signature)).toBe(
      false,
    );
  });

  test("matches the same worker from a previous install", () => {
    const signature = workerKindSignature(schedule, "schedule", source);
    expect(
      matches(
        "bun --smol run /app/runtime/0.10.11/src/schedule/worker.ts",
        signature,
      ),
    ).toBe(true);
  });

  const packaged = {
    platform: "win32" as const,
    execPath: "/runtime/vellum-daemon.exe",
    executableExists: () => true,
  };

  // Every packaged worker runs one executable and is told apart by the
  // subcommand, so the executable alone must not identify a worker: one
  // worker's slot would otherwise reclaim another's process.
  test("distinguishes packaged worker kinds sharing one executable", () => {
    const scheduleSig = workerKindSignature(schedule, "schedule", packaged);
    expect(matches('"C:/App/vellum-worker.exe" schedule', scheduleSig)).toBe(
      true,
    );
    expect(matches('"C:/App/vellum-worker.exe" monitoring', scheduleSig)).toBe(
      false,
    );
  });

  test("matches a packaged worker from a previous install", () => {
    const scheduleSig = workerKindSignature(schedule, "schedule", packaged);
    expect(matches('"C:/Prev/vellum-worker.exe" schedule', scheduleSig)).toBe(
      true,
    );
  });
});

// Every branch that can reach a kill. `reclaim` is the only decision that
// signals a process, so each test below is really asking: could this input
// have killed something it should not have?
describe("decideWorkerSlot", () => {
  const DAEMON = 900;
  const WORKER = 4242;
  const signature = ["src/schedule/worker.ts"];
  const running = { status: "running" as const, pid: WORKER };
  const ours = `bun --smol run /app/runtime/0.11.7/src/schedule/worker.ts`;
  const previous = `bun --smol run /app/runtime/0.10.11/src/schedule/worker.ts`;
  const alive = () => true;
  const dead = () => false;

  const decide = (
    row: { pid: number; ppid: number; command: string } | null,
    isOwnerAlive = alive,
    pid1OwnsWorkers = false,
    status: WorkerProcessStatus = running,
  ) =>
    decideWorkerSlot(
      status,
      row,
      signature,
      DAEMON,
      isOwnerAlive,
      pid1OwnsWorkers,
    );

  test("spawns when the PID file names nothing running", () => {
    expect(decide(null, alive, false, { status: "not_running" })).toEqual({
      action: "spawn",
    });
  });

  test("adopts this daemon's own worker", () => {
    expect(decide({ pid: WORKER, ppid: DAEMON, command: ours })).toEqual({
      action: "adopt",
      pid: WORKER,
    });
  });

  test("reclaims a worker reparented to init after its daemon died", () => {
    expect(decide({ pid: WORKER, ppid: 1, command: previous })).toEqual({
      action: "reclaim",
      pid: WORKER,
    });
  });

  test("reclaims a worker whose owner is gone", () => {
    expect(decide({ pid: WORKER, ppid: 777, command: previous }, dead)).toEqual(
      {
        action: "reclaim",
        pid: WORKER,
      },
    );
  });

  // `isOwnerAlive` is "is the owner a daemon", not "does that PID exist". These
  // workers have exactly one legitimate owner, so a recycled owner PID must not
  // keep a stranded worker looking owned.
  test("adopts a worker a live daemon owns", () => {
    expect(decide({ pid: WORKER, ppid: 777, command: ours }, alive)).toEqual({
      action: "adopt",
      pid: WORKER,
    });
  });

  test("reclaims a worker whose owner PID was recycled to a non-daemon", () => {
    const ownerIsNotADaemon = () => false;
    expect(
      decide({ pid: WORKER, ppid: 777, command: previous }, ownerIsNotADaemon),
    ).toEqual({ action: "reclaim", pid: WORKER });
  });

  // In a container the daemon is PID 1, so a worker parented to 1 is a live
  // sibling's, not an orphan.
  test("adopts a PID-1 child when PID 1 is the daemon", () => {
    expect(
      decide({ pid: WORKER, ppid: 1, command: ours }, alive, true),
    ).toEqual({ action: "adopt", pid: WORKER });
  });

  // The cases below are the ones that must never reach a kill.
  test("never signals an unrelated process on a recycled PID", () => {
    expect(
      decide({ pid: WORKER, ppid: 1, command: "/usr/bin/postgres -D /data" }),
    ).toEqual({ action: "adopt", pid: WORKER });
  });

  test("never signals another project's worker.ts on a recycled PID", () => {
    expect(
      decide({
        pid: WORKER,
        ppid: 1,
        command: "bun run /home/dev/side-project/worker.ts",
      }),
    ).toEqual({ action: "adopt", pid: WORKER });
  });

  test("never signals a different worker kind holding this slot", () => {
    expect(
      decide({
        pid: WORKER,
        ppid: 1,
        command: "bun --smol run /app/runtime/0.10.11/src/monitoring/worker.ts",
      }),
    ).toEqual({ action: "adopt", pid: WORKER });
  });

  test("never signals when the process table could not be read", () => {
    expect(decide(null)).toEqual({ action: "adopt", pid: WORKER });
  });
});

// Escalation happens after an awaited SIGTERM grace, so the PID alone cannot
// carry identity across it: the orphan may exit mid-wait and the OS may hand
// its PID to a stranger, or the process table may simply fail to answer.
// Only a positive re-match escalates, and only a proven "gone" releases the
// slot; a live PID whose identity cannot be read resolves to reuse, because
// releasing it would spawn a second worker next to a live one.
describe("classifyOrphanAfterWait", () => {
  const signature = ["src/schedule/worker.ts"];
  const ours = "bun --smol run /app/runtime/0.10.11/src/schedule/worker.ts";

  test("dead PID: gone, slot may be released", () => {
    expect(classifyOrphanAfterWait(false, null, signature)).toBe("gone");
    expect(classifyOrphanAfterWait(false, ours, signature)).toBe("gone");
  });

  test("still this worker: escalation proceeds", () => {
    expect(classifyOrphanAfterWait(true, ours, signature)).toBe("orphan");
  });

  test("PID reused by a stranger: orphan exited, never SIGKILL", () => {
    expect(
      classifyOrphanAfterWait(true, "/usr/bin/postgres -D /data", signature),
    ).toBe("gone");
  });

  test("PID reused by a different worker kind: never SIGKILL", () => {
    expect(
      classifyOrphanAfterWait(
        true,
        "bun --smol run /app/runtime/0.10.11/src/monitoring/worker.ts",
        signature,
      ),
    ).toBe("gone");
  });

  // The fail-safe vex pinned: a live PID with an unreadable command line is
  // neither killable nor releasable.
  test("alive but command unreadable: identity-unreadable, reuse the slot", () => {
    expect(classifyOrphanAfterWait(true, null, signature)).toBe(
      "identity-unreadable",
    );
  });
});
