import { describe, expect, test } from "bun:test";

import {
  createWorkerSupervisor,
  type WorkerProcessStatus,
} from "../../util/worker-process.js";

const RUNNING: WorkerProcessStatus = { status: "running", pid: 100 };
const NOT_RUNNING: WorkerProcessStatus = { status: "not_running" };

describe("createWorkerSupervisor", () => {
  test("does not respawn a running worker", async () => {
    let respawns = 0;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => RUNNING,
      respawn: async () => {
        respawns++;
        return { pid: 1, alreadyRunning: false };
      },
    });

    await sup.ensureAlive();

    expect(respawns).toBe(0);
  });

  test("respawns a dead worker and fires onRespawn with the pid", async () => {
    let respawns = 0;
    let respawnedPid: number | undefined;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        respawns++;
        return { pid: 42, alreadyRunning: false };
      },
      onRespawn: (pid) => {
        respawnedPid = pid;
      },
    });

    await sup.ensureAlive();

    expect(respawns).toBe(1);
    expect(respawnedPid).toBe(42);
  });

  test("does not fire onRespawn when the worker was already running", async () => {
    let onRespawnCalls = 0;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => ({ pid: 42, alreadyRunning: true }),
      onRespawn: () => {
        onRespawnCalls++;
      },
    });

    await sup.ensureAlive();

    expect(onRespawnCalls).toBe(0);
  });

  test("backs off after a failed respawn and skips attempts within the window", async () => {
    let respawns = 0;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        respawns++;
        throw new Error("spawn failed");
      },
      minBackoffMs: 1000,
      maxBackoffMs: 10_000,
    });

    await sup.ensureAlive(0); // attempt 1 fails → nextAttemptAt = 1000
    expect(respawns).toBe(1);
    await sup.ensureAlive(500); // within backoff → skipped
    expect(respawns).toBe(1);
    await sup.ensureAlive(1500); // past backoff → attempt 2
    expect(respawns).toBe(2);
  });

  test("fires onPersistentFailure exactly once at the threshold", async () => {
    let persistentCalls = 0;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        throw new Error("nope");
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
      persistentFailureThreshold: 3,
      onPersistentFailure: () => {
        persistentCalls++;
      },
    });

    await sup.ensureAlive(0); // fail 1
    await sup.ensureAlive(10); // fail 2
    await sup.ensureAlive(20); // fail 3 → fires
    await sup.ensureAlive(30); // fail 4 → no additional fire

    expect(persistentCalls).toBe(1);
  });

  test("a later successful respawn resets the failure counters", async () => {
    let mode: "fail" | "ok" = "fail";
    let persistentCalls = 0;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        if (mode === "fail") {
          throw new Error("nope");
        }
        return { pid: 7, alreadyRunning: false };
      },
      minBackoffMs: 1,
      maxBackoffMs: 1,
      persistentFailureThreshold: 2,
      onPersistentFailure: () => {
        persistentCalls++;
      },
    });

    await sup.ensureAlive(0); // fail 1
    mode = "ok";
    await sup.ensureAlive(10); // success → resets counter
    mode = "fail";
    await sup.ensureAlive(20); // fail 1 again (counter was reset)

    expect(persistentCalls).toBe(0);
  });

  test("does not respawn while suppressed (operator stop)", async () => {
    let respawns = 0;
    let suppressed = true;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        respawns++;
        return { pid: 1, alreadyRunning: false };
      },
      isSuppressed: () => suppressed,
    });

    await sup.ensureAlive();
    expect(respawns).toBe(0);

    suppressed = false;
    await sup.ensureAlive();
    expect(respawns).toBe(1);
  });

  test("dispose mid-respawn kills the child that resolves after disposal", async () => {
    let releaseRespawn: () => void = () => {};
    const respawnGate = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    let killedPid: number | undefined;
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        await respawnGate;
        return { pid: 99, alreadyRunning: false };
      },
      killChild: (pid) => {
        killedPid = pid;
      },
    });

    const inflight = sup.ensureAlive(); // starts respawn, awaits the gate
    sup.dispose(); // dispose while the respawn is in flight
    releaseRespawn(); // respawn resolves now
    await inflight;

    expect(killedPid).toBe(99);
  });

  test("concurrent ensureAlive calls do not double-spawn", async () => {
    let respawns = 0;
    let releaseRespawn: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const sup = createWorkerSupervisor({
      label: "t",
      probe: () => NOT_RUNNING,
      respawn: async () => {
        respawns++;
        await gate;
        return { pid: 1, alreadyRunning: false };
      },
    });

    const a = sup.ensureAlive();
    const b = sup.ensureAlive(); // skipped by the inFlight guard
    releaseRespawn();
    await Promise.all([a, b]);

    expect(respawns).toBe(1);
  });
});
